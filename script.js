// DOM Elements
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const transcribeBtn = document.getElementById('transcribeBtn');
const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const transcriptionEl = document.getElementById('transcription');
const analysisEl = document.getElementById('analysis'); // New element for LLM analysis

console.log('DOM elements found:', {
  recordBtn: !!recordBtn, 
  stopBtn: !!stopBtn,
  transcribeBtn: !!transcribeBtn,
  timerEl: !!timerEl,
  statusEl: !!statusEl,
  transcriptionEl: !!transcriptionEl,
  analysisEl: !!analysisEl
});

// Global variables
let mediaRecorder;
let audioChunks = [];
let recordingStartTime;
let timerInterval;
let audioBlob;

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

transcribeBtn.addEventListener('click', function() {
    console.log('Transcribe button clicked');
    transcribeAudio();
});

// Functions
async function startRecording() {
    console.log('Starting recording...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Got audio stream:', stream);
        
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
            
            stopBtn.disabled = true;
            transcribeBtn.disabled = false;
            statusEl.textContent = 'Recording stopped. Ready to transcribe.';
            recordBtn.classList.remove('recording');
            
            // Stop all tracks in the stream to release the microphone
            stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        console.log('MediaRecorder started, state:', mediaRecorder.state);
        recordingStartTime = Date.now();
        startTimer();
        
        recordBtn.disabled = true;
        stopBtn.disabled = false;
        transcribeBtn.disabled = true;
        statusEl.textContent = 'Recording...';
        recordBtn.classList.add('recording');
        
    } catch (error) {
        console.error('Error starting recording:', error);
        statusEl.textContent = 'Error starting recording: ' + error.message;
    }
}

function stopRecording() {
    console.log('Stopping recording...');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        clearInterval(timerInterval);
        console.log('MediaRecorder stop called, state:', mediaRecorder.state);
    } else {
        console.log('MediaRecorder not active, cannot stop');
    }
}

async function transcribeAudio() {
    console.log('Transcribing audio...');
    if (!audioBlob) {
        console.log('No audio blob available');
        statusEl.textContent = 'No recording available';
        return;
    }
    
    console.log('Audio blob size:', audioBlob.size, 'type:', audioBlob.type);
    
    // Disable transcribe button and update status
    transcribeBtn.disabled = true;
    statusEl.textContent = 'Uploading and transcribing...';
    
    try {
        // First, we need to convert the audio blob to a base64 string
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        
        reader.onloadend = async () => {
            const base64Audio = reader.result;
            console.log('Audio converted to base64, length:', base64Audio.length);
            
            // Send to our new proxy API endpoint with type=transcribe
            console.log('Sending to API proxy for Deepgram transcription...');
            const response = await fetch('/api/proxy?type=transcribe', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    audioData: base64Audio
                })
            });
            
            console.log('API response status:', response.status);
            
            if (!response.ok) {
                const errorData = await response.json();
                console.error('API error:', errorData);
                throw new Error(`API Error: ${JSON.stringify(errorData)}`);
            }
            
            // Process the response directly (no polling needed with Deepgram)
            const responseData = await response.json();
            console.log('Transcription complete:', responseData);
            
            // Display results
            if (responseData.status === 'succeeded') {
                displayTranscription(responseData.output);
                displayAnalysis(responseData.output.llmAnalysis);
                statusEl.textContent = 'Transcription and analysis complete!';
            } else {
                console.error('Transcription failed:', responseData.error);
                statusEl.textContent = 'Transcription failed: ' + (responseData.error || 'Unknown error');
            }
            
            // Re-enable buttons
            transcribeBtn.disabled = false;
            recordBtn.disabled = false;
        };
    } catch (error) {
        console.error('Error transcribing audio:', error);
        statusEl.textContent = 'Error: ' + error.message;
        transcribeBtn.disabled = false;
        recordBtn.disabled = false;
    }
}

function displayTranscription(output) {
    console.log('Displaying transcription:', output);
    transcriptionEl.innerHTML = '';
    
    if (!output || !output.segments || output.segments.length === 0) {
        console.log('No transcription data to display');
        transcriptionEl.textContent = 'No transcription data received.';
        return;
    }
    
    // Display segments with speaker diarization
    output.segments.forEach((segment, index) => {
        console.log('Segment:', index, segment);
        const segmentDiv = document.createElement('div');
        const speakerId = segment.speaker || 0;
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
    console.log('Starting timer');
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

console.log('Script loaded and initialized');