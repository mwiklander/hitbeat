'use strict';

require('dotenv').config();

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { Session } = require('./lib/game');

const PORT = Number(process.env.PORT || 8080);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

// --- themed song pools -----------------------------------------------------
// Each file in data/themes/*.json is a self-contained theme:
//   { id, name, emoji, blurb, target?, songs: [ {title, artist, year}, ... ] }
// Song ids are assigned at load time (unique within a theme), so theme files
// only need title/artist/year. Drop a new file in the folder to add a theme.
const themesDir = path.join(__dirname, 'data', 'themes');
let THEMES = [];
function loadThemes() {
  const list = [];
  let files = [];
  try { files = fs.readdirSync(themesDir).filter((f) => f.endsWith('.json')); } catch (_) {}
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(themesDir, f), 'utf8'));
      const songs = (t.songs || [])
        .filter((s) => s && s.title && s.artist && Number.isFinite(Number(s.year)))
        .map((s, i) => ({ id: i + 1, title: s.title, artist: s.artist, year: Number(s.year), spotifyId: s.spotifyId || null }));
      if (!songs.length) { console.warn(`⚠️  Theme ${f} has no valid songs, skipping.`); continue; }
      list.push({
        id: t.id || path.basename(f, '.json'),
        name: t.name || t.id || path.basename(f, '.json'),
        emoji: t.emoji || '🎵',
        blurb: t.blurb || '',
        target: Number(t.target) > 0 ? Number(t.target) : 10,
        songs,
      });
    } catch (e) {
      console.warn(`⚠️  Could not load theme ${f}: ${e.message}`);
    }
  }
  // stable order: Mixed first, then the rest alphabetically by name
  list.sort((a, b) => (a.id === 'mixed' ? -1 : b.id === 'mixed' ? 1 : a.name.localeCompare(b.name)));
  return list;
}
THEMES = loadThemes();
const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === 'mixed') || THEMES[0];
console.log(`🎼  Loaded ${THEMES.length} theme(s): ${THEMES.map((t) => `${t.emoji} ${t.name} (${t.songs.length})`).join(', ')}`);
{
  const withId = THEMES.map((t) => ({ t, n: t.songs.filter((s) => s.spotifyId).length }));
  const full = withId.filter(({ t, n }) => n === t.songs.length);
  const partial = withId.filter(({ t, n }) => n > 0 && n < t.songs.length);
  console.log(`🔗  DJ mode plays songs with a baked Spotify id — ${full.length} theme(s) fully ready: ${full.map(({ t }) => t.emoji + ' ' + t.name).join(', ') || '(none yet)'}`);
  if (partial.length) console.log(`    Partly resolved (playable, smaller pool): ${partial.map(({ t, n }) => `${t.name} ${n}/${t.songs.length}`).join(', ')}`);
  console.log('    Resolve more with:  node scripts/resolve-track-ids.js');
}

// --- songs known not to play on Spotify -------------------------------------
// Persisted so a track that failed once (no match found, or Spotify refused
// to play it) is quietly skipped in every future game, instead of getting
// re-drawn and getting stuck again. Reviewable/fixable later at your leisure —
// see data/broken-songs.json or GET /broken-songs.
const brokenSongsPath = path.join(__dirname, 'data', 'broken-songs.json');
const brokenSongKey = (s) => `${s.title}|${s.artist}`.toLowerCase().trim();
let brokenSongs = new Map(); // key -> {title, artist, year, reason, detail, count, firstSeen, lastSeen}

function loadBrokenSongs() {
  try {
    const arr = JSON.parse(fs.readFileSync(brokenSongsPath, 'utf8'));
    brokenSongs = new Map(arr.map((s) => [brokenSongKey(s), s]));
  } catch (_) {
    brokenSongs = new Map();
  }
}
function saveBrokenSongs() {
  const arr = [...brokenSongs.values()].sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  fs.writeFileSync(brokenSongsPath, JSON.stringify(arr, null, 2) + '\n');
}
function recordFailedSong({ title, artist, year, reason, detail }) {
  if (!title || !artist) return;
  const key = brokenSongKey({ title, artist });
  const now = new Date().toISOString();
  const existing = brokenSongs.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    existing.reason = reason;
    existing.detail = detail || existing.detail;
  } else {
    brokenSongs.set(key, { title, artist, year, reason, detail: detail || '', count: 1, firstSeen: now, lastSeen: now });
  }
  saveBrokenSongs();
  console.warn(`⚠️  Song failed to play (${reason}): "${title}" — ${artist}. Logged to data/broken-songs.json.`);
}
loadBrokenSongs();
if (brokenSongs.size) console.log(`🚫  ${brokenSongs.size} known-broken song(s) will be skipped (see data/broken-songs.json).`);

