// DOM Elements
const channelsList = document.getElementById('channelsList');
const refreshBtn = document.getElementById('refreshBtn');
const processAiBtn = document.getElementById('processAiBtn');
const aiProgressSection = document.getElementById('aiProgressSection');
const aiProgressFill = document.getElementById('aiProgressFill');
const aiProgressText = document.getElementById('aiProgressText');
const aiProgressPercent = document.getElementById('aiProgressPercent');
const lastProcessed = document.getElementById('lastProcessed');
const totalKeywords = document.getElementById('totalKeywords');
const videosAnalyzed = document.getElementById('videosAnalyzed');
const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');
const successMessage = document.getElementById('successMessage');
const successText = document.getElementById('successText');

const API_BASE = window.location.origin;

// Load data on page load
document.addEventListener('DOMContentLoaded', () => {
  loadChannels();
  loadAiStatus();
});

// Refresh button
refreshBtn.addEventListener('click', () => {
  loadChannels();
  loadAiStatus();
});

// Process AI button
processAiBtn.addEventListener('click', startAiProcessing);

// Load channels list
async function loadChannels() {
  channelsList.innerHTML = '<p class="loading-text">Loading channels...</p>';
  hideError();
  hideSuccess();

  try {
    const response = await fetch(`${API_BASE}/api/channels`);
    const channels = await response.json();

    if (channels.length === 0) {
      channelsList.innerHTML = '<p class="empty-state">No channels found. Process some YouTube videos first!</p>';
      return;
    }

    channelsList.innerHTML = channels.map(channel => createChannelCard(channel)).join('');
  } catch (error) {
    channelsList.innerHTML = '<p class="loading-text">Failed to load channels</p>';
    showError('Failed to load channels: ' + error.message);
  }
}

// Create channel card HTML
function createChannelCard(channel) {
  const percentage = channel.total_available > 0
    ? Math.round((channel.videos_processed / channel.total_available) * 100)
    : 100;
  const hasMissing = channel.total_available > channel.videos_processed;
  const aiStatus = channel.ai_processed_at
    ? `AI processed: ${new Date(channel.ai_processed_at).toLocaleString()}`
    : 'AI not processed';

  return `
    <div class="channel-card" data-channel="${escapeHtml(channel.channel_name)}">
      <div class="channel-header">
        <div class="channel-info">
          <h3>${escapeHtml(channel.channel_name)}</h3>
          <p class="channel-url">${escapeHtml(channel.channel_url || 'No URL saved')}</p>
        </div>
      </div>

      <div class="channel-stats">
        <div class="stat">
          <div class="stat-value">${channel.videos_processed}</div>
          <div class="stat-label">Processed</div>
        </div>
        <div class="stat ${hasMissing ? 'warning' : ''}">
          <div class="stat-value">${channel.total_available}</div>
          <div class="stat-label">Available</div>
        </div>
        <div class="stat ${hasMissing ? 'error' : ''}">
          <div class="stat-value">${channel.total_available - channel.videos_processed}</div>
          <div class="stat-label">Missing</div>
        </div>
      </div>

      <div class="video-progress">
        <div class="video-progress-bar">
          <div class="video-progress-fill" style="width: ${percentage}%"></div>
        </div>
        <p class="video-progress-text">${percentage}% complete - ${aiStatus}</p>
      </div>

      <div class="channel-actions">
        ${hasMissing ? `
          <button class="channel-btn primary" onclick="processMissingVideos('${escapeHtml(channel.channel_name)}', '${escapeHtml(channel.channel_url || '')}')">
            Process Missing Videos
          </button>
        ` : ''}
        <button class="channel-btn secondary" onclick="refreshChannelCount('${escapeHtml(channel.channel_name)}', '${escapeHtml(channel.channel_url || '')}')">
          Refresh Video Count
        </button>
      </div>
    </div>
  `;
}

