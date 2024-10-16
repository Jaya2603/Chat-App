const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

const app = express();

// Setting up HTTP server and Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL, // Allow requests from the frontend URL
        credentials: true
    }
});

// Online users set, maps userID to an array of socket IDs (to support multiple device logins)
const onlineUsers = new Map();

io.on('connection', async (socket) => {
    console.log("User connected: ", socket.id);

    const token = socket.handshake.auth.token;
    if (!token) {
        console.error("No token provided.");
        return socket.disconnect(); // Disconnect if no token is provided
    }

    // Retrieve current user details from token
    let user;
    try {
        user = await getUserDetailsFromToken(token);
    } catch (error) {
        console.error("Error in getUserDetailsFromToken:", error);
        return socket.disconnect(); // Disconnect if there's an error in retrieving user details
    }

    if (!user || !user._id) {
        console.error("User not authenticated or user ID is missing.");
        return socket.disconnect(); // Disconnect if user is not authenticated or ID is missing
    }

    // Add user to online users and track their socket id
    if (onlineUsers.has(user._id.toString())) {
        // If user already exists, add the new socket ID to their existing array of socket IDs
        onlineUsers.get(user._id.toString()).push(socket.id);
    } else {
        // If user doesn't exist, create a new entry with their socket ID
        onlineUsers.set(user._id.toString(), [socket.id]);
    }

    // Emit the list of online users to all connected clients
    io.emit('onlineUser', Array.from(onlineUsers.keys())); // Sending user IDs of online users

    // Join the user's socket room
    socket.join(user._id.toString());

    // Listen for message page requests
    socket.on('message-page', async (userId) => {
        try {
            const userDetails = await UserModel.findById(userId).select("-password");

            const payload = {
                _id: userDetails._id,
                name: userDetails.name,
                email: userDetails.email,
                profile_pic: userDetails.profile_pic,
                online: onlineUsers.has(userId) // Check if the requested user is online
            };

            socket.emit('message-user', payload);

            // Retrieve previous conversation messages
            const conversation = await ConversationModel.findOne({
                "$or": [
                    { sender: user._id, receiver: userId },
                    { sender: userId, receiver: user._id }
                ]
            }).populate('messages').sort({ updatedAt: -1 });

            socket.emit('message', conversation?.messages || []);
        } catch (error) {
            console.error("Error fetching message page:", error);
        }
    });

    // Listen for new messages
    socket.on('new message', async (data) => {
        try {
            // Check if conversation exists
            let conversation = await ConversationModel.findOne({
                "$or": [
                    { sender: data.sender, receiver: data.receiver },
                    { sender: data.receiver, receiver: data.sender }
                ]
            });

            // Create a new conversation if it doesn't exist
            if (!conversation) {
                conversation = new ConversationModel({
                    sender: data.sender,
                    receiver: data.receiver
                });
                await conversation.save();
            }

            // Create a new message
            const message = new MessageModel({
                text: data.text,
                imageUrl: data.imageUrl,
                videoUrl: data.videoUrl,
                msgByUserId: data.msgByUserId,
            });
            const savedMessage = await message.save();

            // Update the conversation with the new message
            await ConversationModel.updateOne({ _id: conversation._id }, {
                "$push": { messages: savedMessage._id }
            });

            // Retrieve updated conversation messages
            const updatedConversation = await ConversationModel.findOne({
                "$or": [
                    { sender: data.sender, receiver: data.receiver },
                    { sender: data.receiver, receiver: data.sender }
                ]
            }).populate('messages').sort({ updatedAt: -1 });

            // Emit the updated messages to both users
            io.to(data.sender).emit('message', updatedConversation?.messages || []);
            io.to(data.receiver).emit('message', updatedConversation?.messages || []);

            // Send updated conversation to both users
            const conversationSender = await getConversation(data.sender);
            const conversationReceiver = await getConversation(data.receiver);

            io.to(data.sender).emit('conversation', conversationSender);
            io.to(data.receiver).emit('conversation', conversationReceiver);
        } catch (error) {
            console.error("Error sending new message:", error);
        }
    });

    // Sidebar event to retrieve conversations
    socket.on('sidebar', async (currentUserId) => {
        try {
            const conversation = await getConversation(currentUserId);
            socket.emit('conversation', conversation);
        } catch (error) {
            console.error("Error fetching sidebar conversations:", error);
        }
    });

    // Mark messages as seen
    socket.on('seen', async (msgByUserId) => {
        try {
            let conversation = await ConversationModel.findOne({
                "$or": [
                    { sender: user._id, receiver: msgByUserId },
                    { sender: msgByUserId, receiver: user._id }
                ]
            });

            const conversationMessageIds = conversation?.messages || [];

            // Update messages to mark them as seen
            await MessageModel.updateMany(
                { _id: { "$in": conversationMessageIds }, msgByUserId: msgByUserId },
                { "$set": { seen: true } }
            );

            // Send updated conversation to both users
            const conversationSender = await getConversation(user._id.toString());
            const conversationReceiver = await getConversation(msgByUserId);

            io.to(user._id.toString()).emit('conversation', conversationSender);
            io.to(msgByUserId).emit('conversation', conversationReceiver);
        } catch (error) {
            console.error("Error marking messages as seen:", error);
        }
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        // Remove the socket ID from the user's list of sockets
        const socketIds = onlineUsers.get(user._id.toString());
        if (socketIds) {
            const index = socketIds.indexOf(socket.id);
            if (index > -1) {
                socketIds.splice(index, 1); // Remove the socket ID from the array
            }

            // If the user has no more active sockets, remove them from online users
            if (socketIds.length === 0) {
                onlineUsers.delete(user._id.toString());
            }
        }

        // Notify all clients of the updated online users
        io.emit('onlineUser', Array.from(onlineUsers.keys())); // Send updated online users list

        console.log('User disconnected: ', socket.id);
    });
});

// Export the app and server for use in other modules
module.exports = {
    app,
    server
};
