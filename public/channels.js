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
const backfillThumbnailsBtn = document.getElementById('backfillThumbnailsBtn');
const missingThumbnails = document.getElementById('missingThumbnails');
const processNewOnlyBtn = document.getElementById('processNewOnlyBtn');
const videosWithoutKeywords = document.getElementById('videosWithoutKeywords');

// Keyword management elements
const keywordsList = document.getElementById('keywordsList');
const blacklistList = document.getElementById('blacklistList');
const keywordsManager = document.getElementById('keywordsManager');
const blacklistManager = document.getElementById('blacklistManager');
const toggleBlacklistBtn = document.getElementById('toggleBlacklistBtn');
const blacklistSelectedBtn = document.getElementById('blacklistSelectedBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');
const addBlacklistInput = document.getElementById('addBlacklistInput');
const addBlacklistBtn = document.getElementById('addBlacklistBtn');

const API_BASE = window.location.origin;

// Track selected keywords
let selectedKeywords = new Set();
let showingBlacklist = false;

// Load data on page load
document.addEventListener('DOMContentLoaded', () => {
  loadChannels();
  loadAiStatus();
  loadKeywords();
});

// Refresh button
refreshBtn.addEventListener('click', () => {
  loadChannels();
  loadAiStatus();
  loadKeywords();
});

// Toggle blacklist view
toggleBlacklistBtn.addEventListener('click', () => {
  showingBlacklist = !showingBlacklist;
  if (showingBlacklist) {
    keywordsManager.style.display = 'none';
    blacklistManager.style.display = 'block';
    toggleBlacklistBtn.textContent = 'Show Keywords';
    loadBlacklist();
  } else {
    keywordsManager.style.display = 'block';
    blacklistManager.style.display = 'none';
    toggleBlacklistBtn.textContent = 'Show Blacklist';
    loadKeywords();
  }
});

// Select all keywords
selectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.keyword-chip').forEach(chip => {
    chip.classList.add('selected');
    selectedKeywords.add(chip.dataset.keyword);
  });
  updateBlacklistButton();
});

// Deselect all keywords
deselectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.keyword-chip').forEach(chip => {
    chip.classList.remove('selected');
  });
  selectedKeywords.clear();
  updateBlacklistButton();
});

// Blacklist selected keywords
blacklistSelectedBtn.addEventListener('click', async () => {
  if (selectedKeywords.size === 0) return;

  try {
    const response = await fetch(`${API_BASE}/api/keyword-blacklist/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: Array.from(selectedKeywords) })
    });

    if (!response.ok) throw new Error('Failed to blacklist keywords');

    showSuccess(`Blacklisted ${selectedKeywords.size} keywords`);
    selectedKeywords.clear();
    updateBlacklistButton();
    loadKeywords();
    loadAiStatus();
  } catch (error) {
    showError('Failed to blacklist keywords: ' + error.message);
  }
});

// Add keyword to blacklist
addBlacklistBtn.addEventListener('click', addToBlacklist);
addBlacklistInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToBlacklist();
});

async function addToBlacklist() {
  const keyword = addBlacklistInput.value.trim();
  if (!keyword) return;

  try {
    const response = await fetch(`${API_BASE}/api/keyword-blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword })
    });

    if (!response.ok) throw new Error('Failed to add to blacklist');

    addBlacklistInput.value = '';
    showSuccess(`Added "${keyword}" to blacklist`);
    loadBlacklist();
    loadAiStatus();
  } catch (error) {
    showError('Failed to add to blacklist: ' + error.message);
  }
}

// Process New Only button (primary)
processNewOnlyBtn.addEventListener('click', () => startAiProcessing(true));

// Process All (reprocess) button
processAiBtn.addEventListener('click', () => startAiProcessing(false));

