// DOM Elements
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const transcriptionEl = document.getElementById('transcription');
const analysisEl = document.getElementById('analysis');

// Global variables
let mediaRecorder;
let audioContext;
let recordingStartTime;
let timerInterval;
let webSocket;
let isRecording = false;
let streamingEnabled = true; // Set to false if you want to disable streaming and use the batch API

// Check for browser support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.log('Browser does not support audio recording');
    statusEl.textContent = 'Audio recording not supported in this browser';
    recordBtn.disabled = true;
}

// Event listeners
recordBtn.addEventListener('click', function() {
    console.log('Record button clicked');
    startRecording();
});

stopBtn.addEventListener('click', function() {
    console.log('Stop button clicked');
    stopRecording();
});

// Functions
async function startRecording() {
    console.log('Starting recording...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });
        console.log('Got audio stream:', stream);
        
        // Clear previous transcriptions
        transcriptionEl.innerHTML = '';
        if (analysisEl) analysisEl.innerHTML = '';
        
        if (streamingEnabled) {
            // Set up for streaming transcription
            await setupAudioProcessing(stream);
        } else {
            // Set up for batch processing (original approach)
            setupMediaRecorder(stream);
        }
        
        recordingStartTime = Date.now();
        startTimer();
        
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        statusEl.textContent = 'Recording...';
        recordBtn.classList.add('recording');
        isRecording = true;
        
    } catch (error) {
        console.error('Error starting recording:', error);
        statusEl.textContent = 'Error starting recording: ' + error.message;
    }
}

function stopRecording() {
    console.log('Stopping recording...');
    isRecording = false;
    
    if (streamingEnabled) {
        // Close WebSocket connection
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({ type: 'close' }));
            webSocket.close();
        }
        
        // Stop AudioContext
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close();
        }
    } else {
        // Stop MediaRecorder (batch approach)
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
    }
    
    clearInterval(timerInterval);
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    statusEl.textContent = 'Recording stopped.';
    recordBtn.classList.remove('recording');
}

// Set up streaming audio processing with WebSockets
async function setupAudioProcessing(stream) {
    // Create WebSocket connection to our Edge Function
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/api/streaming-proxy`;
    
    webSocket = new WebSocket(wsUrl);
    
    webSocket.onopen = () => {
        console.log('WebSocket connection established');
        statusEl.textContent = 'Connected to transcription service...';
    };
    
    webSocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
            case 'connected':
                console.log('Received connection confirmation:', message.message);
                break;
                
            case 'transcription':
                handleTranscriptionUpdate(message.data);
                break;
                
            case 'analysis':
                displayAnalysis(message.data.analysis);
                updateTranscription(message.data.segments);
                break;
                
            case 'error':
                console.error('Received error from server:', message.message);
                statusEl.textContent = 'Error: ' + message.message;
                break;
        }
    };
    
    webSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        statusEl.textContent = 'Connection error. Try again.';
    };
    
    webSocket.onclose = () => {
        console.log('WebSocket connection closed');
        if (isRecording) {
            statusEl.textContent = 'Connection closed. Stopping recording.';
            stopRecording();
        }
    };
    
    // Set up audio processing
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000  // Set to match what Deepgram expects
    });
    
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    
    // When audio data is available, send it to the WebSocket
    processor.onaudioprocess = (e) => {
        if (isRecording && webSocket && webSocket.readyState === WebSocket.OPEN) {
            // Get the audio data
            const inputData = e.inputBuffer.getChannelData(0);
            
            // Convert float32 to int16
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.min(1, Math.max(-1, inputData[i])) * 0x7FFF;
            }
            
            // Send the audio data to the server
            webSocket.send(pcmData.buffer);
        }
    };
    
    // Connect the nodes
    source.connect(processor);
    processor.connect(audioContext.destination);
}

// Handle regular MediaRecorder setup (for batch processing)
function setupMediaRecorder(stream) {
    mediaRecorder = new MediaRecorder(stream);
    console.log('MediaRecorder created, state:', mediaRecorder.state);
    
    let audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
        console.log('Data available event, size:', event.data.size);
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };
    
    mediaRecorder.onstop = () => {
        console.log('MediaRecorder stopped');
        // Most browsers record as audio/webm or audio/ogg
        const audioBlob = new Blob(audioChunks);
        console.log('Recording stopped. Audio type:', audioBlob.type, 'Size:', audioBlob.size);
        
        // Convert to base64 and send for transcription
        sendForBatchTranscription(audioBlob);
        
        // Stop all tracks in the stream to release the microphone
        stream.getTracks().forEach(track => track.stop());
    };
    
    mediaRecorder.start();
    console.log('MediaRecorder started, state:', mediaRecorder.state);
}

// Send audio for batch transcription (original flow)
async function sendForBatchTranscription(audioBlob) {
    if (!audioBlob) {
        console.log('No audio blob available');
        statusEl.textContent = 'No recording available';
        return;
    }
    
    statusEl.textContent = 'Uploading and transcribing...';
    
    try {
        // Convert blob to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        
        reader.onloadend = async () => {
            const base64Audio = reader.result;
            
            // Send to our proxy API endpoint
            const response = await fetch('/api/proxy?type=transcribe', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    audioData: base64Audio
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API Error: ${JSON.stringify(errorData)}`);
            }
            
            const responseData = await response.json();
            
            if (responseData.status === 'succeeded') {
                displayTranscription(responseData.output.segments);
                displayAnalysis(responseData.output.llmAnalysis);
                statusEl.textContent = 'Transcription and analysis complete!';
            } else {
                console.error('Transcription failed:', responseData.error);
                statusEl.textContent = 'Transcription failed: ' + (responseData.error || 'Unknown error');
            }
        };
    } catch (error) {
        console.error('Error transcribing audio:', error);
        statusEl.textContent = 'Error: ' + error.message;
    }
}

