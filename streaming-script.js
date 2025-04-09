// DOM Elements
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const transcriptionEl = document.getElementById('transcription');
const analysisEl = document.getElementById('analysis');
const analysisConsoleEl = document.getElementById('analysis-console');
const emojiDisplayEl = document.getElementById('emoji-display');
const welcomeMessageEl = document.getElementById('welcome-message');

console.log('DOM elements found:', {
  recordBtn: !!recordBtn, 
  stopBtn: !!stopBtn,
  timerEl: !!timerEl,
  statusEl: !!statusEl,
  transcriptionEl: !!transcriptionEl,
  analysisEl: !!analysisEl,
  analysisConsoleEl: !!analysisConsoleEl,
  emojiDisplayEl: !!emojiDisplayEl,
  welcomeMessageEl: !!welcomeMessageEl
});

// Toggle buttons were removed from HTML, so we'll skip initializing them
// const toggleTranscriptionBtn = document.getElementById('toggleTranscription');
// const toggleAnalysisBtn = document.getElementById('toggleAnalysis');

// Toggle containers
const transcriptionContainer = document.getElementById('transcription-container');
const analysisContainer = document.getElementById('analysis-container');

// Global variables
let mediaRecorder;
let audioContext;
let audioProcessor;
let recordingStartTime;
let timerInterval;
let isRecording = false;
let sessionId = generateUniqueId();
let ablyClient = null;
let transcriptChannel = null;
let analysisChannel = null;

// Check for browser support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.log('Browser does not support audio recording');
    statusEl.textContent = 'Audio recording not supported in this browser';
    recordBtn.disabled = true;
}

// Initialize Ably
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
async function initializeAbly() {
    try {
        // Load Ably script dynamically
        await loadScript('https://cdn.ably.io/lib/ably.min-1.js');
        
        // Get token from our backend
        const response = await fetch('/api/streaming-proxy');
        if (!response.ok) {
            throw new Error('Failed to get Ably token');
        }
        
        const data = await response.json();
        
        // Initialize Ably with token
        ablyClient = new Ably.Realtime({
            authCallback: (_, callback) => {
                callback(null, data.tokenRequest);
            }
        });
        
        // Subscribe to transcript channel
        transcriptChannel = ablyClient.channels.get('transcript-channel');
        transcriptChannel.subscribe('transcription', handleTranscriptionMessage);
        
        // Subscribe to analysis channel
        analysisChannel = ablyClient.channels.get('analysis-channel');
        analysisChannel.subscribe('analysis', handleAnalysisMessage);
        
        console.log('Ably initialized successfully');
        
        ablyClient.connection.on('connected', () => {
            console.log('Connected to Ably realtime');
            statusEl.textContent = 'Ready to record (streaming mode)';
        });
        
        ablyClient.connection.on('failed', (error) => {
            console.error('Ably connection failed:', error);
            statusEl.textContent = 'Streaming not available, using batch mode';
        });
        
    } catch (error) {
        console.error('Error initializing Ably:', error);
        statusEl.textContent = 'Streaming not available, using batch mode';
    }
}

async function startRecording() {
    console.log('Starting recording...');
    try {
        // Get audio stream with required sample rate
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });
        console.log('Got audio stream:', stream);
        
        // Clear previous transcriptions and analysis
        transcriptionEl.innerHTML = '';
        analysisEl.innerHTML = '';
        analysisConsoleEl.innerHTML = '';
        
        // Show loading indicator
        showLoadingIndicator();
        
        // Hide welcome message when recording starts
        if (welcomeMessageEl) {
            welcomeMessageEl.classList.add('hidden');
        }
        
        // Generate a new session ID for this recording
        sessionId = generateUniqueId();
        
        // Check if Ably is connected
        if (ablyClient && ablyClient.connection.state === 'connected') {
            // Use streaming mode
            setupStreamingAudio(stream);
        } else {
            // Fall back to batch mode
            setupBatchRecording(stream);
        }
        
        recordingStartTime = Date.now();
        startTimer();
        
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        statusEl.textContent = (ablyClient && ablyClient.connection.state === 'connected') ? 
            'Recording (streaming mode)...' : 'Recording (batch mode)...';
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
    
    // Stop MediaRecorder if using batch mode
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    // Clean up AudioContext if using streaming mode
    if (audioContext && audioContext.state !== 'closed') {
        if (audioProcessor) {
            audioProcessor.disconnect();
        }
        audioContext.close();
    }
    
    clearInterval(timerInterval);
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    statusEl.textContent = 'Recording stopped.';
    recordBtn.classList.remove('recording');
}

