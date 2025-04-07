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
          model: "nova-2-phonecall",  // Specialized for phone conversations with speaker separation
          min_speakers: 2,            // Assume at least 2 speakers
          max_speakers: 4,            // Don't go beyond 4 speakers
          encoding: "linear16",
          sample_rate: 16000,
          channels: 1
        });
        
        // Create channels
        const fromClientChannel = ablyClient.channels.get('request-channel');
        const broadcastChannel = ablyClient.channels.get('transcript-channel');
        
        // Set up listeners
// In your streaming-proxy.js, update the transcriptReceived handler

// Update the transcriptReceived handler in streaming-proxy.js

deepgramLive.addListener("transcriptReceived", (transcription) => {
  try {
    const data = JSON.parse(transcription);
    
    // Log the entire transcription data for debugging
    console.log('Deepgram transcription data:', JSON.stringify(data).substring(0, 500) + '...');
    
    if (!data.channel || !data.channel.alternatives || !data.channel.alternatives[0]) {
      console.log('No valid channel data in transcription');
      return;
    }
    
    const transcript = data.channel.alternatives[0].transcript;
    if (!transcript || transcript.trim() === '') {
      console.log('Empty transcript, skipping');
      return;
    }
    
    // Check if words with speaker information are available
    const words = data.channel.alternatives[0].words || [];
    
    if (words.length === 0) {
      console.log('No words data available for transcript:', transcript);
      
      // If no word-level data, just publish the transcript with default speaker
      broadcastChannel.publish('transcription', {
        sessionId: sessionId,
        text: transcript,
        speaker: 0,  // Default speaker
        start: data.start || 0,
        end: data.end || 0
      });
      
      return;
    }
    
    // Check if speaker information is available
    if (!('speaker' in words[0])) {
      console.log('Speaker information not available in words', words[0]);
      
      // Publish without speaker info
      broadcastChannel.publish('transcription', {
        sessionId: sessionId,
        text: transcript,
        speaker: 0,  // Default speaker
        start: data.start || 0,
        end: data.end || 0
      });
      
      return;
    }
    
    // Group words by speaker for better diarization
    let currentSpeaker = words[0].speaker;
    let currentSegment = {
      text: words[0].word,
      speaker: currentSpeaker,
      start: words[0].start,
      end: words[0].end
    };
    
    const segments = [];
    
    // Group consecutive words by the same speaker
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      
      if (word.speaker === currentSpeaker) {
        // Same speaker, add to current segment
        currentSegment.text += ' ' + word.word;
        currentSegment.end = word.end;
      } else {
        // New speaker, save current segment and start a new one
        segments.push({...currentSegment});
        
        currentSpeaker = word.speaker;
        currentSegment = {
          text: word.word,
          speaker: currentSpeaker,
          start: word.start,
          end: word.end
        };
      }
    }
    
    // Add the final segment
    segments.push({...currentSegment});
    
    // Log segments for debugging
    console.log(`Created ${segments.length} segments from ${words.length} words`);
    
    // Publish each segment separately
    segments.forEach(segment => {
      console.log(`Publishing segment for speaker ${segment.speaker}: "${segment.text}"`);
      
      broadcastChannel.publish('transcription', {
        sessionId: sessionId,
        text: segment.text,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end
      });
    });
    
    // Process complete transcript with Groq if it's long enough
    if (transcript.length > 10) {
      // Create a formatted transcript with speaker information for Groq
      const formattedTranscript = segments
        .map(segment => `Speaker ${segment.speaker}: ${segment.text}`)
        .join('\n');
        
      processWithGroq(formattedTranscript, sessionId);
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