// Admin authentication helper
const API_BASE = window.location.origin;

function getAdminToken() {
  return localStorage.getItem('adminToken');
}

function getAdminEmail() {
  return localStorage.getItem('adminEmail');
}

async function checkAdminAuth() {
  const token = getAdminToken();
  if (!token) {
    window.location.href = 'login.html';
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/api/admin/verify`, {
      headers: { 'X-Admin-Token': token }
    });

    if (!response.ok) {
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminEmail');
      window.location.href = 'login.html';
      return false;
    }

    const data = await response.json();
    const emailEl = document.getElementById('userEmail');
    if (emailEl) emailEl.textContent = data.email;
    return true;
  } catch (error) {
    window.location.href = 'login.html';
    return false;
  }
}

async function adminLogout() {
  const token = getAdminToken();
  if (token) {
    await fetch(`${API_BASE}/api/admin/logout`, {
      method: 'POST',
      headers: { 'X-Admin-Token': token }
    });
  }
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminEmail');
  window.location.href = 'login.html';
}

// Auto-check auth on page load
checkAdminAuth();
