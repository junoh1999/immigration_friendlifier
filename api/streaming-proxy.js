// streaming-proxy.js for Vercel Edge Functions

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // Make sure this is a WebSocket request
  if (request.headers.get('upgrade') !== 'websocket') {
    return new Response('Expected WebSocket connection', { status: 400 });
  }

  try {
    // Create WebSocket connection
    const { socket, response } = Deno.upgradeWebSocket(request);
    
    // Keep track of the Deepgram connection
    let deepgramWs = null;
    
    // When client connects
    socket.onopen = async () => {
      console.log('Client connected');
      
      // Connect to Deepgram streaming API
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
      deepgramWs = new WebSocket(
        'wss://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&min_speakers=2&max_speakers=2'
      );
      
      // Set Deepgram auth header
      deepgramWs.onopen = () => {
        deepgramWs.send(JSON.stringify({
          type: 'ConnectionToken',
          token: deepgramApiKey
        }));
        
        // Notify client we're connected
        socket.send(JSON.stringify({
          type: 'connected',
          message: 'Connected to transcription service'
        }));
      };
      
      // Handle Deepgram messages
      deepgramWs.onmessage = async (event) => {
        try {
          // Forward Deepgram responses to client
          const data = JSON.parse(event.data);
          
          // Send transcription data to client
          socket.send(JSON.stringify({
            type: 'transcription',
            data: data
          }));
          
          // If this is a final transcription, process with Groq
          if (data.is_final && data.channel && 
              data.channel.alternatives && data.channel.alternatives[0]) {
            
            await processWithGroq(data.channel.alternatives[0], socket);
          }
        } catch (error) {
          console.error('Error processing Deepgram message:', error);
        }
      };
      
      // Handle Deepgram errors
      deepgramWs.onerror = (error) => {
        console.error('Deepgram WebSocket error:', error);
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Transcription service error'
        }));
      };
      
      // Handle Deepgram disconnection
      deepgramWs.onclose = () => {
        console.log('Disconnected from Deepgram');
      };
    };
    
    // When client sends data
    socket.onmessage = (event) => {
      try {
        // Check if it's a text message (control message)
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          
          if (data.type === 'close') {
            // Client wants to close connection
            if (deepgramWs) deepgramWs.close();
          }
        } else {
          // It's an audio chunk, forward to Deepgram
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(event.data);
          }
        }
      } catch (error) {
        console.error('Error processing client message:', error);
      }
    };
    
    // When client disconnects
    socket.onclose = () => {
      console.log('Client disconnected');
      if (deepgramWs) deepgramWs.close();
    };
    
    // Handle client errors
    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    return response;
  } catch (error) {
    console.error('Error handling WebSocket connection:', error);
    return new Response('Error handling WebSocket connection', { status: 500 });
  }
}

// Process transcription with Groq
async function processWithGroq(transcriptionData, socket) {
  try {
    const transcript = transcriptionData.transcript;
    if (!transcript || transcript.trim() === '') return;
    
    // Create formatted segments from words
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
    
    // Prepare transcript with speakers
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
      
      // Send analysis to client
      socket.send(JSON.stringify({
        type: 'analysis',
        data: {
          transcript,
          segments: formattedSegments,
          analysis
        }
      }));
    }
  } catch (error) {
    console.error('Error processing with Groq:', error);
  }
}