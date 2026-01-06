// DOM Elements
const form = document.getElementById('podcastForm');
const urlInput = document.getElementById('spotifyUrl');
const submitBtn = document.getElementById('submitBtn');
const btnText = submitBtn.querySelector('.btn-text');
const btnLoading = submitBtn.querySelector('.btn-loading');

const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');

const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');

const resultsSection = document.getElementById('resultsSection');
const resultPodcastName = document.getElementById('resultPodcastName');
const resultEpisodeTitle = document.getElementById('resultEpisodeTitle');
const resultSummary = document.getElementById('resultSummary');
const resultBestPart = document.getElementById('resultBestPart');
const newAnalysisBtn = document.getElementById('newAnalysisBtn');

const historyList = document.getElementById('historyList');

// Channel processing elements
let channelResultsSection = document.getElementById('channelResultsSection');

// API Base URL
const API_BASE = window.location.origin;

// Language selector
const languageSelect = document.getElementById('languageSelect');
const langBtns = document.querySelectorAll('.lang-btn');

// Set up language toggle buttons
langBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    langBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    languageSelect.value = btn.dataset.lang;
  });
});

// Load history on page load
document.addEventListener('DOMContentLoaded', loadHistory);

// Detect URL type
function detectUrlType(url) {
  if (url.includes('/watch?v=') || url.includes('youtu.be/')) {
    return 'video';
  } else if (url.includes('/channel/') || url.includes('/c/') || url.includes('/@') || url.includes('/user/')) {
    return 'channel';
  } else if (url.includes('/playlist?list=')) {
    return 'playlist';
  }
  return 'unknown';
}

// Form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();

  if (!url) {
    showError('Please enter a YouTube URL.');
    return;
  }

  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    showError('Please enter a valid YouTube URL');
    return;
  }

  // Reset UI
  hideError();
  hideResults();
  hideChannelResults();

  setLoading(true);
  showProgress();

  const urlType = detectUrlType(url);

  try {
    if (urlType === 'video') {
      await processVideo(url);
    } else if (urlType === 'channel' || urlType === 'playlist') {
      await processChannel(url, urlType);
    } else {
      throw new Error('Could not determine URL type. Use a video, channel, or playlist URL.');
    }
  } catch (error) {
    hideProgress();
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

// Process single video
async function processVideo(url) {
  updateProgress(5, 'Checking if already processed...');

  const checkResponse = await fetch(`${API_BASE}/api/check?url=${encodeURIComponent(url)}`);
  const checkData = await checkResponse.json();

  if (checkData.exists) {
    hideProgress();
    showError(`This video has already been processed. Title: "${checkData.data.episode_title}"`);
    return;
  }

  updateProgress(20, 'Fetching subtitles...');

  const language = languageSelect ? languageSelect.value : 'en';
  const processResponse = await fetch(`${API_BASE}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, language })
  });

  const processData = await processResponse.json();

  if (!processResponse.ok) {
    throw new Error(processData.error || 'Failed to process video');
  }

  updateProgress(100, 'Complete!');
  await sleep(500);

  hideProgress();
  showResults(processData.data);
  loadHistory();
  form.reset();
}

// Process channel or playlist
async function processChannel(url, type) {
  updateProgress(5, `Starting ${type} processing...`);

  const language = languageSelect ? languageSelect.value : 'en';
  const processResponse = await fetch(`${API_BASE}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, maxVideos: 50, language })
  });

  const processData = await processResponse.json();

  if (!processResponse.ok) {
    throw new Error(processData.error || 'Failed to start processing');
  }

  const jobId = processData.jobId;
  updateProgress(10, 'Fetching video list...');

  // Poll for status
  await pollChannelStatus(jobId);
}

// Poll channel processing status
async function pollChannelStatus(jobId) {
  let completed = false;

  while (!completed) {
    await sleep(2000);

    const statusResponse = await fetch(`${API_BASE}/api/channel-status/${jobId}`);
    const status = await statusResponse.json();

    if (status.status === 'error') {
      throw new Error(status.error || 'Channel processing failed');
    }

    if (status.status === 'fetching_videos') {
      updateProgress(15, 'Fetching video list from channel...');
    } else if (status.status === 'processing') {
      const percent = status.total > 0
        ? Math.min(90, 20 + Math.floor((status.processed + status.skipped + status.failed) / status.total * 70))
        : 20;
      updateProgress(percent, `Processing ${status.processed + status.skipped + status.failed + 1}/${status.total}: ${status.currentVideo || '...'}`);
    } else if (status.status === 'completed') {
      completed = true;
      updateProgress(100, 'Complete!');
      await sleep(500);
      hideProgress();
      showChannelResults(status);
      loadHistory();
      form.reset();
    }
  }
}