// Set up streaming audio processing
function setupStreamingAudio(stream) {
    try {
        // Create audio context with 16kHz sample rate (ideal for speech recognition)
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
        });
        
        // Create a source node from the stream
        const source = audioContext.createMediaStreamSource(stream);
        
        // Create script processor node for processing audio data
        // Note: ScriptProcessorNode is deprecated but still works in all browsers
        // AudioWorklet would be better but has less support
        audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        
        // Flag to track if we've sent the first chunk
        let isFirstChunk = true;
        
        // Process audio data
        audioProcessor.onaudioprocess = async (audioProcessingEvent) => {
            if (!isRecording) return;
            
            // Get the raw audio data
            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            
            // Convert to the format needed by Deepgram (16-bit PCM)
            const pcmData = convertFloat32ToInt16(inputData);
            
            // Convert to base64 for sending over HTTP
            const base64Audio = arrayBufferToBase64(pcmData.buffer);
            
            // Send to our backend
            try {
                const response = await fetch('/api/streaming-proxy', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        sessionId: sessionId,
                        audioData: base64Audio,
                        isFirstChunk: isFirstChunk
                    })
                });
                
                // Update first chunk flag
                if (isFirstChunk) {
                    isFirstChunk = false;
                }
                
                if (!response.ok) {
                    console.error('Error sending audio:', await response.text());
                }
            } catch (error) {
                console.error('Error sending audio to server:', error);
            }
        };
        
        // Connect the nodes
        source.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);
        
        // Make sure streams are cleaned up when recording stops
        stream.getAudioTracks().forEach(track => {
            track.onended = () => {
                if (isRecording) {
                    stopRecording();
                }
            };
        });
        
    } catch (error) {
        console.error('Error setting up audio streaming:', error);
        // Fall back to batch mode
        setupBatchRecording(stream);
    }
}

// Set up batch recording (fallback)
function setupBatchRecording(stream) {
    mediaRecorder = new MediaRecorder(stream);
    let audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };
    
    mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks);
        console.log('Recording stopped. Audio type:', audioBlob.type, 'Size:', audioBlob.size);
        
        // Send for batch transcription
        sendForBatchTranscription(audioBlob);
        
        // Stop all tracks in the stream to release the microphone
        stream.getTracks().forEach(track => track.stop());
    };
    
    mediaRecorder.start();
    console.log('MediaRecorder started in batch mode');
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

// Handle transcription messages from Ably
function handleTranscriptionMessage(message) {
    if (!message.data || message.data.sessionId !== sessionId) return;
    
    console.log('Received transcription:', message.data);
    
    // Extract the speaker ID with a default of 0
    const speakerId = message.data.speaker || 0;
    
    // Create segment object
    const segment = {
      text: message.data.text,
      speaker: speakerId,
      start: message.data.start || 0,
      end: message.data.end || 0
    };
    
    // Update the display with the new segment
    updateTranscription([segment]);
}