// Handle real-time transcription updates
function handleTranscriptionUpdate(data) {
    if (!data || !data.channel || !data.channel.alternatives || !data.channel.alternatives[0]) {
        return;
    }
    
    const alternative = data.channel.alternatives[0];
    
    if (alternative.transcript && alternative.transcript.trim() !== '') {
        // Update status to show we're receiving transcription
        statusEl.textContent = 'Transcribing...';
        
        // If this is a final result, add it to the transcript display
        if (data.is_final) {
            // Process the words to get speaker information
            const words = alternative.words || [];
            
            if (words.length > 0) {
                // Group words by speaker
                let segments = [];
                let currentSegment = {
                    text: words[0].word,
                    start: words[0].start,
                    end: words[0].end,
                    speaker: words[0].speaker || 0
                };
                
                for (let i = 1; i < words.length; i++) {
                    const word = words[i];
                    if (word.speaker === currentSegment.speaker) {
                        // Same speaker, add to current segment
                        currentSegment.text += " " + word.word;
                        currentSegment.end = word.end;
                    } else {
                        // New speaker, start a new segment
                        segments.push(currentSegment);
                        currentSegment = {
                            text: word.word,
                            start: word.start,
                            end: word.end,
                            speaker: word.speaker || 0
                        };
                    }
                }
                
                // Add the last segment
                segments.push(currentSegment);
                
                // Update the display
                updateTranscription(segments);
            }
        } else {
            // For non-final results, we could show them in a different area or style
            // This is optional and can be customized based on your UI needs
        }
    }
}

