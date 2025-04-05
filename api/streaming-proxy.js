// Serverless function for Vercel using Ably for real-time streaming
const Ably = require('ably');
const { Deepgram } = require('@deepgram/sdk');

let ablyClient = null;
let deepgramSessions = {};

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Initialize Ably client if not already done
  if (!ablyClient) {
    try {
      ablyClient = new Ably.Realtime({
        key: process.env.ABLY_API_KEY,
        clientId: 'server'
      });
      console.log('Ably client initialized');
    } catch (error) {
      console.error('Error initializing Ably:', error);
      return res.status(500).json({ error: 'Ably initialization failed' });
    }
  }

  // GET request - client requesting Ably token
  if (req.method === "GET") {
    try {
      // Create an Ably token for the client
      const tokenParams = { clientId: `client-${Date.now()}` };
      ablyClient.auth.createTokenRequest(tokenParams, (err, tokenRequest) => {
        if (err) {
          console.error('Error creating Ably token:', err);
          return res.status(500).json({ error: 'Token creation failed' });
        }
        
        return res.status(200).json({ 
          tokenRequest,
          status: 'success',
          message: 'Streaming is available'
        });
      });
    } catch (error) {
      console.error('Error in GET handler:', error);
      return res.status(500).json({ error: error.message });
    }
  } 
  // POST request - handling audio chunks
  else if (req.method === "POST") {
    try {
      const { sessionId, audioData, isFirstChunk } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ error: 'Missing session ID' });
      }
      
      // If first chunk or session doesn't exist, create a new Deepgram session
      if (isFirstChunk || !deepgramSessions[sessionId]) {
        // Initialize Deepgram
        const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
        
        const deepgramLive = deepgram.transcription.live({
          punctuate: true,
          smart_format: true,
          diarize: true,
          min_speakers: 2,
          max_speakers: 6,
          encoding: "linear16",
          sample_rate: 16000,
          channels: 1
        });
        
        // Create channels
        const fromClientChannel = ablyClient.channels.get('request-channel');
        const broadcastChannel = ablyClient.channels.get('transcript-channel');
        
        // Set up listeners
// In your streaming-proxy.js, update the transcriptReceived handler

deepgramLive.addListener("transcriptReceived", (transcription) => {
  try {
    const data = JSON.parse(transcription);
    if (data.channel == null) return;
    
    const transcript = data.channel.alternatives[0].transcript;
    if (!transcript || transcript.trim() === '') return;
    
    // Extract speaker information if available
    let speakerId = 0;
    const words = data.channel.alternatives[0].words || [];
    
    if (words.length > 0 && 'speaker' in words[0]) {
      speakerId = words[0].speaker;
      
      // Log speaker info for debugging
      console.log(`Speaker ID detected: ${speakerId} for text: "${transcript.substring(0, 30)}..."`);
    }
    
    // Publish with speaker information 
    broadcastChannel.publish('transcription', {
      sessionId: sessionId,
      text: transcript,
      speaker: speakerId,
      start: data.start || 0,
      end: data.end || 0
    });
    
    console.log(`Published transcript with speaker ${speakerId}: "${transcript}"`);
    
    if (transcript.length > 10) {
      processWithGroq(transcript, sessionId);
    }
  } catch (error) {
    console.error('Error processing transcript:', error);
  }
});
        
        deepgramLive.addListener("error", (err) => {
          console.error('Deepgram error:', err);
        });
        
        deepgramLive.addListener("close", () => {
          console.log(`Deepgram connection closed for session ${sessionId}`);
          delete deepgramSessions[sessionId];
        });
        
        // Store the session
        deepgramSessions[sessionId] = {
          deepgramLive,
          lastActivity: Date.now()
        };
      }
      
      // Send audio chunk to Deepgram
      if (audioData && deepgramSessions[sessionId]) {
        const base64String = audioData.split(',')[1] || audioData;
        const audioBuffer = Buffer.from(base64String, 'base64');
        
        if (deepgramSessions[sessionId].deepgramLive.getReadyState() === 1) {
          deepgramSessions[sessionId].deepgramLive.send(audioBuffer);
          deepgramSessions[sessionId].lastActivity = Date.now();
        }
      }
      
      return res.status(200).json({ success: true });
      
    } catch (error) {
      console.error('Error in POST handler:', error);
      return res.status(500).json({ error: error.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
};

// Process transcript with Groq for analysis
async function processWithGroq(transcript, sessionId) {
  try {
    if (!transcript || transcript.trim() === '') return;
    
    // Call Groq for analysis
    const groqApiKey = process.env.GROQ_API_KEY;
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [
          {
            role: 'system',
            content: 'You are an AI assistant that summarizes and analyses spoken text in real-time. Extract key points, identify topics, and provide insights from conversations between multiple speakers. Keep your analysis concise and focused on the most recent statements.'
          },
          {
            role: 'user',
            content: `Analyze this fragment of an ongoing conversation:\n\n${transcript}`
          }
        ],
        temperature: 0.7,
        max_tokens: 250
      })
    });
    
    if (groqResponse.ok) {
      const groqData = await groqResponse.json();
      const analysis = groqData.choices?.[0]?.message?.content || null;
      
      // Publish analysis to Ably
      const analysisChannel = ablyClient.channels.get('analysis-channel');
      await analysisChannel.publish('analysis', {
        sessionId,
        analysis
      });
    }
  } catch (error) {
    console.error('Error processing with Groq:', error);
  }
}