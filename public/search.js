// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const tagsCloud = document.getElementById('tagsCloud');
const resultsSection = document.getElementById('resultsSection');
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');

const API_BASE = window.location.origin;

// Footer elements
const totalEpisodes = document.getElementById('totalEpisodes');

// Sort elements
const sortRelevanceBtn = document.getElementById('sortRelevance');
const sortNewestBtn = document.getElementById('sortNewest');
const channelFilters = document.getElementById('channelFilters');
let currentResults = [];
let currentQuery = '';
let currentSort = 'relevance';
let currentChannelFilter = 'all';

// Language selection
let currentLanguage = 'en';

// Get language display name
function getLanguageDisplayName(lang) {
  const names = {
    'en': 'English',
    'fr': 'Français'
  };
  return names[lang] || lang.toUpperCase();
}

// Set language and reload content
function setLanguage(lang) {
  currentLanguage = lang;

  // Update button states
  document.querySelectorAll('.language-toggle-header .lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  // Reload popular tags for the selected language
  loadPopularTags();

  // Reload indexed stats for the selected language
  loadIndexedStats();

  // If there's a current search, re-run it with new language
  if (currentQuery) {
    performSearch(currentQuery);
  }
}

// Sort results
function sortResults(sortType) {
  if (currentResults.length === 0) return;

  currentSort = sortType;

  // Update button states
  sortRelevanceBtn.classList.toggle('active', sortType === 'relevance');
  sortNewestBtn.classList.toggle('active', sortType === 'newest');

  // Apply filter and sort, then render
  renderFilteredResults();
}

// Filter by channel
function filterByChannel(channel) {
  currentChannelFilter = channel;

  // Update button states
  document.querySelectorAll('.channel-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.channel === channel);
  });

  // Apply filter and sort, then render
  renderFilteredResults();
}

// Render results with current filter and sort
function renderFilteredResults() {
  // Filter by channel
  let filteredResults = currentChannelFilter === 'all'
    ? [...currentResults]
    : currentResults.filter(r => r.podcast_name === currentChannelFilter);

  // Sort the results
  if (currentSort === 'relevance') {
    filteredResults.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
  } else if (currentSort === 'newest') {
    filteredResults.sort((a, b) => {
      const dateA = a.upload_date ? new Date(a.upload_date) : new Date(a.processed_at || 0);
      const dateB = b.upload_date ? new Date(b.upload_date) : new Date(b.processed_at || 0);
      return dateB - dateA;
    });
  }

  // Update count
  const totalCount = currentResults.length;
  const filteredCount = filteredResults.length;
  if (currentChannelFilter === 'all') {
    resultsCount.textContent = `${totalCount} result${totalCount !== 1 ? 's' : ''}`;
  } else {
    resultsCount.textContent = `${filteredCount} of ${totalCount} result${totalCount !== 1 ? 's' : ''}`;
  }

  // Render results
  if (filteredResults.length === 0) {
    resultsList.innerHTML = `
      <div class="no-results">
        <h3>No results in this channel</h3>
        <p>Try selecting "All" or a different channel</p>
      </div>
    `;
  } else {
    resultsList.innerHTML = filteredResults.map(episode => createEpisodeCard(episode, currentQuery)).join('');
  }
}

// Build channel filter buttons from results
function buildChannelFilters(results) {
  // Get unique channels with counts
  const channelCounts = {};
  results.forEach(r => {
    const channel = r.podcast_name || 'Unknown';
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;
  });

  // Sort channels alphabetically
  const channels = Object.keys(channelCounts).sort((a, b) => a.localeCompare(b));

  // Build buttons: "All" first, then channels
  let html = `<button class="channel-filter-btn active" data-channel="all" onclick="filterByChannel('all')">All (${results.length})</button>`;

  channels.forEach(channel => {
    const escapedChannel = escapeHtml(channel).replace(/'/g, "\\'");
    html += `<button class="channel-filter-btn" data-channel="${escapeHtml(channel)}" onclick="filterByChannel('${escapedChannel}')">${escapeHtml(channel)} (${channelCounts[channel]})</button>`;
  });

  channelFilters.innerHTML = html;
}

// Load data on page load
document.addEventListener('DOMContentLoaded', () => {
  loadPopularTags();
  loadIndexedStats();

  // Check for search query in URL
  const params = new URLSearchParams(window.location.search);
  const query = params.get('q');
  if (query) {
    searchInput.value = query;
    performSearch(query);
  }
});

// Search form submission
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (query) {
    performSearch(query);
    // Update URL
    window.history.pushState({}, '', `?q=${encodeURIComponent(query)}`);
  }
});

