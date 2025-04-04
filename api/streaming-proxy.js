// api/streaming-proxy.js
// Using Ably for real-time communication with Socket.IO

const Ably = require('ably');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Handle GET request - this provides the Ably token to the client
  if (req.method === "GET") {
    try {
      // Initialize Ably with your API key
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      
      // Create a token request
      const tokenRequest = await new Promise((resolve, reject) => {
        ably.auth.createTokenRequest({ clientId: 'deepgram-client' }, (err, tokenRequest) => {
          if (err) {
            reject(err);
          } else {
            resolve(tokenRequest);
          }
        });
      });
      
      // Return the token request to the client
      return res.status(200).json(tokenRequest);
    } catch (error) {
      console.error('Error creating Ably token:', error);
      return res.status(500).json({ error: 'Failed to create Ably token' });
    }
  }

  // Handle POST request - this processes audio chunks
  if (req.method === "POST") {
    try {
      const { audioChunk, sessionId } = req.body;
      
      if (!audioChunk || !sessionId) {
        return res.status(400).json({ error: 'Missing audio chunk or session ID' });
      }
      
      // Initialize Ably
      const ably = new Ably.Rest(process.env.ABLY_API_KEY);
      const channel = ably.channels.get('deepgram-channel');
      
      // Forward the audio chunk to Deepgram's API
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
      
      // If this is the first chunk, open a new streaming session with Deepgram
      if (req.body.isFirstChunk) {
        // Setup Deepgram connection - this would normally be WebSocket
        // For demo purposes, we'll make a regular HTTP request
        const deepgramResponse = await fetch("https://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&min_speakers=2&max_speakers=2", {
          method: "POST",
          headers: {
            "Authorization": `Token ${deepgramApiKey}`,
            "Content-Type": "audio/webm"
          },
          body: Buffer.from(audioChunk, 'base64')
        });
        
        if (!deepgramResponse.ok) {
          throw new Error(`Deepgram API error: ${deepgramResponse.statusText}`);
        }
        
        const transcriptionData = await deepgramResponse.json();
        
        // Publish the transcription result to the Ably channel
        await channel.publish('transcription', {
          sessionId,
          result: transcriptionData
        });
        
        return res.status(200).json({ success: true });
      } else {
        // For subsequent chunks, we'd append to the existing session
        // For this demo, we'll just process each chunk independently
        const deepgramResponse = await fetch("https://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&min_speakers=2&max_speakers=2", {
          method: "POST", 
          headers: {
            "Authorization": `Token ${deepgramApiKey}`,
            "Content-Type": "audio/webm"
          },
          body: Buffer.from(audioChunk, 'base64')
        });
        
        if (!deepgramResponse.ok) {
          throw new Error(`Deepgram API error: ${deepgramResponse.statusText}`);
        }
        
        const transcriptionData = await deepgramResponse.json();
        
        // Process with Groq if there's enough text
        if (transcriptionData.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
          const transcript = transcriptionData.results.channels[0].alternatives[0].transcript;
          if (transcript.trim().length > 10) {
            await processWithGroq(transcriptionData.results.channels[0].alternatives[0], sessionId, channel);
          }
        }
        
        // Publish the transcription result to the Ably channel
        await channel.publish('transcription', {
          sessionId,
          result: transcriptionData
        });
        
        return res.status(200).json({ success: true });
      }
    } catch (error) {
      console.error('Error processing audio chunk:', error);
      return res.status(500).json({ error: error.message });
    }
  }
  
  return res.status(405).json({ error: "Method not allowed" });
};

// Process transcription with Groq for analysis
async function processWithGroq(transcriptionData, sessionId, ablyChannel) {
  try {
    const transcript = transcriptionData.transcript;
    if (!transcript || transcript.trim() === '') return;
    
    // Create formatted segments from the words
    const words = transcriptionData.words || [];
    const formattedSegments = [];
    let currentSegment = { text: '', start: 0, end: 0, speaker: -1 };
    
    words.forEach(word => {
      if (currentSegment.speaker === -1 || currentSegment.speaker !== word.speaker) {
        if (currentSegment.speaker !== -1) {
          formattedSegments.push(currentSegment);
        }
        
        currentSegment = {
          text: word.word,
          start: word.start,
          end: word.end,
          speaker: word.speaker
        };
      } else {
        currentSegment.text += ' ' + word.word;
        currentSegment.end = word.end;
      }
    });
    
    if (currentSegment.speaker !== -1) {
      formattedSegments.push(currentSegment);
    }
    
    // Prepare the transcript with speakers
    let transcriptWithSpeakers = '';
    formattedSegments.forEach(segment => {
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
      
      // Publish the analysis to the Ably channel
      await ablyChannel.publish('analysis', {
        sessionId,
        transcript,
        segments: formattedSegments,
        analysis
      });
    }
  } catch (error) {
    console.error('Error processing with Groq:', error);
  }
}