// Handle analysis messages from Ably
function handleAnalysisMessage(message) {
    if (message.data.sessionId !== sessionId) return;
    
    const analysis = message.data.analysis;
    if (analysis) {
        // Hide welcome message
        if (welcomeMessageEl) {
            welcomeMessageEl.classList.add('hidden');
        }
        displayAnalysis(analysis);
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
        // Check if we already have this segment based on time and text
        const existingSegments = Array.from(transcriptionEl.querySelectorAll('.segment'));
        const segmentExists = existingSegments.some(el => {
            const start = parseFloat(el.dataset.start || 0);
            const end = parseFloat(el.dataset.end || 0);
            const text = el.querySelector('div:not(.segment-header)')?.textContent || '';
            
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
        console.log('Analysis element not found');
        return;
    }
    
    if (!analysisText) {
        analysisEl.textContent = 'No analysis available';
        analysisConsoleEl.textContent = 'No analysis metadata available';
        return;
    }
    
    console.log("Raw analysis text:", analysisText);
    
    // Extract the analysis metadata and output sections
    let consoleText = '';
    let displayText = analysisText;
    let emoji = '';
    
    // First, identify if there's an Output: marker
    const outputSplit = analysisText.split(/Output:/i);
    
    if (outputSplit.length > 1) {
        consoleText = outputSplit[0].trim();
        displayText = outputSplit[1].trim();
    } else {
        // If no Output: marker, try to separate based on common patterns
        // Look for patterns like "**" or analysis sections
        const analysisSplit = analysisText.match(/\*\*Analysis:\*\*([\s\S]*?)(?:\*\*|$)/i);
        
        if (analysisSplit) {
            consoleText = analysisText;
            
            // Try to find the actual message after all the analysis sections
            const messageParts = analysisText.split(/\*\*$/m);
            if (messageParts.length > 1) {
                // Get the last non-empty part as the message
                for (let i = messageParts.length - 1; i >= 0; i--) {
                    if (messageParts[i].trim()) {
                        displayText = messageParts[i].trim();
                        break;
                    }
                }
            }
        }
    }
    
    // Extract emoji - look for it at the beginning of the display text
    // Check for emoji or bracketed emoji description at the start of a line
    const emojiMatch = displayText.match(/^(\[[^\]]+\]|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/um);
    
    if (emojiMatch) {
        emoji = emojiMatch[0];
        displayText = displayText.replace(emojiMatch[0], '').trim();
    } else {
        // If no emoji at the start, check throughout the text
        const anyEmojiMatch = displayText.match(/(\[[^\]]+\]|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
        if (anyEmojiMatch) {
            emoji = anyEmojiMatch[0];
            displayText = displayText.replace(anyEmojiMatch[0], '').trim();
        }
    }
    
    // Clean up the display text
    // Remove any remaining asterisks, markdown formatting
    displayText = displayText.replace(/\*\*/g, '').trim();
    
    // Update emoji display
    emojiDisplayEl.textContent = emoji || '😊'; // Default emoji if none found
    
    // Update console display - keep the raw format including asterisks
    analysisConsoleEl.textContent = consoleText || 'No analysis metadata available';
    
    // Update analysis content with clean text
    analysisEl.innerHTML = '';
    
    // Format the clean display text
    const paragraphs = displayText.split('\n\n');
    paragraphs.forEach(paragraph => {
        if (paragraph.trim()) {
            // Regular paragraph
            const pEl = document.createElement('p');
            pEl.textContent = paragraph.trim();
            analysisEl.appendChild(pEl);
        }
    });
    
    console.log("Processed analysis:", {
        emoji: emoji,
        consoleText: consoleText.substring(0, 100) + "...", // Log first 100 chars
        displayText: displayText
    });
}

// Show loading indicator
function showLoadingIndicator() {
    if (emojiDisplayEl) {
        emojiDisplayEl.innerHTML = '<div class="loading-indicator"></div>';
    }
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

function generateUniqueId() {
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

// Convert Float32Array to Int16Array (required format for Deepgram)
function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Convert to 16-bit PCM
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

// Convert ArrayBuffer to base64 string for transmission
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Update the clock in the navbar
function updateClock() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12; // Convert to 12-hour format
    const timeString = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
    
    // Find the time element and update it
    const timeEl = document.querySelector('.time');
    if (timeEl) {
        timeEl.textContent = timeString;
    }
}

// Initialize clock on page load
document.addEventListener('DOMContentLoaded', function() {
    // Initial clock update
    updateClock();
    
    // Update clock every minute
    setInterval(updateClock, 60000);
    
    // Make sure stop button is disabled initially
    if (stopBtn) {
        stopBtn.disabled = true;
    }
});