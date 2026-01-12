// DOM Elements
const logsList = document.getElementById('logsList');
const typeFilter = document.getElementById('typeFilter');
const limitFilter = document.getElementById('limitFilter');
const refreshBtn = document.getElementById('refreshBtn');
const autoRefreshBtn = document.getElementById('autoRefreshBtn');
const triggerCronBtn = document.getElementById('triggerCronBtn');
const cronUrl = document.getElementById('cronUrl');
const totalLogs = document.getElementById('totalLogs');
const errorCount = document.getElementById('errorCount');
const processCount = document.getElementById('processCount');
const cronCount = document.getElementById('cronCount');

// Use existing API_BASE if defined by admin-auth.js
if (typeof API_BASE === 'undefined') {
  var API_BASE = window.location.origin;
}

let autoRefreshInterval = null;
let isAutoRefreshing = false;

// Load logs on page load
document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
  updateCronUrl();
});

// Event listeners
refreshBtn.addEventListener('click', loadLogs);
typeFilter.addEventListener('change', loadLogs);
limitFilter.addEventListener('change', loadLogs);

autoRefreshBtn.addEventListener('click', toggleAutoRefresh);
triggerCronBtn.addEventListener('click', triggerCron);

// Update cron URL display
function updateCronUrl() {
  const baseUrl = window.location.origin;
  cronUrl.textContent = `${baseUrl}/api/cron/process-new?secret=YOUR_SECRET`;
}

// Load logs from API
async function loadLogs() {
  const type = typeFilter.value;
  const limit = limitFilter.value;

  try {
    let url = `${API_BASE}/api/logs?limit=${limit}`;
    if (type) {
      url += `&type=${type}`;
    }

    const response = await fetch(url);
    const logs = await response.json();

    renderLogs(logs);
    updateStats(logs);

  } catch (error) {
    logsList.innerHTML = '<p class="loading-text">Failed to load logs</p>';
    console.error('Failed to load logs:', error);
  }
}

// Render logs
function renderLogs(logs) {
  if (logs.length === 0) {
    logsList.innerHTML = '<p class="empty-state">No logs yet. Logs will appear here when the system processes videos or runs cron jobs.</p>';
    return;
  }

  logsList.innerHTML = logs.map(log => {
    const date = new Date(log.timestamp);
    const timeStr = date.toLocaleString();

    let detailsHtml = '';
    if (log.details) {
      const detailsStr = typeof log.details === 'object'
        ? JSON.stringify(log.details)
        : log.details;
      detailsHtml = `<span class="log-details" title="${escapeHtml(detailsStr)}">${escapeHtml(detailsStr)}</span>`;
    }

    return `
      <div class="log-entry">
        <span class="log-timestamp">${timeStr}</span>
        <span class="log-type ${log.type}">${log.type}</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
        ${detailsHtml}
      </div>
    `;
  }).join('');
}

// Update stats
function updateStats(logs) {
  // Get full logs for stats (without type filter)
  fetch(`${API_BASE}/api/logs?limit=500`)
    .then(res => res.json())
    .then(allLogs => {
      totalLogs.textContent = allLogs.length;
      errorCount.textContent = allLogs.filter(l => l.type === 'error').length;
      processCount.textContent = allLogs.filter(l => l.type === 'process').length;
      cronCount.textContent = allLogs.filter(l => l.type === 'cron' && l.message.includes('started')).length;
    });
}

// Toggle auto-refresh
function toggleAutoRefresh() {
  isAutoRefreshing = !isAutoRefreshing;

  if (isAutoRefreshing) {
    autoRefreshBtn.textContent = 'Auto-refresh: ON';
    autoRefreshBtn.classList.add('active');
    autoRefreshInterval = setInterval(loadLogs, 5000);
  } else {
    autoRefreshBtn.textContent = 'Auto-refresh: OFF';
    autoRefreshBtn.classList.remove('active');
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
  }
}

// Trigger cron manually
async function triggerCron() {
  const secret = prompt('Enter cron secret key:');
  if (!secret) return;

  triggerCronBtn.disabled = true;
  triggerCronBtn.textContent = 'Running...';

  try {
    const response = await fetch(`${API_BASE}/api/cron/process-new?secret=${encodeURIComponent(secret)}`);
    const result = await response.json();

    if (response.ok) {
      alert(`Cron completed!\n\nChannels checked: ${result.results.channelsChecked}\nNew videos found: ${result.results.newVideosFound}\nProcessed: ${result.results.videosProcessed}\nSkipped: ${result.results.videosSkipped}\nFailed: ${result.results.videosFailed}`);
      loadLogs();
    } else {
      alert('Error: ' + (result.error || 'Unknown error'));
    }

  } catch (error) {
    alert('Failed to trigger cron: ' + error.message);
  } finally {
    triggerCronBtn.disabled = false;
    triggerCronBtn.textContent = 'Trigger Cron Now';
  }
}

// Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
