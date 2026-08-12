// ── Galv/Painting Tracker — shared.js — v1.0 ─────────────────────────
// Common plumbing shared by the launcher and both booking apps: Google
// sign-in, session storage, talking to the backend, on-device (offline)
// storage, and small reusable helpers. Keeping this in one file means a
// fix here applies to every app automatically, instead of needing the
// same fix copied into several places.
//
// Any page using this file needs these elements present in its HTML
// (even if just hidden) for the shared sign-in code to work:
//   #accessGate, #gateError, #gateSignInBtn, #companyLabel,
//   #googleStatus, #signInBtn, #offlineBanner (optional)
// And, if it shows messages: #successMsg, #errorMsg

const CLIENT_ID = '748854288515-9f4gpar0877eca3uteg501tr88qn2fkf.apps.googleusercontent.com';
const SCOPES    = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const PROXY_URL = 'https://goods-tracker.ullrsystem.workers.dev';

let interactiveTokenClient, silentTokenClient, pendingSilentRefreshResolve = null;
let accessToken = null, currentUser = null;

function proxyFetch(body) {
  return fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    body: JSON.stringify(body),
  });
}

// ── Session — shared across every page on this domain ─────────────────
function saveSession(email, company, token, name, label) {
  localStorage.setItem('goodsTrackerSession', JSON.stringify({ email, company, token, name, label, expiry: Date.now() + 7*24*60*60*1000 }));
}
function loadSession() {
  try {
    const raw = localStorage.getItem('goodsTrackerSession');
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (Date.now() > s.expiry) { localStorage.removeItem('goodsTrackerSession'); return null; }
    return s;
  } catch (e) { return null; }
}
function clearSession() { localStorage.removeItem('goodsTrackerSession'); }
function signOutLocally() { clearSession(); accessToken = null; currentUser = null; }

function attemptSilentRefresh(timeoutMs) {
  return new Promise((resolve) => {
    if (!silentTokenClient) { resolve(false); return; }
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; pendingSilentRefreshResolve = null; resolve(val); };
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    pendingSilentRefreshResolve = (val) => { clearTimeout(timeoutId); finish(val); };
    try { silentTokenClient.requestAccessToken({ prompt: '' }); } catch (e) { finish(false); }
  });
}
async function ensureFreshToken() {
  if (await attemptSilentRefresh(10000)) return true;
  if (await attemptSilentRefresh(10000)) return true;
  return !!accessToken;
}
async function proxyFetchJson(body) {
  let res = await proxyFetch(body);
  let json = await res.json();
  if (json && json.error && /invalid|expired/i.test(json.error)) {
    if (await ensureFreshToken()) { res = await proxyFetch(body); json = await res.json(); }
  }
  return json;
}

function showSignInGate(message) {
  updateGoogleStatus(false);
  const label = document.getElementById('companyLabel');
  if (label) label.textContent = 'Not signed in';
  document.getElementById('accessGate').style.display = 'flex';
  if (message) showGateError(message);
}

// Each page defines its own window.onSessionReady() for what should
// happen once sign-in is confirmed — e.g. the launcher routes to a
// system, Galv/Painting sync and load their pending list.
async function applySession(email, company, token, name, label) {
  accessToken = token;
  currentUser = { email, company, name, label };
  document.getElementById('accessGate').style.display = 'none';
  const companyLabelEl = document.getElementById('companyLabel');
  if (companyLabelEl) companyLabelEl.textContent = (label || company || 'Signed in') + ' — ' + email;
  updateGoogleStatus(true);
  if (typeof window.onSessionReady === 'function') await window.onSessionReady();
}

async function handleTokenResponse(tokenResponse) {
  if (tokenResponse.error) { showGateError('Sign-in failed: ' + tokenResponse.error); return; }
  accessToken = tokenResponse.access_token;
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
    const info = await resp.json();
    const email = (info.email || '').toLowerCase().trim();
    showGateError('Verifying access...');
    const verifyResp = await proxyFetch({ action: 'verifyUser', email });
    const user = await verifyResp.json();
    if (!user.approved) { accessToken = null; showGateError('Access denied. ' + (user.reason || 'Contact your administrator.')); return; }
    saveSession(email, user.company, accessToken, user.name, user.label);
    applySession(email, user.company, accessToken, user.name, user.label);
  } catch (err) { showGateError('Could not verify your account. Please try again.'); }
}

function showGateError(msg) {
  const el = document.getElementById('gateError');
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
}

