// File: api/streaming-proxy.js
// This will be a Vercel Edge Function to handle WebSocket connections

import { WebSocketHandler } from '@vercel/edge';
import WebSocket from 'ws';

// Initialize the WebSocket handler
export default WebSocketHandler(async (req, socket) => {
  // Authenticate the client if needed
  // You could check for authorization headers here
  
  // Set up connection to Deepgram's streaming API
  const deepgramSocket = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-2-phonecall&diarize=true&punctuate=true&min_speakers=2&max_speakers=2&encoding=linear16&sample_rate=16000', {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });
  
  // When Deepgram connection is established
  deepgramSocket.on('open', () => {
    console.log('Connected to Deepgram WebSocket');
    
    // Tell the client we're ready
    socket.send(JSON.stringify({ 
      type: 'connected', 
      message: 'Connected to transcription service' 
    }));
  });
  
  // Handle messages from Deepgram
  deepgramSocket.on('message', (data) => {
    try {
      const response = JSON.parse(data);
      
      // Forward the transcription data to the client
      socket.send(JSON.stringify({
        type: 'transcription',
        data: response
      }));
      
      // If this is the final result, also process with Groq for analysis
      if (response.is_final && response.channel && response.channel.alternatives && 
          response.channel.alternatives[0] && response.channel.alternatives[0].transcript) {
        
        processWithGroq(response.channel.alternatives[0], socket);
      }
    } catch (error) {
      console.error('Error processing Deepgram message:', error);
    }
  });
  
  // Handle messages from the client
  socket.on('message', (message) => {
    try {
      // Check if it's a text message (like a command)
      if (typeof message === 'string') {
        const data = JSON.parse(message);
        
        if (data.type === 'close') {
          // Client wants to close connection
          deepgramSocket.close();
        }
      } else {
        // It's an audio chunk, forward it to Deepgram
        if (deepgramSocket.readyState === WebSocket.OPEN) {
          deepgramSocket.send(message);
        }
      }
    } catch (error) {
      console.error('Error processing client message:', error);
    }
  });
  
  // Handle client disconnection
  socket.on('close', () => {
    console.log('Client disconnected');
    // Close the Deepgram connection
    if (deepgramSocket.readyState === WebSocket.OPEN) {
      deepgramSocket.close();
    }
  });
  
  // Handle errors
  socket.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
  
  deepgramSocket.on('error', (error) => {
    console.error('Deepgram WebSocket error:', error);
    socket.send(JSON.stringify({
      type: 'error',
      message: 'Transcription service error'
    }));
  });
});

// Process transcription with Groq for analysis
async function processWithGroq(transcriptionData, socket) {
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
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
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
      
      // Send the analysis to the client
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