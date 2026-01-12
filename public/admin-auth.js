// Admin Authentication Helper
// Include this on all admin pages

const API_BASE = window.location.origin;

// Get stored token
function getAdminToken() {
  return localStorage.getItem('adminToken');
}

// Get stored email
function getAdminEmail() {
  return localStorage.getItem('adminEmail');
}

// Check authentication on page load
async function checkAdminAuth() {
  const token = getAdminToken();

  if (!token) {
    redirectToLogin();
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/api/admin/verify`, {
      headers: { 'X-Admin-Token': token }
    });

    if (!response.ok) {
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminEmail');
      redirectToLogin();
      return false;
    }

    return true;
  } catch (error) {
    console.error('Auth check error:', error);
    redirectToLogin();
    return false;
  }
}

// Redirect to login
function redirectToLogin() {
  window.location.href = 'login.html';
}

// Logout
async function adminLogout() {
  const token = getAdminToken();

  if (token) {
    try {
      await fetch(`${API_BASE}/api/admin/logout`, {
        method: 'POST',
        headers: { 'X-Admin-Token': token }
      });
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminEmail');
  redirectToLogin();
}

// Authenticated fetch helper
async function adminFetch(url, options = {}) {
  const token = getAdminToken();

  if (!token) {
    redirectToLogin();
    throw new Error('Not authenticated');
  }

  const headers = {
    ...options.headers,
    'X-Admin-Token': token
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminEmail');
    redirectToLogin();
    throw new Error('Session expired');
  }

  return response;
}

// Initialize auth check on page load
document.addEventListener('DOMContentLoaded', async () => {
  const isAuthed = await checkAdminAuth();

  if (isAuthed) {
    // Update UI with user email
    const userEmailEl = document.getElementById('userEmail');
    if (userEmailEl) {
      userEmailEl.textContent = getAdminEmail() || '-';
    }

    // Setup logout button
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', adminLogout);
    }
  }
});