function updateGoogleStatus(connected) {
  const statusEl = document.getElementById('googleStatus');
  const signInBtn = document.getElementById('signInBtn');
  const banner = document.getElementById('offlineBanner');
  if (!statusEl) return;
  if (connected) {
    statusEl.innerHTML = '<span class="google-connected">✅ Connected to Google Drive</span>';
    if (signInBtn) signInBtn.classList.add('hidden');
    if (banner) banner.style.display = 'none';
  } else {
    statusEl.innerHTML = '<span class="google-disconnected">📴 Not connected</span>';
    if (signInBtn) signInBtn.classList.remove('hidden');
    if (banner) banner.style.display = 'block';
  }
}

function gisLoaded() {
  interactiveTokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: handleTokenResponse });
  silentTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: (resp) => {
      const resolve = pendingSilentRefreshResolve; pendingSilentRefreshResolve = null;
      if (resp.error) { resolve && resolve(false); return; }
      accessToken = resp.access_token;
      if (currentUser) saveSession(currentUser.email, currentUser.company, accessToken, currentUser.name, currentUser.label);
      resolve && resolve(true);
    },
  });
  const gateBtn = document.getElementById('gateSignInBtn');
  const signInBtn = document.getElementById('signInBtn');
  if (gateBtn) gateBtn.addEventListener('click', () => interactiveTokenClient.requestAccessToken({ prompt: 'select_account' }));
  if (signInBtn) signInBtn.addEventListener('click', () => interactiveTokenClient.requestAccessToken({ prompt: 'select_account' }));

  const session = loadSession();
  if (session) {
    applySession(session.email, session.company, session.token, session.name, session.label);
    verifySessionOnLoad();
  } else if (typeof window.onNoSession === 'function') {
    window.onNoSession();
  }
}
async function verifySessionOnLoad() {
  const ok = await ensureFreshToken();
  if (ok) return;
  signOutLocally();
  showSignInGate('Your session expired — please sign in again to continue.');
}

function waitForGIS(n) {
  if (typeof google !== 'undefined' && google.accounts) { gisLoaded(); }
  else if (n > 0) { setTimeout(() => waitForGIS(n - 1), 500); }
  else {
    const el = document.getElementById('gateError');
    if (el) { el.textContent = 'Google sign-in could not load. Please check your connection and refresh.'; el.style.display = 'block'; }
  }
}

// ── IndexedDB — local queue of items booked out (photo + details), a
// cache of the pending-return list, and a queue for offline book-ins.
// Shared database so Galv and Painting each get their own separate
// data within it (every record is tagged with which system it belongs
// to by the page that stores it).
const DB_NAME = 'GoodsTrackerDB', DB_VERSION = 2, STORE_NAME = 'outbound';
const CACHE_STORE = 'pendingCache';
const QUEUE_STORE = 'bookInQueue';
let db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME))  database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(QUEUE_STORE)) database.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}
async function addOutboundRecord(rec) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
async function getAllOutboundRecords() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function updateOutboundRecord(rec) { return addOutboundRecord(rec); }

async function putRecord(storeName, rec) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
async function getAllRecords(storeName) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function deleteRecord(storeName, id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
async function clearStore(storeName) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Small helpers used across both booking apps ────────────────────────
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(dataUrl) { const res = await fetch(dataUrl); return await res.blob(); }

function compressImageFile(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.60));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  });
}

// Drive's normal "view" link opens a full webpage, not a raw image, so it
// can't be used directly as a photo. This pulls the file ID out of that
// link and builds Google's actual image-serving address instead (the
// same one Drive/Photos use for their own thumbnails).
function driveImageUrl(viewUrl, size) {
  if (!viewUrl) return '';
  const match = viewUrl.match(/\/d\/([^/]+)/);
  if (!match) return '';
  return `https://lh3.googleusercontent.com/d/${match[1]}=w${size || 200}`;
}

function showMessage(type, text) {
  const successMsg = document.getElementById('successMsg');
  const errorMsg = document.getElementById('errorMsg');
  if (!successMsg || !errorMsg) return;
  if (type === 'success') {
    successMsg.textContent = text; successMsg.classList.add('show'); errorMsg.classList.remove('show');
    setTimeout(() => successMsg.classList.remove('show'), 3000);
  } else {
    errorMsg.textContent = text; errorMsg.classList.add('show'); successMsg.classList.remove('show');
    setTimeout(() => errorMsg.classList.remove('show'), 4000);
  }
}
