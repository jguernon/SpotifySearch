// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const tagsCloud = document.getElementById('tagsCloud');
const resultsSection = document.getElementById('resultsSection');
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');

const API_BASE = window.location.origin;

// Load data on page load
document.addEventListener('DOMContentLoaded', () => {
  loadPopularTags();

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
    const response = await fetch(`${API_BASE}/api/keywords?limit=30`);
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

  try {
    const response = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`);
    const results = await response.json();

    if (results.length === 0) {
      resultsList.innerHTML = `
        <div class="no-results">
          <h3>No results found</h3>
          <p>Try different keywords or browse the popular topics above</p>
        </div>
      `;
      resultsCount.textContent = '0 results';
    } else {
      resultsCount.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
      resultsList.innerHTML = results.map(episode => createEpisodeCard(episode, query)).join('');
    }

  } catch (error) {
    resultsList.innerHTML = '<p class="loading-text">Search failed. Please try again.</p>';
    console.error('Search error:', error);
  } finally {
    setLoading(false);
  }
}

// Create episode card HTML
function createEpisodeCard(episode, searchQuery = null) {
  const keywords = episode.keywords ? episode.keywords.split(',').slice(0, 5) : [];
  const hasSnippets = episode.context_snippets && episode.context_snippets.length > 0;

  let summary = episode.summary || 'No summary available';

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
          let text = escapeHtml(snippet.text);
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
    ? `<img src="${episode.thumbnail_url}" alt="${escapeHtml(episode.episode_title)}" class="episode-thumbnail" loading="lazy">`
    : `<div class="episode-thumbnail placeholder"><span>No thumbnail</span></div>`;

  // Generate Spotify search URL
  const spotifySearchUrl = episode.spotify_search_url || `https://open.spotify.com/search/${encodeURIComponent(episode.episode_title || '')}`;

  return `
    <div class="episode-card">
      <div class="episode-card-content">
        <div class="episode-thumbnail-wrapper">
          ${thumbnailHtml}
        </div>
        <div class="episode-details">
          <div class="episode-card-header">
            <h3>${escapeHtml(episode.episode_title || 'Unknown Title')}</h3>
            ${episode.relevance_score ? `<span class="relevance-badge">${Math.round(episode.relevance_score)}% match</span>` : ''}
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

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
