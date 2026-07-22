'use strict';

// ===========================================================================
// SpotifyJukebox — runs ONLY on the table device.
// Authorization Code + PKCE (no client secret) + Web Playback SDK.
// Plays full tracks; requires the logged-in account to be Spotify Premium.
// ===========================================================================

const SpotifyJukebox = (() => {
  const TOK_KEY = 'hitbeat:spotify:tokens';
  const VER_KEY = 'hitbeat:spotify:verifier';
  const ST_KEY = 'hitbeat:spotify:state';

  let cfg = { clientId: '', redirectUri: '', scopes: '', configured: false };
  let player = null;
  let deviceId = null;
  let ready = false;
  let playing = false;
  let lastError = null;
  let lastFailedCard = null; // { card, reason, detail } — surfaced once per failure, then cleared
  let tokenDelivered = false; // did the SDK's getOAuthToken callback actually receive a token?
  let onState = () => {};

  // Ring buffer of the SDK lifecycle so the table can SHOW what happened
  // on-screen (no DevTools needed) when the player won't start.
  const diagLines = [];
  function log(msg) {
    console.log('[Hitbeat] ' + msg);
    diagLines.push(msg);
    if (diagLines.length > 14) diagLines.shift();
    emit();
  }

  // Spotify's Web Playback SDK works in Chrome, Edge, Firefox AND Safari — so we
  // do NOT block any browser. But if the player fails to start, "try Chrome" is a
  // useful last-resort hint for the flakier engines, so this returns a soft note
  // (never a hard block) folded into the stall diagnostic.
  function browserFallbackHint() {
    const ua = navigator.userAgent;
    const isChromium = /Chrome\//.test(ua) || /Edg\//.test(ua);
    if (isChromium) return '';
    return ' If it still won’t start, try opening the table in Google Chrome.';
  }

  // ---- PKCE helpers -------------------------------------------------------
  function randString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(arr, (b) => chars[b % chars.length]).join('');
  }
  async function sha256b64url(str) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---- token storage ------------------------------------------------------
  function saveTokens(t) {
    const expires_at = Date.now() + (t.expires_in || 3600) * 1000;
    const prev = getTokens() || {};
    localStorage.setItem(TOK_KEY, JSON.stringify({
      access_token: t.access_token,
      refresh_token: t.refresh_token || prev.refresh_token,
      expires_at,
    }));
  }
  function getTokens() { try { return JSON.parse(localStorage.getItem(TOK_KEY)); } catch { return null; } }
  function clearTokens() { localStorage.removeItem(TOK_KEY); }

  async function getValidToken() {
    const t = getTokens();
    if (!t) return null;
    if (t.expires_at - Date.now() > 30000) return t.access_token;
    // refresh
    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: cfg.clientId }),
      });
      if (!res.ok) throw new Error('refresh failed');
      const data = await res.json();
      saveTokens(data);
      return data.access_token;
    } catch (e) {
      // The refresh token is dead (expired/revoked). Drop it AND surface the
      // state — otherwise the UI stays stuck on "Starting player…" with a
      // token it silently just cleared, and no Connect button to recover.
      clearTokens();
      ready = false;
      lastError = 'Spotify session expired — click Connect to sign in again.';
      emit();
      return null;
    }
  }

  // ---- auth flow ----------------------------------------------------------
  async function connect() {
    if (!cfg.configured) { alert('Spotify Client ID is not set. See the README to add it to .env, then restart the server.'); return; }
    const verifier = randString(96);
    const challenge = await sha256b64url(verifier);
    const state = randString(16);
    localStorage.setItem(VER_KEY, verifier);
    localStorage.setItem(ST_KEY, state);
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      scope: cfg.scopes,
      redirect_uri: cfg.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    }).toString();
    location.href = url.toString();
  }

  // ---- Web Playback SDK ---------------------------------------------------
  function loadSdk() {
    return new Promise((resolve) => {
      if (window.Spotify) return resolve();
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      document.body.appendChild(s);
    });
  }

  async function startPlayer() {
    if (player) return;
    try {
      await loadSdk();
    } catch (e) {
      lastError = "Couldn't load Spotify's player script — check the table's internet connection, then Reconnect.";
      log('SDK load failed: ' + (e && e.message));
      emit();
      return;
    }
    // Definitive account check via the Web API — the SDK only becomes "ready"
    // for Premium accounts and otherwise often fails silently (no event). This
    // reads the real account type + confirms the token works for API calls.
    logAccountInfo();
    log('SDK loaded, creating player…');
    player = new window.Spotify.Player({
      name: 'Hitbeat Table 🎵',
      getOAuthToken: (cb) => {
        getValidToken().then((tok) => {
          if (tok) { tokenDelivered = true; cb(tok); }
          // if null, getValidToken already cleared tokens + emitted the expired-session state
          else log('getOAuthToken: no valid token to give the SDK');
        });
      },
      volume: 0.85,
    });
    player.addListener('ready', ({ device_id }) => { deviceId = device_id; ready = true; lastError = null; log('device ready: ' + device_id); emit(); });
    player.addListener('not_ready', () => { ready = false; log('device went offline'); emit(); });
    player.addListener('player_state_changed', (st) => { playing = !!(st && !st.paused); emit(); });
    player.addListener('authentication_error', ({ message }) => { lastError = 'Spotify sign-in expired or was rejected — click Reconnect.'; console.warn('[Hitbeat] auth error', message); clearTokens(); ready = false; emit(); });
    player.addListener('account_error', ({ message }) => { lastError = 'This Spotify account is not Premium — full songs need Premium.'; console.warn('[Hitbeat] account error', message); ready = false; emit(); });
    player.addListener('initialization_error', ({ message }) => { lastError = "Spotify's player can't run in this browser (needs Chrome/Edge with media DRM). Open the table in Chrome. (" + message + ')'; console.warn('[Hitbeat] init error', message); ready = false; emit(); });
    player.addListener('playback_error', ({ message }) => { lastError = 'playback: ' + message; console.warn('[Hitbeat] playback error', message); emit(); });
    // Safari (and iOS) require activateElement() to run INSIDE a user gesture,
    // or the device connects (connect()->true) but 'ready' never fires — exactly
    // the stuck state seen on the table. After an OAuth reconnect the player is
    // created on page-load with no gesture, so arm an unlock on the first
    // tap/click NOW (before connect, so timing can't miss the gesture).
    armGestureUnlock();
    const ok = await player.connect();
    log('player.connect() -> ' + ok);
    if (!ok) { lastError = "Spotify player couldn't connect — click Reconnect, and make sure it's a Premium account in Chrome."; emit(); return; }
    // If neither 'ready' nor any error listener has fired after a while, the SDK
    // is silently stuck — surface a diagnostic instead of an endless "Starting player…".
    setTimeout(() => {
      if (!ready && !lastError) {
        lastError = (tokenDelivered
          ? "Spotify connected but the player isn't active yet — tap anywhere on this table screen to start it. (If it still won't start: check the account is Premium and isn't in use on another device.)"
          : "Spotify player didn't request a login token — try Reconnect.") + browserFallbackHint();
        emit();
      }
    }, 10000);
  }

  // Ask the Web API who's logged in and — critically — their `product`
  // ("premium" / "free" / "open"). The Web Playback SDK only becomes ready for
  // Premium; a free account is the #1 silent cause of "connect()->true but never
  // ready". Also confirms the token is actually accepted by the API.
  async function logAccountInfo() {
    try {
      const tok = await getValidToken();
      if (!tok) { log('account check: no token'); return; }
      const res = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + tok } });
      if (!res.ok) { log('account check: /me returned ' + res.status); return; }
      const me = await res.json();
      log('account: product=' + (me.product || '?') + ' country=' + (me.country || '?') + ' (' + (me.display_name || me.id || '') + ')');
      if (me.product && me.product !== 'premium') {
        lastError = 'This Spotify account is “' + me.product + '”, not Premium — the player can only stream full songs on a Premium account. Log the table into a Premium account (Reconnect).';
        ready = false;
        emit();
      }
    } catch (e) {
      log('account check failed: ' + (e && e.message));
    }
  }

  // Call activateElement() on the first user gesture after the player exists —
  // the Safari/iOS requirement for the device to finish coming up. Harmless on
  // Chrome. Re-arms each startPlayer(); disarms itself once it fires or once ready.
  let gestureArmed = false;
  function armGestureUnlock() {
    if (gestureArmed) return;
    gestureArmed = true;
    const unlock = () => {
      try { if (player && player.activateElement) { player.activateElement(); log('activateElement() ran on user gesture'); } }
      catch (e) { log('activateElement error: ' + (e && e.message)); }
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      gestureArmed = false;
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  // Unlock audio from within a user gesture (required by some browsers / mobile).
  function activate() {
    try { if (player && player.activateElement) player.activateElement(); } catch (_) {}
  }

  // ---- track resolution (official Spotify search) -------------------------
  const uriCache = new Map(); // song id -> spotify uri

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function primaryArtist(artist) {
    // "Santana feat. Rob Thomas" -> "Santana"; "A & B" -> "A"
    return String(artist).split(/\s*(?:feat\.?|ft\.?|&|,|x)\s+/i)[0].trim();
  }

  // Returns { uri } on success (uri may be null = genuinely no match found),
  // or { error } when the search itself couldn't be completed (expired/bad
  // token, rate limit, network blip) — that says nothing about the song, so
  // callers must not treat it the same as "not on Spotify".
  async function resolveUri(card) {
    if (uriCache.has(card.id)) return { uri: uriCache.get(card.id) };
    const tok = await getValidToken();
    if (!tok) return { error: 'no-token' };
    const artist = primaryArtist(card.artist);
    const q = `track:${card.title} artist:${artist}`;
    const url = 'https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(q);
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
    } catch (_) {
      return { error: 'network' };
    }
    if (!res.ok) return { error: res.status === 429 ? 'rate-limited' : 'http-' + res.status };
    const items = ((await res.json()).tracks || {}).items || [];
    if (!items.length) return { uri: null };
    const wantArtist = norm(artist);
    const wantTitle = norm(card.title);
    // Prefer a track whose artist matches; among those, closest title, then popularity.
    const scored = items.map((t) => {
      const artistMatch = (t.artists || []).some((a) => norm(a.name).includes(wantArtist) || wantArtist.includes(norm(a.name)));
      const titleMatch = norm(t.name) === wantTitle || norm(t.name).includes(wantTitle);
      return { t, score: (artistMatch ? 100 : 0) + (titleMatch ? 40 : 0) + (t.popularity || 0) / 10 };
    }).sort((a, b) => b.score - a.score);
    const uri = scored[0].t.uri;
    uriCache.set(card.id, uri);
    return { uri };
  }

  // ---- playback control ---------------------------------------------------
  async function apiPut(path, body) {
    const tok = await getValidToken();
    if (!tok) return { status: 401 };
    return fetch('https://api.spotify.com/v1/' + path, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function play(card) {
    lastFailedCard = null; // clear any earlier failure now that a new song is cueing
    if (!getTokens()) { lastError = 'Not connected to Spotify — click Connect.'; log(lastError); emit(); return; }
    if (!deviceId) { lastError = 'Spotify player not ready yet — give it a moment or reconnect.'; log(lastError); emit(); return; }
    const result = await resolveUri(card);
    if (result.error) {
      // Couldn't even search — likely transient (token hiccup, rate limit,
      // network blip). Do NOT treat this as "song not on Spotify": the caller
      // must not permanently blacklist it, and shouldn't hammer retries.
      lastError = 'Spotify search trouble (' + result.error + ') — click Replay to try again.';
      log(lastError);
      lastFailedCard = { card, reason: 'search-error', detail: result.error, transient: true };
      emit();
      return;
    }
    const uri = result.uri;
    if (!uri) {
      lastError = 'No Spotify match for "' + card.title + '".';
      log(lastError);
      lastFailedCard = { card, reason: 'no-match', detail: '' };
      emit();
      return;
    }
    log('play ' + card.title + ' -> ' + uri);
    let res = await apiPut(`me/player/play?device_id=${deviceId}`, { uris: [uri] });
    if (res && (res.status === 404 || res.status === 202)) {
      // device not active yet — transfer then retry
      log('device inactive (' + res.status + '), transferring…');
      await apiPut('me/player', { device_ids: [deviceId], play: false });
      await new Promise((r) => setTimeout(r, 500));
      res = await apiPut(`me/player/play?device_id=${deviceId}`, { uris: [uri] });
    }
    if (res && res.status >= 400) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (_) {}
      lastError = 'Spotify play failed (' + res.status + ') ' + detail;
      log(lastError);
      lastFailedCard = { card, reason: 'playback-error', detail: String(res.status) + (detail ? ': ' + detail : '') };
    } else {
      lastError = null;
    }
    emit();
  }
  async function pause() { if (deviceId) await apiPut(`me/player/pause?device_id=${deviceId}`); }
  async function togglePlay() { try { if (player) await player.togglePlay(); } catch (e) { console.warn('[Hitbeat] togglePlay', e); } }

  function emit() {
    onState({ ready, playing, hasDevice: !!deviceId, token: !!getTokens(), configured: cfg.configured, error: lastError, failedCard: lastFailedCard, diag: diagLines.slice() });
  }

  // ---- init ---------------------------------------------------------------
  async function init() {
    try {
      cfg = await (await fetch('/config')).json();
    } catch { cfg = { configured: false }; }
    const ua = navigator.userAgent;
    const engine = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
    log('browser: ' + engine + ' · secure=' + window.isSecureContext + ' · EME=' + (!!(navigator.requestMediaKeySystemAccess)));
    log('config: configured=' + cfg.configured + ' hasToken=' + !!getTokens());
    emit();
    if (getTokens() && cfg.configured) startPlayer();
  }

  return {
    init, connect, play, pause, togglePlay, activate,
    get onState() { return onState; },
    set onState(fn) { onState = fn; },
  };
})();