// --- helpers ---------------------------------------------------------------
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (sessions.has(code));
  return code;
}

function joinUrl(code) {
  return `http://${lanAddress()}:${PORT}/?join=${code}`;
}

// --- state -----------------------------------------------------------------
/** @type {Map<string, Session>} */
const sessions = new Map();

// Point a session at a theme's song pool (lobby only).
function applyTheme(session, themeId) {
  const theme = themeById(themeId);
  if (!theme) return;
  let pool = theme.songs.filter((s) => !brokenSongs.has(brokenSongKey(s)));
  // In DJ mode a song is only playable via its baked-in Spotify id, so one
  // without an id cannot be played at all — drop it from the pool rather than
  // deal a card whose play button would do nothing.
  if (session.audioMode === 'dj') pool = pool.filter((s) => s.spotifyId);
  session.songs = pool;
  session.target = theme.target;
  session.themeId = theme.id;
  session.themeName = theme.name;
  session.themeEmoji = theme.emoji;
}

// --- express ---------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/themes', (req, res) => {
  res.json(THEMES.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, blurb: t.blurb, count: t.songs.length, target: t.target })));
});

// Songs that failed to resolve/play on Spotify, for review — same data as
// data/broken-songs.json. Open this in a browser to see what needs fixing.
app.get('/broken-songs', (req, res) => {
  res.json([...brokenSongs.values()].sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
});

app.get('/config', (req, res) => {
  res.json({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    configured: Boolean(CLIENT_ID),
  });
});

app.get('/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'callback.html'));
});

const server = http.createServer(app);
const io = new Server(server);

// Broadcast the sanitized snapshot to everyone in a session room.
function broadcast(session) {
  const snap = session.snapshot();
  snap.joinUrl = joinUrl(session.code);
  io.to(session.code).emit('session:state', snap);
}

// Tell the jukebox (host) to play the current mystery track. The host resolves
// the Spotify track itself (official search) and plays it — the card identity
// is sent ONLY to the host, never broadcast, so players can't peek.
function cueAudio(session) {
  if (!session.turn || session.turn.revealed) return;
  const c = session.turn.card;

  if (session.audioMode === 'dj') {
    // The host device can hold the role too: run headless on the Mac mini and
    // the first phone to open the page is both the board and the jukebox.
    const target = session.djIsHost ? session.hostSocketId : (session.djPlayerId ? 'player:' + session.djPlayerId : null);
    if (!target) return; // nobody is holding the role yet
    // ONLY the Spotify id crosses the wire. The DJ's phone is in a player's
    // hand, so title/artist/year must never reach its DOM — the id alone is
    // enough to build the deep link, and Spotify reveals no more than the DJ
    // would see anyway once the app opens.
    io.to(target).emit('jukebox:play', {
      turnId: session.turn.id,
      spotifyId: c.spotifyId || null,
      linkStyle: session.linkStyle,
    });
    return;
  }

  if (!session.hostSocketId) return;
  io.to(session.hostSocketId).emit('jukebox:play', {
    turnId: session.turn.id,
    card: { id: c.id, title: c.title, artist: c.artist, year: c.year },
  });
}