// Load popular tags (no size highlighting)
async function loadPopularTags() {
  tagsCloud.innerHTML = '<p class="loading-text">Loading popular topics...</p>';

  try {
    const response = await fetch(`${API_BASE}/api/keywords?limit=30&lang=${currentLanguage}`);
    const keywords = await response.json();

    if (keywords.length === 0) {
      tagsCloud.innerHTML = '<p class="empty-state">No keywords yet. Process content with AI first!</p>';
      return;
    }

    tagsCloud.innerHTML = keywords.map(keyword => {
      return `
        <a href="#" class="tag" onclick="searchByTag('${escapeHtml(keyword.keyword)}'); return false;">
          ${escapeHtml(keyword.keyword)}
        </a>
      `;
    }).join('');

  } catch (error) {
    tagsCloud.innerHTML = '<p class="loading-text">Failed to load topics</p>';
    console.error('Failed to load tags:', error);
  }
}

// Search by clicking a tag
function searchByTag(tag) {
  searchInput.value = tag;
  performSearch(tag);
  window.history.pushState({}, '', `?q=${encodeURIComponent(tag)}`);
}

// Perform search
async function performSearch(query) {
  setLoading(true);
  resultsSection.style.display = 'block';
  resultsList.innerHTML = '<p class="loading-text">Searching...</p>';
  channelFilters.innerHTML = '';

  try {
    const response = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}&lang=${currentLanguage}`);
    const results = await response.json();

    // Store results for sorting
    currentResults = results;
    currentQuery = query;
    currentSort = 'relevance';
    currentChannelFilter = 'all';

    // Reset sort buttons
    sortRelevanceBtn.classList.add('active');
    sortNewestBtn.classList.remove('active');

    if (results.length === 0) {
      resultsList.innerHTML = `
        <div class="no-results">
          <h3>No results found</h3>
          <p>Try different keywords or browse the popular topics above</p>
        </div>
      `;
      resultsCount.textContent = '0 results';
      channelFilters.innerHTML = '';
    } else {
      resultsCount.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
      buildChannelFilters(results);
      resultsList.innerHTML = results.map(episode => createEpisodeCard(episode, query)).join('');
    }

  } catch (error) {
    resultsList.innerHTML = '<p class="loading-text">Search failed. Please try again.</p>';
    channelFilters.innerHTML = '';
    console.error('Search error:', error);
  } finally {
    setLoading(false);
    scrollToResults();
  }
}

// Create episode card HTML
function createEpisodeCard(episode, searchQuery = null) {
  const keywords = episode.keywords ? episode.keywords.split(',').slice(0, 5) : [];
  const hasSnippets = episode.context_snippets && episode.context_snippets.length > 0;

  // Decode any HTML entities that might be in the data, then escape for safe display
  let summary = decodeHtmlEntities(episode.summary) || 'No summary available';
  const title = decodeHtmlEntities(episode.episode_title) || 'Unknown Title';

  // Highlight search terms in summary if provided
  if (searchQuery) {
    const terms = searchQuery.toLowerCase().split(/\s+/);
    terms.forEach(term => {
      if (term.length > 2) {
        const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
        summary = summary.replace(regex, '<span class="highlight">$1</span>');
      }
    });
  }

  // Build context snippets HTML with highlighting
  let snippetsHtml = '';
  if (hasSnippets) {
    snippetsHtml = `
      <div class="context-snippets">
        <p class="snippets-label">Found in transcript:</p>
        ${episode.context_snippets.map(snippet => {
          // Decode then escape to handle any stored HTML entities
          let text = escapeHtml(decodeHtmlEntities(snippet.text));
          // Highlight the matched term
          if (snippet.matchedTerm) {
            const regex = new RegExp(`(${escapeRegex(snippet.matchedTerm)})`, 'gi');
            text = text.replace(regex, '<span class="highlight">$1</span>');
          }
          return `<p class="snippet">"${text}"</p>`;
        }).join('')}
      </div>
    `;
  }

  // Generate thumbnail HTML
  const thumbnailHtml = episode.thumbnail_url
    ? `<img src="${episode.thumbnail_url}" alt="${escapeHtml(title)}" class="episode-thumbnail" loading="lazy">`
    : `<div class="episode-thumbnail placeholder"><span>No thumbnail</span></div>`;

  // Generate Spotify search URL
  const spotifySearchUrl = episode.spotify_search_url || `https://open.spotify.com/search/${encodeURIComponent(title)}`;

  // Format upload date
  const uploadDateStr = episode.upload_date
    ? new Date(episode.upload_date).toLocaleDateString(currentLanguage === 'fr' ? 'fr-FR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return `
    <div class="episode-card">
      <div class="episode-card-content">
        <div class="episode-thumbnail-wrapper">
          ${thumbnailHtml}
        </div>
        <div class="episode-details">
          <div class="episode-card-header">
            <h3>${escapeHtml(title)}</h3>
            ${episode.podcast_name ? `<p class="channel-name">${escapeHtml(episode.podcast_name)}</p>` : ''}
            <div class="episode-meta">
              ${uploadDateStr ? `<span class="upload-date">${uploadDateStr}</span>` : ''}
              ${episode.relevance_score ? `<span class="relevance-badge">${Math.round(episode.relevance_score)}% match</span>` : ''}
            </div>
          </div>
          <p class="summary">${summary}</p>
          ${snippetsHtml}
          ${keywords.length > 0 ? `
            <div class="keywords">
              ${keywords.map(k => {
                return `<span class="keyword">${escapeHtml(k.trim())}</span>`;
              }).join('')}
            </div>
          ` : ''}
          <div class="episode-links">
            <a href="${episode.spotify_url}" target="_blank" rel="noopener" class="episode-link youtube">
              <span class="link-icon">&#9658;</span> YouTube
            </a>
            <a href="${spotifySearchUrl}" target="_blank" rel="noopener" class="episode-link spotify">
              <span class="link-icon">&#9835;</span> Search on Spotify
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Helper functions
function setLoading(loading) {
  searchBtn.disabled = loading;
  searchBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  searchBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Decode HTML entities (for data that may have been stored with encoded entities)
function decodeHtmlEntities(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.innerHTML = text;
  return div.textContent;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrollToResults() {
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Clear search
function clearSearch() {
  searchInput.value = '';
  resultsSection.style.display = 'none';
  window.history.pushState({}, '', window.location.pathname);
}

// Handle back button
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const query = params.get('q');
  if (query) {
    searchInput.value = query;
    performSearch(query);
  } else {
    clearSearch();
  }
});

// ============================================
// INDEXED STATS (Footer)
// ============================================

// Load indexed stats
async function loadIndexedStats() {
  try {
    const response = await fetch(`${API_BASE}/api/indexed-stats?lang=${currentLanguage}`);
    const stats = await response.json();

    totalEpisodes.textContent = stats.total_episodes.toLocaleString();

    // Update language indicator in footer
    const langIndicator = document.getElementById('footerLangIndicator');
    if (langIndicator) {
      langIndicator.textContent = getLanguageDisplayName(currentLanguage);
    }
  } catch (error) {
    console.error('Failed to load indexed stats:', error);
    totalEpisodes.textContent = '?';
  }
}

// ============================================
// SUGGEST PODCAST DIALOG
// ============================================

const suggestDialog = document.getElementById('suggestDialog');
const suggestForm = document.getElementById('suggestForm');

function openSuggestDialog() {
  suggestDialog.showModal();
}

function closeSuggestDialog() {
  suggestDialog.close();
  suggestForm.reset();
}

// Close dialog when clicking outside
suggestDialog.addEventListener('click', (e) => {
  if (e.target === suggestDialog) {
    closeSuggestDialog();
  }
});

// Close dialog with Escape key
suggestDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSuggestDialog();
  }
});

