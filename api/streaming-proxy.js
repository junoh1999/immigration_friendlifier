// Serverless function for Vercel using Ably for real-time streaming
const Ably = require('ably');
const fetch = require('node-fetch');
const { Deepgram } = require('@deepgram/sdk');

let ablyClient = null;
let deepgramConnections = {};

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
      
      // If this is the first chunk, initialize a Deepgram connection
      if (isFirstChunk || !deepgramConnections[sessionId]) {
        await initializeDeepgramConnection(sessionId);
      }
      
      // Process the audio data
      if (audioData) {
        const connection = deepgramConnections[sessionId];
        if (connection && connection.deepgramLive) {
          // Convert base64 to binary
          const audioBuffer = Buffer.from(audioData, 'base64');
          
          // Send to Deepgram
          connection.deepgramLive.send(audioBuffer);
        } else {
          console.error('Deepgram connection not available for session:', sessionId);
        }
      }
      
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error processing audio chunk:', error);
      return res.status(500).json({ error: error.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
};

// Initialize a new Deepgram connection for a session
async function initializeDeepgramConnection(sessionId) {
  try {
    // Create a new deepgram instance
    const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
    
    // Create a deepgram live transcription instance
    const deepgramLive = deepgram.transcription.live({
      punctuate: true,
      diarize: true,
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'linear16', // Added for better compatibility
      sample_rate: 16000,    // Common sample rate
      channels: 1,          // Mono audio
      alternatives: 1,
      utterance_end_ms: 1000, // End utterances after 1s of silence
      interim_results: true,
      smart_format: true,
      max_speakers: 2,
      min_speakers: 2
    });
    
    // Get broadcast channel from Ably
    const broadcastChannel = ablyClient.channels.get('transcript-channel');
    
    // Set up event handlers for the Deepgram connection
    deepgramLive.addListener('open', () => {
      console.log(`Deepgram connection established for session ${sessionId}`);
    });
    
    deepgramLive.addListener('transcriptReceived', (transcription) => {
      try {
        const data = JSON.parse(transcription);
        
        if (!data.channel || !data.channel.alternatives || !data.channel.alternatives[0]) {
          return;
        }
        
        const transcript = data.channel.alternatives[0].transcript;
        
        if (transcript && transcript.trim() !== '') {
          // Get words with speaker information
          const words = data.channel.alternatives[0].words || [];
          
          // Group words by speaker
          let formattedSegments = [];
          let currentSegment = null;
          
          // Process each word to group by speaker
          for (const word of words) {
            if (!currentSegment || currentSegment.speaker !== word.speaker) {
              if (currentSegment) {
                formattedSegments.push(currentSegment);
              }
              currentSegment = {
                text: word.word || word.punctuated_word,
                start: word.start,
                end: word.end,
                speaker: word.speaker || 0
              };
            } else {
              // Same speaker, add to current segment
              currentSegment.text += " " + (word.word || word.punctuated_word);
              currentSegment.end = word.end;
            }
          }
          
          // Add the last segment
          if (currentSegment) {
            formattedSegments.push(currentSegment);
          }
          
          // Publish to Ably channel
          broadcastChannel.publish('transcription', {
            sessionId,
            transcript,
            segments: formattedSegments,
            isFinal: data.is_final
          });
          
          // If this is final, process with Groq for insights
          if (data.is_final && transcript.length > 10) {
            processWithGroq(transcript, sessionId, formattedSegments);
          }
        }
      } catch (error) {
        console.error('Error processing transcription:', error);
      }
    });
    
    deepgramLive.addListener('close', () => {
      console.log(`Deepgram connection closed for session ${sessionId}`);
      // Clean up the connection
      delete deepgramConnections[sessionId];
    });
    
    deepgramLive.addListener('error', (error) => {
      console.error(`Deepgram error for session ${sessionId}:`, error);
    });
    
    // Store the connection
    deepgramConnections[sessionId] = {
      deepgramLive,
      lastActivity: Date.now()
    };
    
    // Set up a cleanup timer to remove stale connections
    setTimeout(() => {
      cleanupOldConnections();
    }, 60000); // Check every minute
    
    return deepgramLive;
  } catch (error) {
    console.error('Error initializing Deepgram connection:', error);
    throw error;
  }
}

// Process transcript with Groq for analysis
async function processWithGroq(transcript, sessionId, segments) {
  try {
    if (!transcript || transcript.trim() === '') return;
    
    // Prepare transcript with speakers
    let transcriptWithSpeakers = '';
    segments.forEach(segment => {
      transcriptWithSpeakers += `Speaker ${segment.speaker}: ${segment.text}\n`;
    });
    
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
            content: `Analyze this fragment of an ongoing conversation:\n\n${transcriptWithSpeakers}`
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

// Clean up old Deepgram connections
function cleanupOldConnections() {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  Object.keys(deepgramConnections).forEach(sessionId => {
    const connection = deepgramConnections[sessionId];
    if (now - connection.lastActivity > timeout) {
      console.log(`Cleaning up stale connection for session ${sessionId}`);
      if (connection.deepgramLive) {
        connection.deepgramLive.close();
      }
      delete deepgramConnections[sessionId];
    }
  });
}