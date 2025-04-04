// A simple HTTP endpoint that returns WebSocket server info
// This avoids the Edge Runtime issues

const { Server } = require('socket.io');
const WebSocket = require('ws');

// Create an in-memory store for keeping track of active clients
const clients = new Map();

// This is an HTTP endpoint that client will call to get WebSocket server info
module.exports = (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    // The WebSocket server will actually be a separate service
    // For demo, we'll use the fallback approach and just return a message
    return res.status(200).json({
      message: "WebSocket streaming is not available in this deployment. Using fallback batch mode.",
      useStreamingFallback: true
    });
  }
  
  return res.status(405).json({ error: "Method not allowed" });
};