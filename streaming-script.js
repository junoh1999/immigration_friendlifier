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
let streamingEnabled = true; // We'll check this with the server
let streamingChecked = false;

// Check for browser support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.log('Browser does not support audio recording');
    statusEl.textContent = 'Audio recording not supported in this browser';
    recordBtn.disabled = true;
}

// Check if streaming is available on this deployment
checkStreamingAvailability();

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
async function checkStreamingAvailability() {
    try {
        const response = await fetch('/api/streaming-proxy');
        if (response.ok) {
            const data = await response.json();
            if (data.useStreamingFallback) {
                streamingEnabled = false;
                console.log('Streaming not available, using batch mode');
                
                // Update UI to show we're using batch mode
                if (document.getElementById('modeIndicator')) {
                    document.getElementById('modeIndicator').textContent = '(Using batch processing mode)';
                } else {
                    const modeIndicator = document.createElement('div');
                    modeIndicator.id = 'modeIndicator';
                    modeIndicator.className = 'mode-indicator';
                    modeIndicator.textContent = '(Using batch processing mode)';
                    statusEl.parentNode.insertBefore(modeIndicator, statusEl.nextSibling);
                }
            }
        } else {
            streamingEnabled = false;
            console.log('Error checking streaming availability, using batch mode');
        }
    } catch (error) {
        streamingEnabled = false;
        console.log('Error checking streaming availability:', error);
    }
    
    streamingChecked = true;
}

async function startRecording() {
    console.log('Starting recording...');
    try {
        // Make sure we've checked streaming availability
        if (!streamingChecked) {
            await checkStreamingAvailability();
        }
        
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
        
        // Always use batch processing for now
        setupMediaRecorder(stream);
        
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
    
    // Stop MediaRecorder (batch approach)
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    clearInterval(timerInterval);
    stopBtn.disabled = true;
    recordBtn.disabled = false;
    statusEl.textContent = 'Recording stopped.';
    recordBtn.classList.remove('recording');
}

// Handle regular MediaRecorder setup (for batch processing)
function setupMediaRecorder(stream) {
    mediaRecorder = new MediaRecorder(stream);
    console.log('MediaRecorder created, state:', mediaRecorder.state);
    
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
        console.log('Data available event, size:', event.data.size);
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };
    
    mediaRecorder.onstop = () => {
        console.log('MediaRecorder stopped');
        // Most browsers record as audio/webm or audio/ogg
        audioBlob = new Blob(audioChunks);
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

console.log('Script loaded and initialized with auto-fallback');