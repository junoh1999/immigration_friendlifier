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
        key: process.env.VITE_ABLY_API_KEY,
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
        const deepgram = new Deepgram(process.env.VITE_DEEPGRAM_API_KEY);
        
        const deepgramLive = deepgram.transcription.live({
          punctuate: true,
          smart_format: true,
          diarize: true,
          min_speakers: 2,
          max_speakers: 6,
          encoding: "linear16", // Use standard PCM format
          sample_rate: 16000,
          channels: 1
        });
        
        // Create channels
        const fromClientChannel = ablyClient.channels.get('request-channel');
        const broadcastChannel = ablyClient.channels.get('transcript-channel');
        const analysisChannel = ablyClient.channels.get('analysis-channel');
        
        // Set up listeners
        deepgramLive.addListener("transcriptReceived", (transcription) => {
          try {
            const data = JSON.parse(transcription);
            if (data.channel == null) return;
            
            const transcript = data.channel.alternatives[0].transcript;
            if (!transcript || transcript.trim() === '') return;
            
            // Extract speaker information from words (if available)
            let speakerId = 0;
            if (data.channel.alternatives[0].words && 
                data.channel.alternatives[0].words.length > 0) {
              speakerId = data.channel.alternatives[0].words[0].speaker;
            }
            
            // Send transcript with speaker info
            broadcastChannel.publish('transcription', {
              sessionId: sessionId,
              text: transcript,
              speaker: speakerId,
              start: data.start,
              end: data.end
            });
            
            // If significant transcript, also process with Groq
            if (transcript.length > 10) {
              processWithGroq(transcript, sessionId, analysisChannel);
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
        try {
          const base64String = audioData.split(',')[1] || audioData;
          const audioBuffer = Buffer.from(base64String, 'base64');
          
          if (deepgramSessions[sessionId].deepgramLive.getReadyState() === 1) {
            deepgramSessions[sessionId].deepgramLive.send(audioBuffer);
            deepgramSessions[sessionId].lastActivity = Date.now();
          } else {
            console.log('Deepgram not ready, buffering data');
            // Could implement a queue here if needed
          }
        } catch (audioError) {
          console.error('Error processing audio data:', audioError);
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
async function processWithGroq(transcript, sessionId, analysisChannel) {
  try {
    if (!transcript || transcript.trim() === '') return;
    
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      console.warn('GROQ_API_KEY not found. Skipping analysis.');
      return;
    }
    
    // Call Groq for analysis
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
      if (analysis) {
        await analysisChannel.publish('analysis', {
          sessionId,
          analysis
        });
        console.log('Analysis published to Ably');
      }
    } else {
      console.error('Groq API error:', await groqResponse.text());
    }
  } catch (error) {
    console.error('Error processing with Groq:', error);
  }
}