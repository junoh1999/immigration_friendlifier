// Serverless function that runs on Vercel
// Handles Deepgram transcription and Groq LLM processing

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Get API keys from environment variables
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!deepgramApiKey || !groqApiKey) {
    return res.status(500).json({ 
      error: "Server configuration error: Missing API key(s)" 
    });
  }

  try {
    if (req.method === "POST") {
      // Check if we're handling a transcription request
      if (req.query.type === "transcribe") {
        const { audioData } = req.body;
        
        if (!audioData) {
          return res.status(400).json({ error: "Missing audio data" });
        }

        // Extract the base64 data part (remove the prefix like "data:audio/webm;base64,")
        const base64Data = audioData.split(",")[1];
        const audioBuffer = Buffer.from(base64Data, "base64");

        // Log audio info for debugging
        console.log(`Audio data received: ${audioBuffer.length} bytes`);

        // Use the phonecall model specifically which might handle diarization better
        // Also use newer diarization version and force 2 speakers
        const deepgramResponse = await fetch("https://api.deepgram.com/v1/listen?smart_format=true&diarize=true&punctuate=true&model=nova-2-phonecall&min_speakers=2&max_speakers=2&diarize_version=latest", {
          method: "POST",
          headers: {
            "Authorization": `Token ${deepgramApiKey}`,
            "Content-Type": "audio/webm"
          },
          body: audioBuffer
        });

        if (!deepgramResponse.ok) {
          const errorData = await deepgramResponse.text();
          console.error("Deepgram API error:", errorData);
          return res.status(deepgramResponse.status).json({ 
            error: "Transcription failed", 
            details: errorData 
          });
        }

        // Get the transcription results
        const transcriptionData = await deepgramResponse.json();
        
        // Log the full response for debugging
        console.log("Deepgram response:", JSON.stringify(transcriptionData, null, 2));
        
        // Get the transcript
        const transcript = transcriptionData.results?.channels[0]?.alternatives[0]?.transcript || "";
        
        // Get the words with speaker information
        const words = transcriptionData.results?.channels[0]?.alternatives[0]?.words || [];
        
        // If all words are assigned to speaker 0, we'll implement our own basic diarization
        // based on pauses and content
        let useFallbackDiarization = true;
        
        // Check if Deepgram actually assigned different speakers
        for (const word of words) {
          if (word.speaker !== 0) {
            useFallbackDiarization = false;
            break;
          }
        }
        
        let formattedSegments = [];
        
        if (useFallbackDiarization && words.length > 0) {
          console.log("Using fallback diarization based on pauses");
          
          // Find significant pauses (more than 1 second) to detect speaker changes
          let currentSegment = { 
            text: words[0].word, 
            start: words[0].start, 
            end: words[0].end, 
            speaker: 0 
          };
          
          let alternatingSegments = [currentSegment];
          let currentSpeaker = 0;
          
          // Start from the second word
          for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const prevWord = words[i-1];
            const timeDiff = word.start - prevWord.end;
            
            // If there's a significant pause, we might have a speaker change
            if (timeDiff > 0.8) {  // Using 0.8 seconds as a threshold for speaker change
              currentSpeaker = 1 - currentSpeaker;  // Toggle between 0 and 1
              
              // Start a new segment
              currentSegment = {
                text: word.word,
                start: word.start,
                end: word.end,
                speaker: currentSpeaker
              };
              
              alternatingSegments.push(currentSegment);
            } else {
              // Continue with the current segment
              currentSegment.text += " " + word.word;
              currentSegment.end = word.end;
            }
          }
          
          formattedSegments = alternatingSegments;
        } else {
          // Use Deepgram's diarization
          // Group words by speaker into cohesive segments
          let currentSegment = { text: "", start: 0, end: 0, speaker: -1 };
          
          // Process each word
          words.forEach(word => {
            // If this is the first word or the speaker has changed
            if (currentSegment.speaker === -1 || currentSegment.speaker !== word.speaker) {
              // If we already have content in the current segment, push it to the array
              if (currentSegment.speaker !== -1) {
                formattedSegments.push(currentSegment);
              }
              
              // Start a new segment
              currentSegment = {
                text: word.word,
                start: word.start,
                end: word.end,
                speaker: word.speaker
              };
            } else {
              // Same speaker, append to current segment
              currentSegment.text += " " + word.word;
              currentSegment.end = word.end;
            }
          });
          
          // Add the last segment if there is one
          if (currentSegment.speaker !== -1) {
            formattedSegments.push(currentSegment);
          }
        }
        
        // Log the segments for debugging
        console.log("Formatted segments:", JSON.stringify(formattedSegments, null, 2));

        // Process with Groq LLM if there's transcription text
        let llmResponse = null;
        if (transcript.trim()) {
          try {
            // Create a more structured prompt that includes the speaker information
            let transcriptWithSpeakers = "";
            formattedSegments.forEach(segment => {
              transcriptWithSpeakers += `Speaker ${segment.speaker}: ${segment.text}\n`;
            });

            const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${groqApiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "llama3-8b-8192", // Using Llama 3 8B model
                messages: [
                  {
                    role: "system",
                    content: "You are an AI assistant that summarizes and analyses spoken text. Extract key points, identify topics, and provide insights from conversations between multiple speakers."
                  },
                  {
                    role: "user",
                    content: `Analyze the following transcription of a conversation with multiple speakers:\n\n${transcriptWithSpeakers}`
                  }
                ],
                temperature: 0.7,
                max_tokens: 500
              })
            });

            if (groqResponse.ok) {
              const groqData = await groqResponse.json();
              llmResponse = groqData.choices?.[0]?.message?.content || null;
            } else {
              console.error("Groq API error:", await groqResponse.text());
            }
          } catch (groqError) {
            console.error("Error processing with LLM:", groqError);
          }
        }

        // Return the complete data
        return res.status(200).json({
          status: "succeeded",
          output: {
            transcript,
            segments: formattedSegments,
            llmAnalysis: llmResponse
          }
        });
      }
      
      // If the request type is not specified or not recognized
      return res.status(400).json({ error: "Invalid request type" });
    }
    
    // If method is not POST
    return res.status(405).json({ error: "Method not allowed" });
    
  } catch (error) {
    console.error("Error in proxy function:", error);
    return res.status(500).json({ 
      error: "Internal Server Error", 
      details: error.message 
    });
  }
};