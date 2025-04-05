// Serverless function for Vercel using Ably for real-time streaming
const Ably = require('ably');
const fetch = require('node-fetch');

let ablyClient = null;

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
      const { sessionId, audioData } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ error: 'Missing session ID' });
      }
      
      // Process the audio data
      if (audioData) {
        // Extract the actual base64 data (remove the prefix)
        const base64String = audioData.split(',')[1] || audioData;
        
        try {
          // Convert base64 to buffer
          const audioBuffer = Buffer.from(base64String, 'base64');
          
          // Send to Deepgram using their REST API
          const deepgramResponse = await fetch("https://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true", {
            method: "POST",
            headers: {
              "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
              "Content-Type": "audio/webm"
            },
            body: audioBuffer
          });
          
          if (!deepgramResponse.ok) {
            throw new Error(`Deepgram API error: ${deepgramResponse.statusText}`);
          }
          
          const transcriptionData = await deepgramResponse.json();
          
          // Process transcription
          const transcript = transcriptionData.results?.channels[0]?.alternatives[0]?.transcript || "";
          
          // Get words with speaker information
          const words = transcriptionData.results?.channels[0]?.alternatives[0]?.words || [];
          
          // Group words by speaker
          let formattedSegments = processWordsBySegment(words);
          
          // Publish to Ably channel
          if (transcript && transcript.trim() !== '') {
            const transcriptChannel = ablyClient.channels.get('transcript-channel');
            await transcriptChannel.publish('transcription', {
              sessionId,
              transcript,
              segments: formattedSegments
            });
            
            // Process with Groq if there's enough text
            if (transcript.length > 10) {
              await processWithGroq(transcript, sessionId, formattedSegments);
            }
          }
          
          return res.status(200).json({ success: true });
        } catch (error) {
          console.error('Error processing audio chunk:', error);
          return res.status(500).json({ error: error.message });
        }
      }
      
      return res.status(400).json({ error: 'Missing audio data' });
    } catch (error) {
      console.error('Error in POST handler:', error);
      return res.status(500).json({ error: error.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
};

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

// Helper function to process words into speaker segments
function processWordsBySegment(words) {
  const formattedSegments = [];
  let currentSegment = null;
  
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
  
  return formattedSegments;
}