// Backfill thumbnails button
backfillThumbnailsBtn.addEventListener('click', startThumbnailBackfill);

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

  // Format dates
  const newestVideoDate = channel.newest_video_date
    ? new Date(channel.newest_video_date).toLocaleDateString()
    : 'N/A';
  const lastChecked = channel.last_checked
    ? new Date(channel.last_checked).toLocaleString()
    : 'Never';
  const lastVideoOnYoutube = channel.last_video_date_on_youtube
    ? new Date(channel.last_video_date_on_youtube).toLocaleDateString()
    : 'N/A';

  // New videos indicator
  const hasNewVideos = channel.has_new_videos;
  const newVideosIndicator = hasNewVideos
    ? '<span class="new-videos-badge">New videos available!</span>'
    : '';

  return `
    <div class="channel-card ${hasNewVideos ? 'has-new-videos' : ''}" data-channel="${escapeHtml(channel.channel_name)}">
      <div class="channel-header">
        <div class="channel-info">
          <h3>${escapeHtml(channel.channel_name)} ${newVideosIndicator}</h3>
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

      <div class="channel-dates">
        <div class="date-info">
          <span class="date-label">Newest indexed:</span>
          <span class="date-value">${newestVideoDate}</span>
        </div>
        <div class="date-info">
          <span class="date-label">Latest on YouTube:</span>
          <span class="date-value ${hasNewVideos ? 'highlight' : ''}">${lastVideoOnYoutube}</span>
        </div>
        <div class="date-info">
          <span class="date-label">Last checked:</span>
          <span class="date-value">${lastChecked}</span>
        </div>
      </div>

      <div class="video-progress">
        <div class="video-progress-bar">
          <div class="video-progress-fill" style="width: ${percentage}%"></div>
        </div>
        <p class="video-progress-text">${percentage}% complete - ${aiStatus}</p>
      </div>

      <div class="channel-actions">
        ${hasMissing || hasNewVideos ? `
          <button class="channel-btn primary" onclick="processMissingVideos('${escapeHtml(channel.channel_name)}', '${escapeHtml(channel.channel_url || '')}')">
            ${hasNewVideos ? 'Process New Videos' : 'Process Missing Videos'}
          </button>
        ` : ''}
        <button class="channel-btn secondary" onclick="refreshChannelCount('${escapeHtml(channel.channel_name)}', '${escapeHtml(channel.channel_url || '')}')">
          Check for Updates
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
    videosWithoutKeywords.textContent = status.videos_without_keywords || 0;
    missingThumbnails.textContent = status.missing_thumbnails || 0;

    // Update Process New Only button state
    if (status.videos_without_keywords === 0) {
      processNewOnlyBtn.disabled = true;
    } else {
      processNewOnlyBtn.disabled = false;
    }

    // Update backfill button state
    if (status.missing_thumbnails === 0) {
      backfillThumbnailsBtn.disabled = true;
    } else {
      backfillThumbnailsBtn.disabled = false;
    }
  } catch (error) {
    console.error('Failed to load AI status:', error);
  }
}

// Start AI processing
async function startAiProcessing(newOnly = false) {
  hideError();
  hideSuccess();
  setAiLoading(true, newOnly);
  showAiProgress();
  updateAiProgress(0, newOnly ? 'Starting AI processing (new videos only)...' : 'Starting AI processing (all videos)...');

  try {
    const response = await fetch(`${API_BASE}/api/process-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOnly })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start AI processing');
    }

    // Poll for status
    await pollAiStatus(data.jobId, newOnly);

  } catch (error) {
    hideAiProgress();
    showError('AI processing failed: ' + error.message);
  } finally {
    setAiLoading(false, newOnly);
  }
}

// Start thumbnail backfill
async function startThumbnailBackfill() {
  hideError();
  hideSuccess();
  setThumbnailLoading(true);
  showAiProgress();
  updateAiProgress(0, 'Starting thumbnail backfill...');

  try {
    const response = await fetch(`${API_BASE}/api/backfill-thumbnails`, {
      method: 'POST'
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start thumbnail backfill');
    }

    // Poll for status
    await pollJobStatus(data.jobId, 'thumbnails');

  } catch (error) {
    hideAiProgress();
    showError('Thumbnail backfill failed: ' + error.message);
  } finally {
    setThumbnailLoading(false);
  }
}

// Set thumbnail button loading state
function setThumbnailLoading(loading) {
  backfillThumbnailsBtn.disabled = loading;
  backfillThumbnailsBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  backfillThumbnailsBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}

// Poll job status (works for both AI and thumbnail jobs)
async function pollJobStatus(jobId, type) {
  let completed = false;

  while (!completed) {
    await sleep(2000);

    try {
      const response = await fetch(`${API_BASE}/api/ai-status/${jobId}`);
      const status = await response.json();

      if (status.status === 'error') {
        throw new Error(status.error || `${type} processing failed`);
      }

      if (status.status === 'processing') {
        const percent = status.total > 0
          ? Math.round((status.processed / status.total) * 100)
          : 0;
        const label = type === 'thumbnails' ? 'Fetching thumbnails' : 'Extracting keywords';
        updateAiProgress(percent, `Processing ${status.processed}/${status.total}: ${label}...`);
      } else if (status.status === 'completed') {
        completed = true;
        updateAiProgress(100, 'Complete!');
        await sleep(500);
        hideAiProgress();
        if (type === 'thumbnails') {
          showSuccess(`Thumbnail backfill complete! Updated ${status.processed} videos.`);
        } else {
          showSuccess(`AI processing complete! Extracted ${status.keywords_count} keywords from ${status.processed} videos.`);
        }
        loadAiStatus();
        loadChannels();
      }
    } catch (error) {
      throw error;
    }
  }
}

// Poll AI processing status
async function pollAiStatus(jobId, newOnly = false) {
  let completed = false;
  const modeLabel = newOnly ? 'new videos' : 'all videos';

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
        showSuccess(`AI processing complete (${modeLabel})! Extracted ${status.keywords_count} keywords from ${status.processed} videos.`);
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

  // Find the button and show loading state
  const card = document.querySelector(`[data-channel="${channelName}"]`);
  const btn = card?.querySelector('.channel-btn.secondary');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking...';
  }

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

    // Show detailed result
    let message = `${channelName}: ${data.totalVideos} videos on YouTube, ${data.videosInDb} indexed.`;
    if (data.lastVideoDate) {
      message += ` Latest: ${new Date(data.lastVideoDate).toLocaleDateString()}.`;
    }
    if (data.hasNewVideos) {
      if (data.missingVideos > 0) {
        message += ` ${data.missingVideos} NEW VIDEO(S) AVAILABLE!`;
      } else {
        message += ' NEW CONTENT DETECTED!';
      }
    } else {
      message += ' Up to date.';
    }

    showSuccess(message);
    loadChannels();

  } catch (error) {
    showError('Failed to refresh count: ' + error.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    }
  }
}

