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

// API Base URL
const API_BASE = window.location.origin;

// Load history on page load
document.addEventListener('DOMContentLoaded', loadHistory);

// Form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();

  if (!url) {
    showError('Please enter a YouTube URL.');
    return;
  }

  // Validate YouTube URL format
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    showError('Please enter a valid YouTube URL (e.g., https://www.youtube.com/watch?v=...)');
    return;
  }

  // Reset UI
  hideError();
  hideResults();

  // Check if URL already exists
  setLoading(true);
  updateProgress(5, 'Checking if already processed...');
  showProgress();

  try {
    const checkResponse = await fetch(`${API_BASE}/api/check?url=${encodeURIComponent(url)}`);
    const checkData = await checkResponse.json();

    if (checkData.exists) {
      setLoading(false);
      hideProgress();
      showError(`This video has already been processed on ${new Date(checkData.data.processed_at).toLocaleDateString()}. Title: "${checkData.data.episode_title}"`);
      return;
    }

    // Start processing
    updateProgress(10, 'Downloading audio from YouTube...');

    // Start the processing request
    const processPromise = fetch(`${API_BASE}/api/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    });

    // Simulate progress while waiting
    let currentProgress = 10;
    const progressInterval = setInterval(() => {
      if (currentProgress < 90) {
        currentProgress += 2;
        const messages = [
          'Downloading audio from YouTube...',
          'Downloading audio from YouTube...',
          'Downloading audio from YouTube...',
          'Downloading audio from YouTube...',
          'Downloading audio from YouTube...',
          'Preparing audio for analysis...',
          'Preparing audio for analysis...',
          'Uploading to Gemini AI...',
          'Uploading to Gemini AI...',
          'Gemini is listening...',
          'Gemini is listening...',
          'Gemini is listening...',
          'Gemini is listening...',
          'Gemini is listening...',
          'Transcribing audio...',
          'Transcribing audio...',
          'Transcribing audio...',
          'Analyzing content...',
          'Analyzing content...',
          'Identifying key insights...',
          'Identifying key insights...',
          'Extracting best moments...',
          'Extracting best moments...',
          'Generating summary...',
          'Generating summary...',
          'Preparing results...',
          'Preparing results...',
          'Almost done...',
          'Almost done...',
          'Finalizing...'
        ];
        const msgIndex = Math.min(Math.floor((currentProgress - 10) / 3), messages.length - 1);
        updateProgress(currentProgress, messages[msgIndex]);
      }
    }, 3000);

    const processResponse = await processPromise;
    const processData = await processResponse.json();
    clearInterval(progressInterval);

    if (!processResponse.ok) {
      throw new Error(processData.error || 'Failed to process video');
    }

    updateProgress(95, 'Saving to database...');
    await sleep(300);

    updateProgress(100, 'Complete!');
    await sleep(500);

    // Show results
    hideProgress();
    showResults(processData.data);

    // Reload history
    loadHistory();

    // Clear form
    form.reset();

  } catch (error) {
    hideProgress();
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

// New analysis button
newAnalysisBtn.addEventListener('click', () => {
  hideResults();
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
