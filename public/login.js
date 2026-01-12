// Admin Login

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');

const API_BASE = window.location.origin;

// Check if already logged in
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('adminToken');
  if (token) {
    verifyAndRedirect(token);
  }
});

// Verify token and redirect if valid
async function verifyAndRedirect(token) {
  try {
    const response = await fetch(`${API_BASE}/api/admin/verify`, {
      headers: { 'X-Admin-Token': token }
    });

    if (response.ok) {
      // Token is valid, redirect to admin
      window.location.href = 'admin.html';
    } else {
      // Token is invalid, clear it
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminEmail');
    }
  } catch (error) {
    console.error('Verify error:', error);
  }
}

// Login form submission
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('Please enter email and password');
    return;
  }

  setLoading(true);
  hideError();

  try {
    const response = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      // Store token
      localStorage.setItem('adminToken', data.token);
      localStorage.setItem('adminEmail', data.email);

      // Redirect to admin
      window.location.href = 'admin.html';
    } else {
      showError(data.error || 'Login failed');
    }

  } catch (error) {
    showError('Connection error. Please try again.');
    console.error('Login error:', error);
  } finally {
    setLoading(false);
  }
});

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
}

function hideError() {
  errorMessage.style.display = 'none';
}

function setLoading(loading) {
  loginBtn.disabled = loading;
  loginBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  loginBtn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}