io.on('connection', (socket) => {
  // ---- host / jukebox -----------------------------------------------------
  socket.on('host:create', async (_data, ack) => {
    const code = makeCode();
    const session = new Session(code, []);
    applyTheme(session, 'mixed'); // sensible default
    session.hostSocketId = socket.id;
    sessions.set(code, session);
    socket.data = { code, role: 'host' };
    socket.join(code);
    let qr = null;
    try { qr = await QRCode.toDataURL(joinUrl(code), { margin: 1, width: 480 }); } catch (_) {}
    if (ack) ack({ ok: true, code, joinUrl: joinUrl(code), qr });
    broadcast(session);
  });

  socket.on('host:resume', async ({ code } = {}, ack) => {
    const session = sessions.get(code);
    if (!session) { if (ack) ack({ ok: false, error: 'Session not found' }); return; }
    session.hostSocketId = socket.id;
    socket.data = { code, role: 'host' };
    socket.join(code);
    let qr = null;
    try { qr = await QRCode.toDataURL(joinUrl(code), { margin: 1, width: 480 }); } catch (_) {}
    if (ack) ack({ ok: true, code, joinUrl: joinUrl(code), qr });
    broadcast(session);
    cueAudio(session); // resume mid-turn audio if any
  });

  // ---- players ------------------------------------------------------------
  socket.on('player:join', ({ code, name, emoji, playerId } = {}, ack) => {
    const session = sessions.get((code || '').toUpperCase());
    if (!session) { if (ack) ack({ ok: false, error: 'That game code doesn’t exist' }); return; }

    let player = playerId ? session.players.get(playerId) : null;
    if (player) {
      player.connected = true;
      if (name) player.name = name.trim().slice(0, 20);
      if (emoji) player.emoji = emoji;
    } else {
      player = session.addPlayer(name, emoji);
    }
    socket.data = { code: session.code, role: 'player', playerId: player.id };
    socket.join(session.code);
    socket.join('player:' + player.id); // addressable by identity, survives reconnects
    if (ack) ack({ ok: true, code: session.code, playerId: player.id });
    broadcast(session);
  });

  // ---- lobby / teams ------------------------------------------------------
  function withSession(fn) {
    const code = socket.data && socket.data.code;
    const session = code && sessions.get(code);
    if (session) fn(session);
    return session;
  }

  // ---- the DJ: one device plays the music in its own Spotify app ----------
  socket.on('dj:claim', (_d, ack) => {
    withSession((session) => {
      const pid = socket.data.playerId;
      if (socket.data.role === 'host') {
        session.djIsHost = true;
        session.djPlayerId = null;
      } else if (pid) {
        session.djPlayerId = pid;
        session.djIsHost = false;
      } else {
        if (ack) ack({ ok: false, error: 'Join as a player first, then take the DJ role.' });
        return;
      }
      if (ack) ack({ ok: true });
      broadcast(session);
      // A song may already be waiting on a turn that started before anyone
      // claimed the role — hand it straight over rather than stalling.
      if (session.phase === 'playing') cueAudio(session);
    });
  });

  socket.on('dj:release', () => {
    withSession((session) => {
      if (session.djPlayerId !== socket.data.playerId && socket.data.role !== 'host') return;
      session.djPlayerId = null;
      session.djIsHost = false;
      broadcast(session);
    });
  });

  socket.on('audio:mode', ({ mode } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.phase !== 'lobby') return;
      if (mode !== 'dj' && mode !== 'table') return;
      session.audioMode = mode;
      applyTheme(session, session.themeId); // the playable pool depends on the mode
      broadcast(session);
    });
  });

  // Which flavour of deep link reaches the Spotify app is a property of the
  // DJ's phone, not of the game, so let it be switched per session: the custom
  // scheme always reaches the app (with an occasional "Open in Spotify?"
  // prompt), while the https link is smoother but falls back to Spotify's web
  // player on a phone that has never opened the app from a link before.
  socket.on('audio:linkStyle', ({ style } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host' && session.djPlayerId !== socket.data.playerId) return;
      if (style !== 'scheme' && style !== 'https') return;
      session.linkStyle = style;
      broadcast(session);
    });
  });

  socket.on('theme:select', ({ themeId } = {}) => {
    withSession((session) => {
      if (session.phase === 'ended') return;
      if (session.phase === 'playing' && socket.data.role !== 'host') return; // only the table switches mid-game
      applyTheme(session, themeId);
      if (session.phase === 'playing') {
        session.reshuffleForTheme(); // fresh deck + new mystery track for the current team
        io.to(session.code).emit('jukebox:stop');
        broadcast(session);
        cueAudio(session);
      } else {
        broadcast(session);
      }
    });
  });

  socket.on('settings:update', (opts = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.applySettings(opts)) broadcast(session);
    });
  });

  socket.on('team:create', (opts = {}) => {
    withSession((session) => {
      session.createTeam(socket.data.playerId, opts);
      broadcast(session);
    });
  });

  socket.on('team:join', ({ teamId } = {}) => {
    withSession((session) => {
      session.joinTeam(socket.data.playerId, teamId);
      broadcast(session);
    });
  });

  socket.on('team:leave', () => {
    withSession((session) => {
      session.leaveTeam(socket.data.playerId);
      broadcast(session);
    });
  });

  socket.on('team:rename', ({ teamId, name } = {}) => {
    withSession((session) => {
      session.renameTeam(teamId, name);
      broadcast(session);
    });
  });

  // ---- game flow ----------------------------------------------------------
  socket.on('game:start', (_d, ack) => {
    withSession((session) => {
      if (socket.data.role !== 'host') { if (ack) ack({ ok: false, error: 'Only the table can start' }); return; }
      if (!session.startGame()) { if (ack) ack({ ok: false, error: 'Need at least one team with a player' }); return; }
      if (ack) ack({ ok: true });
      broadcast(session);
      cueAudio(session);
    });
  });

  socket.on('turn:place', ({ slotIndex, titleGuess, artistGuess } = {}) => {
    withSession((session) => {
      const turn = session.placeCard(socket.data.playerId, slotIndex, { titleGuess, artistGuess });
      if (turn) {
        io.to(session.code).emit('jukebox:stop');
        broadcast(session);
      }
    });
  });

  // A challenger (any member of a NON-active team) spends a bonus card to
  // counter the active placement during the blind steal window. Engine enforces
  // team eligibility + affordability; reveals immediately on a valid challenge.
  socket.on('turn:steal', ({ slotIndex } = {}) => {
    withSession((session) => {
      if (session.attemptSteal(socket.data.playerId, slotIndex)) broadcast(session);
    });
  });

  // Close the steal window with no challenge (active team or table). Reveals.
  socket.on('turn:reveal', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      if (session.revealNow()) broadcast(session);
    });
  });

  socket.on('turn:advance', () => {
    withSession((session) => {
      // host or a member of the team that just played may advance
      if (session.advance()) {
        broadcast(session);
        cueAudio(session);
      }
    });
  });

  // ---- bonus token powers ----
  // Who may spend: the host, or a member of the team currently in the hot
  // seat — same rule as admin:redraw. Each returns false (silent no-op) if
  // the power isn't actually available, so a stale/duplicate click can't hurt.
  socket.on('power:extraSong', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      if (!session.turn) return;
      if (session.buyExtraSong(session.turn.teamId)) {
        broadcast(session);
        cueAudio(session);
      }
    });
  });

  socket.on('power:saveWinnings', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      if (!session.turn) return;
      if (session.useSaveWinnings(session.turn.teamId)) broadcast(session);
    });
  });

  socket.on('power:yearMargin', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      if (!session.turn) return;
      if (session.useYearMargin(session.turn.teamId)) broadcast(session);
    });
  });

  socket.on('power:randomCard', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      if (!session.turn) return;
      if (session.useRandomCard(session.turn.teamId)) broadcast(session);
    });
  });

  socket.on('jukebox:replay', () => {
    withSession((session) => {
      session._recentFailures = []; // a deliberate manual retry resets the failure-cascade breaker
      cueAudio(session);
    });
  });

  // The table's Spotify player couldn't find or play a song. Log it so it's
  // skipped from now on, and keep the game moving instead of sitting stuck.
  //
  // 'search-error' means the Spotify search request itself failed (expired
  // token, rate limit, network blip) — that says nothing about the song, so
  // it must never be permanently blacklisted the way a genuine 'no-match' or
  // 'playback-error' is.
  //
  // Circuit breaker: if failures start cascading (a technical problem, not a
  // handful of bad songs), stop auto-redrawing — without it, one transient
  // hiccup can silently burn through an entire theme's song pool in seconds.
  socket.on('song:failed', ({ card, reason, detail } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (!card || !card.title || !card.artist) return;

      if (reason !== 'search-error') {
        recordFailedSong({ title: card.title, artist: card.artist, year: card.year, reason, detail });
      }

      const now = Date.now();
      session._recentFailures = (session._recentFailures || []).filter((t) => now - t < 20000);
      session._recentFailures.push(now);
      const cascading = session._recentFailures.length >= 4;

      const isStillCurrent = session.turn && session.turn.card && session.turn.card.id === card.id && !session.turn.revealed;
      if (!isStillCurrent) return;

      if (cascading) {
        console.warn(`⚠️  ${session._recentFailures.length} song failures in 20s — pausing auto-redraw, likely a Spotify connection problem.`);
        io.to(session.code).emit('jukebox:stall', { reason, detail });
        return;
      }

      if (session.redraw()) {
        io.to(session.code).emit('jukebox:stop');
        broadcast(session);
        cueAudio(session);
      }
    });
  });

  // ---- table controls / recovery ----
  // Who may act: the host (table) always; for redraw, also a member of the
  // team currently in the hot seat ("we're stumped, give us a new one").
  function isActiveTeamMember(session) {
    if (!session.turn) return false;
    const p = socket.data.playerId && session.players.get(socket.data.playerId);
    return !!(p && p.teamId === session.turn.teamId);
  }

  socket.on('admin:redraw', () => {
    withSession((session) => {
      if (socket.data.role !== 'host' && !isActiveTeamMember(session)) return;
      session._recentFailures = []; // a deliberate manual redraw resets the failure-cascade breaker
      if (session.redraw()) {
        io.to(session.code).emit('jukebox:stop');
        broadcast(session);
        cueAudio(session);
      }
    });
  });

  socket.on('admin:skip', () => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.skipTeam()) {
        io.to(session.code).emit('jukebox:stop');
        broadcast(session);
        cueAudio(session);
      }
    });
  });

  socket.on('admin:end', () => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      session.endGame();
      io.to(session.code).emit('jukebox:stop');
      broadcast(session);
    });
  });

  socket.on('admin:undo', ({ teamId } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.undoLast(teamId)) broadcast(session);
    });
  });

  socket.on('admin:score', ({ teamId, delta } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.adjustScore(teamId, delta)) broadcast(session);
    });
  });

  // ---- host team management (lobby console) ----
  socket.on('admin:movePlayer', ({ playerId, teamId } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.adminMovePlayer(playerId, teamId || null)) broadcast(session);
    });
  });

  socket.on('admin:removeTeam', ({ teamId } = {}) => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      if (session.adminRemoveTeam(teamId)) broadcast(session);
    });
  });

  socket.on('game:reset', () => {
    withSession((session) => {
      if (socket.data.role !== 'host') return;
      // keep players + teams, wipe timelines back to lobby
      session.phase = 'lobby';
      session.turn = null;
      session.winnerTeamId = null;
      session.currentTeamIdx = 0;
      for (const t of session.teams) { t.timeline = []; t.score = 0; }
      io.to(session.code).emit('jukebox:stop');
      broadcast(session);
    });
  });

  // ---- disconnect ---------------------------------------------------------
  socket.on('disconnect', () => {
    const data = socket.data || {};
    const session = data.code && sessions.get(data.code);
    if (!session) return;
    if (data.role === 'player' && data.playerId) {
      const p = session.players.get(data.playerId);
      if (p) p.connected = false;
      broadcast(session);
    }
    // host disconnect: keep the session alive so it can resume audio on reconnect
  });
});

// Reap idle sessions (older than 6h) every 30 min.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, s] of sessions) if (s.createdAt < cutoff) sessions.delete(code);
}, 30 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log('\n🎵  Hitbeat is live!');
  console.log(`   Everyone opens:  http://${lan}:${PORT}`);
  console.log('   The first device to tap "Start a new game" becomes the board and shows');
  console.log('   the code for everyone else to scan. No screen needed on this machine.');
  console.log(`   Also on this machine, if you want the board here:  http://127.0.0.1:${PORT}`);
  if (!CLIENT_ID) {
    // Only 'table' audio mode needs this — DJ mode plays through a phone's own
    // Spotify app and needs no credentials here at all.
    console.log('\n💡  No SPOTIFY_CLIENT_ID set. Fine for DJ mode; only needed if you want');
    console.log('    this machine to be the Spotify player itself ("This machine" audio mode).');
  }
  console.log('');
});
