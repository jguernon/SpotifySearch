// Admin Dashboard

// Load dashboard data
async function loadDashboard() {
  await loadStats();
  await loadRecentLogs();
}

// Load stats
async function loadStats() {
  try {
    // Get AI status for stats
    const response = await fetch(`${API_BASE}/api/ai-status`);
    const status = await response.json();

    document.getElementById('totalKeywords').textContent = status.total_keywords || 0;
    document.getElementById('totalVideos').textContent = status.videos_analyzed || 0;

    // Get channels count
    const channelsResponse = await fetch(`${API_BASE}/api/channels`);
    const channels = await channelsResponse.json();

    document.getElementById('totalChannels').textContent = channels.length || 0;

    // Calculate skipped
    const skippedTotal = channels.reduce((sum, ch) => sum + (ch.videos_skipped || 0), 0);
    document.getElementById('totalSkipped').textContent = skippedTotal;

  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Load recent logs
async function loadRecentLogs() {
  const recentLogs = document.getElementById('recentLogs');

  try {
    const response = await fetch(`${API_BASE}/api/logs?limit=10`);
    const logs = await response.json();

    if (logs.length === 0) {
      recentLogs.innerHTML = '<p class="empty-state">No recent activity</p>';
      return;
    }

    recentLogs.innerHTML = logs.map(log => {
      const date = new Date(log.timestamp);
      const timeStr = date.toLocaleString();

      return `
        <div class="log-entry">
          <span class="log-timestamp">${timeStr}</span>
          <span class="log-type ${log.type}">${log.type}</span>
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>
      `;
    }).join('');

  } catch (error) {
    recentLogs.innerHTML = '<p class="loading-text">Failed to load logs</p>';
    console.error('Failed to load logs:', error);
  }
}

// Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Load dashboard when auth is confirmed
document.addEventListener('DOMContentLoaded', () => {
  // Wait a bit for auth check to complete
  setTimeout(loadDashboard, 100);
});