async function submitSuggestion(event) {
  event.preventDefault();

  const submitBtn = document.getElementById('submitSuggestBtn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnLoading = submitBtn.querySelector('.btn-loading');

  // Check honeypot field (bots will fill this)
  const honeypot = document.getElementById('website').value;
  if (honeypot) {
    // Bot detected - pretend success but don't send
    alert('Thank you for your suggestion!');
    closeSuggestDialog();
    return;
  }

  // Get form data
  const formData = {
    fullName: document.getElementById('fullName').value.trim(),
    email: document.getElementById('email').value.trim(),
    youtubeUrl: document.getElementById('youtubeUrl').value.trim(),
    language: document.getElementById('language').value,
    reason: document.getElementById('reason').value.trim()
  };

  // Validate YouTube URL
  if (!formData.youtubeUrl.includes('youtube.com') && !formData.youtubeUrl.includes('youtu.be')) {
    alert('Please enter a valid YouTube URL');
    return;
  }

  // Show loading state
  submitBtn.disabled = true;
  btnText.style.display = 'none';
  btnLoading.style.display = 'inline';

  try {
    const response = await fetch(`${API_BASE}/api/suggest-podcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formData)
    });

    const result = await response.json();

    if (response.ok) {
      alert('Thank you for your suggestion! We will review it soon.');
      closeSuggestDialog();
    } else {
      alert('Error: ' + (result.error || 'Failed to submit suggestion'));
    }
  } catch (error) {
    console.error('Suggestion error:', error);
    alert('Failed to submit suggestion. Please try again later.');
  } finally {
    submitBtn.disabled = false;
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
  }
}
