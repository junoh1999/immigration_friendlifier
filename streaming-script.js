// Add these new DOM elements
const welcomeMessageEl = document.getElementById('welcome-message');

// Update the existing recordBtn event listener
recordBtn.addEventListener('click', function() {
    console.log('Record button clicked');
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

// Remove the stopBtn event listener and use recordBtn for both start/stop

// Update to startRecording function
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
        
        // Show loading indicator instead of emoji
        emojiDisplayEl.innerHTML = '<div class="loading-indicator"></div>';
        
        // Hide welcome message when recording starts
        welcomeMessageEl.classList.add('hidden');
        
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
        
        statusEl.textContent = (ablyClient && ablyClient.connection.state === 'connected') ? 
            'Recording (streaming mode)...' : 'Recording (batch mode)...';
        recordBtn.classList.add('recording');
        isRecording = true;
        
    } catch (error) {
        console.error('Error starting recording:', error);
        statusEl.textContent = 'Error starting recording: ' + error.message;
    }
}

// Update to stopRecording function
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
    statusEl.textContent = 'Recording stopped.';
    recordBtn.classList.remove('recording');
}

// Add this function to update the clock in the navbar
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

// Update the handleAnalysisMessage function
function handleAnalysisMessage(message) {
    if (message.data.sessionId !== sessionId) return;
    
    const analysis = message.data.analysis;
    if (analysis) {
        // Show welcome message again if no analysis
        welcomeMessageEl.classList.add('hidden');
        displayAnalysis(analysis);
    }
}

// Initialize clock on page load
document.addEventListener('DOMContentLoaded', function() {
    updateClock();
    // Update clock every minute
    setInterval(updateClock, 60000);
});