// New analysis button
newAnalysisBtn.addEventListener('click', () => {
  hideResults();
  hideChannelResults();
  form.scrollIntoView({ behavior: 'smooth' });
});

// Helper functions
function setLoading(loading) {
  submitBtn.disabled = loading;
  btnText.style.display = loading ? 'none' : 'inline';
  btnLoading.style.display = loading ? 'inline' : 'none';
}

function showProgress() {
  progressSection.style.display = 'block';
}

function hideProgress() {
  progressSection.style.display = 'none';
  progressFill.style.width = '0%';
}

function updateProgress(percent, text) {
  progressFill.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressText.textContent = text;
}

function showError(message) {
  errorText.textContent = message;
  errorMessage.style.display = 'flex';
}

function hideError() {
  errorMessage.style.display = 'none';
}

function showResults(data) {
  resultPodcastName.textContent = data.podcast_name || 'Unknown';
  resultEpisodeTitle.textContent = data.episode_title || 'Unknown';
  resultSummary.textContent = data.summary || 'No summary available';
  resultBestPart.textContent = data.best_part || 'No highlight extracted';
  resultsSection.style.display = 'block';
  resultsSection.scrollIntoView({ behavior: 'smooth' });
}

function hideResults() {
  resultsSection.style.display = 'none';
}

function showChannelResults(status) {
  // Create channel results section if it doesn't exist
  if (!channelResultsSection) {
    channelResultsSection = document.createElement('div');
    channelResultsSection.id = 'channelResultsSection';
    channelResultsSection.className = 'results-section';
    resultsSection.parentNode.insertBefore(channelResultsSection, resultsSection.nextSibling);
  }

  const successCount = status.results.filter(r => r.status === 'success').length;
  const skippedCount = status.results.filter(r => r.status === 'skipped').length;
  const failedCount = status.results.filter(r => r.status === 'failed').length;

  channelResultsSection.innerHTML = `
    <h2>Channel Processing Complete</h2>
    <div class="result-card">
      <div class="result-item">
        <h3>Summary</h3>
        <p><strong>${successCount}</strong> videos processed successfully</p>
        <p><strong>${skippedCount}</strong> videos skipped (already processed or no subtitles)</p>
        <p><strong>${failedCount}</strong> videos failed</p>
      </div>
      <div class="result-item">
        <h3>Processed Videos</h3>
        <div class="channel-results-list">
          ${status.results.map(r => `
            <div class="channel-result-item ${r.status}">
              <span class="status-icon">${r.status === 'success' ? '✓' : r.status === 'skipped' ? '○' : '✗'}</span>
              <span class="title">${escapeHtml(r.title)}</span>
              ${r.summary ? `<p class="mini-summary">${escapeHtml(r.summary.substring(0, 100))}...</p>` : ''}
              ${r.reason ? `<span class="reason">(${r.reason})</span>` : ''}
              ${r.error ? `<span class="error-reason">(${r.error})</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <button onclick="hideChannelResults(); document.getElementById('podcastForm').scrollIntoView({behavior: 'smooth'});" class="secondary-btn">Process Another Channel</button>
  `;

  channelResultsSection.style.display = 'block';
  channelResultsSection.scrollIntoView({ behavior: 'smooth' });
}

function hideChannelResults() {
  if (channelResultsSection) {
    channelResultsSection.style.display = 'none';
  }
}

async function loadHistory() {
  try {
    const response = await fetch(`${API_BASE}/api/podcasts`);
    const podcasts = await response.json();

    if (podcasts.length === 0) {
      historyList.innerHTML = '<p class="empty-state">No videos analyzed yet. Submit your first one above!</p>';
      return;
    }

    historyList.innerHTML = podcasts.map(podcast => `
      <div class="history-item" onclick="showPodcastDetails(${podcast.id})">
        <h4>${escapeHtml(podcast.episode_title || 'Unknown Title')}</h4>
        <p class="podcast-name">${escapeHtml(podcast.podcast_name || 'Unknown Channel')}</p>
        <p class="date">Processed: ${new Date(podcast.processed_at).toLocaleDateString()}</p>
      </div>
    `).join('');

  } catch (error) {
    historyList.innerHTML = '<p class="loading-text">Failed to load history</p>';
  }
}

async function showPodcastDetails(id) {
  try {
    const response = await fetch(`${API_BASE}/api/podcasts/${id}`);
    const podcast = await response.json();

    showResults({
      podcast_name: podcast.podcast_name,
      episode_title: podcast.episode_title,
      summary: podcast.summary,
      best_part: podcast.best_part
    });

  } catch (error) {
    showError('Failed to load details');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