// Load AI processing status
async function loadAiStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/ai-status`);
    const status = await response.json();

    lastProcessed.textContent = status.last_processed
      ? new Date(status.last_processed).toLocaleString()
      : 'Never';
    totalKeywords.textContent = status.total_keywords || 0;
    videosAnalyzed.textContent = status.videos_analyzed || 0;
  } catch (error) {
    console.error('Failed to load AI status:', error);
  }
}

// Start AI processing
async function startAiProcessing() {
  hideError();
  hideSuccess();
  setAiLoading(true);
  showAiProgress();
  updateAiProgress(0, 'Starting AI processing...');

  try {
    const response = await fetch(`${API_BASE}/api/process-ai`, {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start AI processing');
    }

    // Poll for status
    await pollAiStatus(data.jobId);

  } catch (error) {
    hideAiProgress();
    showError('AI processing failed: ' + error.message);
  } finally {
    setAiLoading(false);
  }
}

// Poll AI processing status
async function pollAiStatus(jobId) {
  let completed = false;

  while (!completed) {
    await sleep(2000);

    try {
      const response = await fetch(`${API_BASE}/api/ai-status/${jobId}`);
      const status = await response.json();

      if (status.status === 'error') {
        throw new Error(status.error || 'AI processing failed');
      }

      if (status.status === 'processing') {
        const percent = status.total > 0
          ? Math.round((status.processed / status.total) * 100)
          : 0;
        updateAiProgress(percent, `Processing ${status.processed}/${status.total}: Extracting keywords...`);
      } else if (status.status === 'completed') {
        completed = true;
        updateAiProgress(100, 'Complete!');
        await sleep(500);
        hideAiProgress();
        showSuccess(`AI processing complete! Extracted ${status.keywords_count} keywords from ${status.processed} videos.`);
        loadAiStatus();
        loadChannels();
      }
    } catch (error) {
      throw error;
    }
  }
}

// Process missing videos for a channel
async function processMissingVideos(channelName, channelUrl) {
  if (!channelUrl) {
    showError('No channel URL saved. Please process the channel from the home page first.');
    return;
  }

  hideError();
  hideSuccess();

  // Find the button and disable it
  const card = document.querySelector(`[data-channel="${channelName}"]`);
  const btn = card?.querySelector('.channel-btn.primary');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Processing...';
  }

  try {
    const response = await fetch(`${API_BASE}/api/process-missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName, channelUrl })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start processing');
    }

    showSuccess(`Started processing missing videos for ${channelName}. Job ID: ${data.jobId}`);

    // Reload after a delay
    setTimeout(() => {
      loadChannels();
    }, 5000);

  } catch (error) {
    showError('Failed to process missing videos: ' + error.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Process Missing Videos';
    }
  }
}

// Refresh channel video count
async function refreshChannelCount(channelName, channelUrl) {
  if (!channelUrl) {
    showError('No channel URL saved.');
    return;
  }

  hideError();
  hideSuccess();

  try {
    const response = await fetch(`${API_BASE}/api/refresh-channel-count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName, channelUrl })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to refresh count');
    }

    showSuccess(`Updated video count for ${channelName}: ${data.totalVideos} videos available`);
    loadChannels();

  } catch (error) {
    showError('Failed to refresh count: ' + error.message);
  }
}

// Helper functions
function setAiLoading(loading) {
  processAiBtn.disabled = loading;
  processAiBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  processAiBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}

function showAiProgress() {
  aiProgressSection.style.display = 'block';
}

function hideAiProgress() {
  aiProgressSection.style.display = 'none';
  aiProgressFill.style.width = '0%';
}

function updateAiProgress(percent, text) {
  aiProgressFill.style.width = `${percent}%`;
  aiProgressPercent.textContent = `${percent}%`;
  aiProgressText.textContent = text;
}

function showError(message) {
  errorText.textContent = message;
  errorMessage.style.display = 'flex';
}

function hideError() {
  errorMessage.style.display = 'none';
}

function showSuccess(message) {
  successText.textContent = message;
  successMessage.style.display = 'flex';
}

function hideSuccess() {
  successMessage.style.display = 'none';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