// Helper functions
function setAiLoading(loading, newOnly = false) {
  // Disable both buttons during processing
  processAiBtn.disabled = loading;
  processNewOnlyBtn.disabled = loading;

  if (newOnly) {
    processNewOnlyBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
    processNewOnlyBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
  } else {
    processAiBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
    processAiBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
  }
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

// ============================================
// KEYWORD MANAGEMENT
// ============================================

// Load all keywords
async function loadKeywords() {
  keywordsList.innerHTML = '<p class="loading-text">Loading keywords...</p>';
  selectedKeywords.clear();
  updateBlacklistButton();

  try {
    const response = await fetch(`${API_BASE}/api/keywords?limit=200`);
    const keywords = await response.json();

    if (keywords.length === 0) {
      keywordsList.innerHTML = '<p class="empty-state">No keywords yet. Run AI processing first!</p>';
      return;
    }

    keywordsList.innerHTML = keywords.map(k => `
      <div class="keyword-chip" data-keyword="${escapeHtml(k.keyword)}" onclick="toggleKeyword(this)">
        <span>${escapeHtml(k.keyword)}</span>
        <span class="count">(${k.count})</span>
      </div>
    `).join('');
  } catch (error) {
    keywordsList.innerHTML = '<p class="loading-text">Failed to load keywords</p>';
  }
}

// Load blacklisted keywords
async function loadBlacklist() {
  blacklistList.innerHTML = '<p class="loading-text">Loading blacklist...</p>';

  try {
    const response = await fetch(`${API_BASE}/api/keyword-blacklist`);
    const keywords = await response.json();

    if (keywords.length === 0) {
      blacklistList.innerHTML = '<p class="empty-state">No blacklisted keywords</p>';
      return;
    }

    blacklistList.innerHTML = keywords.map(k => `
      <div class="keyword-chip">
        <span>${escapeHtml(k.keyword)}</span>
        <button class="remove-btn" onclick="removeFromBlacklist('${escapeHtml(k.keyword)}')" title="Remove from blacklist">x</button>
      </div>
    `).join('');
  } catch (error) {
    blacklistList.innerHTML = '<p class="loading-text">Failed to load blacklist</p>';
  }
}

// Toggle keyword selection
function toggleKeyword(chip) {
  const keyword = chip.dataset.keyword;
  if (chip.classList.contains('selected')) {
    chip.classList.remove('selected');
    selectedKeywords.delete(keyword);
  } else {
    chip.classList.add('selected');
    selectedKeywords.add(keyword);
  }
  updateBlacklistButton();
}

// Update blacklist button text
function updateBlacklistButton() {
  const count = selectedKeywords.size;
  blacklistSelectedBtn.textContent = `Blacklist Selected (${count})`;
  blacklistSelectedBtn.disabled = count === 0;
}

// Remove keyword from blacklist
async function removeFromBlacklist(keyword) {
  try {
    const response = await fetch(`${API_BASE}/api/keyword-blacklist/${encodeURIComponent(keyword)}`, {
      method: 'DELETE'
    });

    if (!response.ok) throw new Error('Failed to remove from blacklist');

    showSuccess(`Removed "${keyword}" from blacklist`);
    loadBlacklist();
    loadAiStatus();
  } catch (error) {
    showError('Failed to remove from blacklist: ' + error.message);
  }
}
