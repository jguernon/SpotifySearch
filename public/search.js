// DOM Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const tagsCloud = document.getElementById('tagsCloud');
const resultsSection = document.getElementById('resultsSection');
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');
const allVideosSection = document.getElementById('allVideosSection');
const allVideosList = document.getElementById('allVideosList');
const loadMoreBtn = document.getElementById('loadMoreBtn');

const API_BASE = window.location.origin;
let currentPage = 0;
const PAGE_SIZE = 20;

// Load data on page load
document.addEventListener('DOMContentLoaded', () => {
  loadPopularTags();
  loadRecentVideos();

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

// Load more button
loadMoreBtn.addEventListener('click', () => {
  currentPage++;
  loadRecentVideos(true);
});

// Load popular tags
async function loadPopularTags() {
  tagsCloud.innerHTML = '<p class="loading-text">Loading popular topics...</p>';

  try {
    const response = await fetch(`${API_BASE}/api/keywords?limit=30`);
    const keywords = await response.json();

    if (keywords.length === 0) {
      tagsCloud.innerHTML = '<p class="empty-state">No keywords yet. Process videos with AI first!</p>';
      return;
    }

    // Find max count for sizing
    const maxCount = Math.max(...keywords.map(k => k.count));

    tagsCloud.innerHTML = keywords.map(keyword => {
      const ratio = keyword.count / maxCount;
      let sizeClass = '';
      if (ratio > 0.7) sizeClass = 'large';
      else if (ratio > 0.4) sizeClass = 'medium';

      return `
        <a href="#" class="tag ${sizeClass}" onclick="searchByTag('${escapeHtml(keyword.keyword)}'); return false;">
          ${escapeHtml(keyword.keyword)}
          <span class="tag-count">(${keyword.count})</span>
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
  allVideosSection.style.display = 'none';
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
      resultsList.innerHTML = results.map(video => createVideoCard(video, query)).join('');
    }

  } catch (error) {
    resultsList.innerHTML = '<p class="loading-text">Search failed. Please try again.</p>';
    console.error('Search error:', error);
  } finally {
    setLoading(false);
  }
}

// Load recent videos
async function loadRecentVideos(append = false) {
  if (!append) {
    currentPage = 0;
    allVideosList.innerHTML = '<p class="loading-text">Loading videos...</p>';
  }

  try {
    const response = await fetch(`${API_BASE}/api/podcasts?limit=${PAGE_SIZE}&offset=${currentPage * PAGE_SIZE}`);
    const videos = await response.json();

    if (videos.length === 0 && currentPage === 0) {
      allVideosList.innerHTML = '<p class="empty-state">No videos yet. Start by processing some YouTube videos!</p>';
      loadMoreBtn.style.display = 'none';
      return;
    }

    const html = videos.map(video => createVideoCard(video)).join('');

    if (append) {
      allVideosList.innerHTML += html;
    } else {
      allVideosList.innerHTML = html;
    }

    loadMoreBtn.style.display = videos.length === PAGE_SIZE ? 'block' : 'none';

  } catch (error) {
    if (!append) {
      allVideosList.innerHTML = '<p class="loading-text">Failed to load videos</p>';
    }
    console.error('Failed to load videos:', error);
  }
}

// Create video card HTML
function createVideoCard(video, searchQuery = null) {
  const keywords = video.keywords ? video.keywords.split(',').slice(0, 5) : [];
  const hasSnippets = video.context_snippets && video.context_snippets.length > 0;

  let summary = video.summary || 'No summary available';

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
        ${video.context_snippets.map(snippet => {
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
  const thumbnailHtml = video.thumbnail_url
    ? `<img src="${video.thumbnail_url}" alt="${escapeHtml(video.episode_title)}" class="video-thumbnail" loading="lazy">`
    : `<div class="video-thumbnail placeholder"><span>No thumbnail</span></div>`;

  // Generate Spotify search URL
  const spotifySearchUrl = video.spotify_search_url || `https://open.spotify.com/search/${encodeURIComponent(video.episode_title || '')}`;

  return `
    <div class="video-card">
      <div class="video-card-content">
        <div class="video-thumbnail-wrapper">
          ${thumbnailHtml}
        </div>
        <div class="video-details">
          <div class="video-card-header">
            <h3>${escapeHtml(video.episode_title || 'Unknown Title')}</h3>
            ${video.relevance_score ? `<span class="relevance-badge">${Math.round(video.relevance_score)}% match</span>` : ''}
          </div>
          <p class="channel-name">${escapeHtml(video.podcast_name || 'Unknown Channel')}</p>
          <p class="summary">${summary}</p>
          ${snippetsHtml}
          ${keywords.length > 0 ? `
            <div class="keywords">
              ${keywords.map(k => {
                const isMatch = searchQuery && searchQuery.toLowerCase().includes(k.trim().toLowerCase());
                return `<span class="keyword ${isMatch ? 'match' : ''}">${escapeHtml(k.trim())}</span>`;
              }).join('')}
            </div>
          ` : ''}
          <div class="video-links">
            <a href="${video.spotify_url}" target="_blank" rel="noopener" class="video-link youtube">
              <span class="link-icon">&#9658;</span> YouTube
            </a>
            <a href="${spotifySearchUrl}" target="_blank" rel="noopener" class="video-link spotify">
              <span class="link-icon">&#9835;</span> Search on Spotify
            </a>
          </div>
          <p class="date">Processed: ${new Date(video.processed_at).toLocaleDateString()}</p>
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

// Clear search and show all videos
function clearSearch() {
  searchInput.value = '';
  resultsSection.style.display = 'none';
  allVideosSection.style.display = 'block';
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
