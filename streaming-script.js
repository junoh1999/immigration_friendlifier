// DOM Elements
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const transcriptionEl = document.getElementById('transcription');
const analysisEl = document.getElementById('analysis');

// Global variables
let mediaRecorder;
let audioChunks = [];
let recordingStartTime;
let timerInterval;
let audioBlob;
let isRecording = false;
let ablyClient;
let ablyChannel;
let sessionId = generateSessionId();
let streamingEnabled = true;

// Check for browser support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.log('Browser does not support audio recording');
    statusEl.textContent = 'Audio recording not supported in this browser';
    recordBtn.disabled = true;
}

// Initialize Ably connection
async function initializeAbly() {
    try {
        // Load the Ably library
        await loadScript('https://cdn.ably.io/lib/ably.min-1.js');
        
        // Get a token from our backend
        const response = await fetch('/api/streaming-proxy');
        if (!response.ok) {
            throw new Error('Failed to get Ably token');
        }
        
        const tokenRequest = await response.json();
        
        // Initialize Ably with the token
        ablyClient = new Ably.Realtime({ authCallback: (_, callback) => callback(null, tokenRequest) });
        
        // Setup channel and subscribe to messages
        ablyChannel = ablyClient.channels.get('deepgram-channel');
        
        // Listen for transcription updates
        ablyChannel.subscribe('transcription', (message) => {
            if (message.data.sessionId === sessionId) {
                handleTranscriptionUpdate(message.data.result);
            }
        });
        
        // Listen for analysis updates
        ablyChannel.subscribe('analysis', (message) => {
            if (message.data.sessionId === sessionId) {
                displayAnalysis(message.data.analysis);
                updateTranscription(message.data.segments);
            }
        });
        
        ablyClient.connection.on('connected', () => {
            console.log('Connected to Ably');
            streamingEnabled = true;
        });
        
        ablyClient.connection.on('failed', () => {
            console.log('Ably connection failed, using fallback');
            streamingEnabled = false;
        });
        
        return true;
    } catch (error) {
        console.error('Error initializing Ably:', error);
        streamingEnabled = false;
        return false;
    }
}

// Initialize Ably when the page loads
initializeAbly();

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
        
        // Generate a new session ID
        sessionId = generateSessionId();
        
        // Check if streaming is enabled
        if (streamingEnabled && ablyClient && ablyClient.connection.state === 'connected') {
            setupStreamingRecorder(stream);
        } else {
            setupBatchRecorder(stream);
        }
        
        recordingStartTime = Date.now();
        startTimer();
        
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        statusEl.textContent = streamingEnabled ? 'Recording (streaming mode)...' : 'Recording (batch mode)...';
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
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    clearInterval(timerInterval);
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    statusEl.textContent = 'Recording stopped.';
    recordBtn.classList.remove('recording');
}

// Setup for streaming recording
function setupStreamingRecorder(stream) {
    // Create a smaller time slice for more frequent chunks
    mediaRecorder = new MediaRecorder(stream);
    let isFirstChunk = true;
    let chunkCount = 0;
    
    mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
            // Convert the blob to base64
            const reader = new FileReader();
            reader.readAsDataURL(event.data);
            
            reader.onloadend = async () => {
                // Extract the base64 part
                const base64Audio = reader.result.split(',')[1];
                
                // Send to our backend
                try {
                    await fetch('/api/streaming-proxy', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            audioChunk: base64Audio,
                            sessionId: sessionId,
                            isFirstChunk: isFirstChunk
                        })
                    });
                    
                    isFirstChunk = false;
                    chunkCount++;
                    
                    // Update status occasionally
                    if (chunkCount % 5 === 0) {
                        statusEl.textContent = `Streaming... (${chunkCount} chunks sent)`;
                    }
                } catch (error) {
                    console.error('Error sending audio chunk:', error);
                }
            };
        }
    };
    
    mediaRecorder.onstop = () => {
        // Stop all tracks in the stream to release the microphone
        stream.getTracks().forEach(track => track.stop());
        statusEl.textContent = 'Recording stopped. Processing final transcription...';
    };
    
    // Start recording with 1-second time slices
    mediaRecorder.start(1000);
    console.log('MediaRecorder started in streaming mode');
}

// Setup for batch recording
function setupBatchRecorder(stream) {
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };
    
    mediaRecorder.onstop = () => {
        audioBlob = new Blob(audioChunks);
        console.log('Recording stopped. Audio type:', audioBlob.type, 'Size:', audioBlob.size);
        
        // Send for batch transcription
        sendForBatchTranscription(audioBlob);
        
        // Stop all tracks in the stream to release the microphone
        stream.getTracks().forEach(track => track.stop());
    };
    
    mediaRecorder.start();
    console.log('MediaRecorder started in batch mode');
}

// Send audio for batch transcription
async function sendForBatchTranscription(audioBlob) {
    if (!audioBlob) {
        console.log('No audio blob available');
        statusEl.textContent = 'No recording available';
        return;
    }
    
    statusEl.textContent = 'Uploading and transcribing...';
    
    try {
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
    if (!data || !data.results || !data.results.channels || 
        !data.results.channels[0] || !data.results.channels[0].alternatives || 
        !data.results.channels[0].alternatives[0]) {
        return;
    }
    
    const alternative = data.results.channels[0].alternatives[0];
    const transcript = alternative.transcript;
    
    if (transcript && transcript.trim() !== '') {
        // Update status
        statusEl.textContent = 'Receiving transcription...';
        
        // Process the words to get speaker information
        const words = alternative.words || [];
        
        if (words.length > 0) {
            // Group words by speaker
            let segments = [];
            let currentSegment = null;
            
            for (const word of words) {
                if (!currentSegment || currentSegment.speaker !== word.speaker) {
                    if (currentSegment) {
                        segments.push(currentSegment);
                    }
                    currentSegment = {
                        text: word.word,
                        start: word.start,
                        end: word.end,
                        speaker: word.speaker || 0
                    };
                } else {
                    // Same speaker, add to current segment
                    currentSegment.text += " " + word.word;
                    currentSegment.end = word.end;
                }
            }
            
            // Add the last segment
            if (currentSegment) {
                segments.push(currentSegment);
            }
            
            // Update the display
            updateTranscription(segments);
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
        // Check if we already have this segment (by time range and text)
        const existingSegments = Array.from(transcriptionEl.querySelectorAll('.segment'));
        const segmentExists = existingSegments.some(el => {
            const start = parseFloat(el.dataset.start);
            const end = parseFloat(el.dataset.end);
            const text = el.querySelector('div:not(.segment-header)').textContent;
            
            return Math.abs(start - segment.start) < 0.1 && 
                  Math.abs(end - segment.end) < 0.1 && 
                  text === segment.text;
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

// Helper functions
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

function generateSessionId() {
    return 'session-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

console.log('Script loaded and initialized with Ably streaming support');