// Update the transcription display with new segments
function updateTranscription(segments) {
    if (!segments || segments.length === 0) return;
    
    // Clear existing content if this is the first update
    if (!transcriptionEl.hasChildNodes()) {
        transcriptionEl.innerHTML = '';
    }
    
    // Process each segment
    segments.forEach(segment => {
        // Check if we already have this segment (by time range)
        const existingSegments = Array.from(transcriptionEl.querySelectorAll('.segment'));
        const segmentExists = existingSegments.some(el => {
            const start = parseFloat(el.dataset.start);
            const end = parseFloat(el.dataset.end);
            return Math.abs(start - segment.start) < 0.1 && Math.abs(end - segment.end) < 0.1;
        });
        
        if (!segmentExists) {
            const segmentDiv = document.createElement('div');
            const speakerId = segment.speaker;
            segmentDiv.className = `segment speaker-${speakerId % 2}`;
            segmentDiv.dataset.start = segment.start;
            segmentDiv.dataset.end = segment.end;
            
            const timeStr = formatTime(segment.start) + ' - ' + formatTime(segment.end);
            const headerDiv = document.createElement('div');
            headerDiv.className = 'segment-header';
            headerDiv.textContent = `Speaker ${speakerId} (${timeStr})`;
            
            const textDiv = document.createElement('div');
            textDiv.textContent = segment.text;
            
            segmentDiv.appendChild(headerDiv);
            segmentDiv.appendChild(textDiv);
            transcriptionEl.appendChild(segmentDiv);
            
            // Scroll to the bottom to show latest text
            transcriptionEl.scrollTop = transcriptionEl.scrollHeight;
        }
    });
}

// Display full transcription segments (for batch processing)
function displayTranscription(segments) {
    transcriptionEl.innerHTML = '';
    
    if (!segments || segments.length === 0) {
        transcriptionEl.textContent = 'No transcription data received.';
        return;
    }
    
    // Display segments with speaker diarization
    segments.forEach(segment => {
        const segmentDiv = document.createElement('div');
        const speakerId = segment.speaker;
        segmentDiv.className = `segment speaker-${speakerId % 2}`;
        
        const timeStr = formatTime(segment.start) + ' - ' + formatTime(segment.end);
        const headerDiv = document.createElement('div');
        headerDiv.className = 'segment-header';
        headerDiv.textContent = `Speaker ${speakerId} (${timeStr})`;
        
        const textDiv = document.createElement('div');
        textDiv.textContent = segment.text;
        
        segmentDiv.appendChild(headerDiv);
        segmentDiv.appendChild(textDiv);
        transcriptionEl.appendChild(segmentDiv);
    });
}

// Display LLM analysis
function displayAnalysis(analysisText) {
    if (!analysisEl) {
        console.log('Analysis element not found, creating one');
        // Create the element if it doesn't exist
        const containerDiv = document.querySelector('.container:nth-child(2)');
        const analysisContainer = document.createElement('div');
        analysisContainer.className = 'container';
        analysisContainer.innerHTML = `
            <h2>AI Analysis</h2>
            <div id="analysis" class="analysis-content"></div>
        `;
        document.body.insertBefore(analysisContainer, containerDiv.nextSibling);
        analysisEl = document.getElementById('analysis');
    }
    
    if (!analysisText) {
        analysisEl.textContent = 'No analysis available';
        return;
    }
    
    analysisEl.innerHTML = '';
    
    // Format the analysis text with Markdown-like handling
    const paragraphs = analysisText.split('\n\n');
    paragraphs.forEach(paragraph => {
        if (paragraph.trim().startsWith('#')) {
            // Handle heading
            const headingEl = document.createElement('h3');
            headingEl.textContent = paragraph.trim().replace(/^#+\s/, '');
            analysisEl.appendChild(headingEl);
        } else if (paragraph.trim().startsWith('-') || paragraph.trim().startsWith('*')) {
            // Handle list
            const ulEl = document.createElement('ul');
            const listItems = paragraph.trim().split('\n');
            listItems.forEach(item => {
                if (item.trim()) {
                    const liEl = document.createElement('li');
                    liEl.textContent = item.trim().replace(/^[-*]\s/, '');
                    ulEl.appendChild(liEl);
                }
            });
            analysisEl.appendChild(ulEl);
        } else if (paragraph.trim()) {
            // Regular paragraph
            const pEl = document.createElement('p');
            pEl.textContent = paragraph.trim();
            analysisEl.appendChild(pEl);
        }
    });
}

function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    timerEl.textContent = `${minutes}:${seconds}`;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

console.log('Script loaded and initialized with streaming support');