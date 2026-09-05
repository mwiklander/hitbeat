'use strict';

// ===========================================================================
// Hitbeat client. One page, three roles:
//   - landing  : choose to be the table, or join with a code
//   - join      : pick a name + emoji, then enter a game as a player
//   - player    : lobby (self-assemble teams) + gameplay controller
//   - table     : the shared "board" (QR to join, Spotify jukebox, big timelines)
// The server holds authoritative state and pushes sanitized snapshots.
// ===========================================================================

const socket = io();
const LS_KEY = 'hitbeat';
const EMOJIS = ['🎧','🕺','💃','🦄','🐙','🦊','🐸','🐼','🦁','🐝','🦖','👽','🤖','🎸','🎤','🥁','🎹','🦩','🐨','🦕','🌮','🍕','⚡','🔥','🌈','👾','🎩','🦜'];

const el = (id) => document.getElementById(id);
const views = {
  landing: el('view-landing'),
  join: el('view-join'),
  player: el('view-player'),
  table: el('view-table'),
};
function showView(name) {
  for (const k of Object.keys(views)) views[k].classList.toggle('hidden', k !== name);
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } },
  set(patch) { const cur = store.get(); localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch })); },
  clear() { localStorage.removeItem(LS_KEY); },
};

// ---- app state ------------------------------------------------------------
let role = null;          // 'host' | 'player'
let myId = null;          // player id
let joinCode = null;
let snap = null;          // latest snapshot
let pendingSlot = null;   // slot index the active player has armed
let pendingStealSlot = null; // slot a challenger has armed in the steal window
let titleGuessVal = '';   // bonus-round text, kept across re-renders within a turn
let artistGuessVal = '';
let lastSeenTurnId = null; // resets pendingSlot/guesses when a new turn starts
let pickedEmoji = EMOJIS[0];
let lastRevealTurn = null; // turn id we've already shown the reveal for

// ===========================================================================
// Boot
// ===========================================================================
function boot() {
  const params = new URLSearchParams(location.search);
  const joinParam = (params.get('join') || '').toUpperCase().trim();
  const saved = store.get();

  buildEmojiGrid();
  // Before any of the early returns below: a phone arriving from the QR code
  // takes the joinParam path, and that phone is exactly the one that may end
  // up as the DJ receiving play cues.
  initJukebox();

  if (joinParam) {
    joinCode = joinParam;
    el('join-code-label').textContent = joinParam;
    if (saved.name) el('input-name').value = saved.name;
    if (saved.emoji) selectEmoji(saved.emoji);
    showView('join');
    return;
  }

  // Try to resume a previous role on this device.
  if (saved.role === 'host' && saved.code) {
    resumeHost(saved.code);
    return;
  }
  if (saved.role === 'player' && saved.code && saved.playerId) {
    role = 'player'; myId = saved.playerId; joinCode = saved.code;
    socket.emit('player:join', { code: saved.code, playerId: saved.playerId, name: saved.name, emoji: saved.emoji }, (res) => {
      if (res && res.ok) { showView('player'); }
      else { store.clear(); showView('landing'); }
    });
    return;
  }
  showView('landing');
}

function resumeHost(code) {
  socket.emit('host:resume', { code }, (res) => {
    if (res && res.ok) {
      role = 'host'; joinCode = res.code;
      tableQR = res.qr; tableJoinUrl = res.joinUrl;
      showView('table');
      initTableSpotify();
    } else {
      store.clear();
      showView('landing');
    }
  });
}

// ===========================================================================
// Landing
// ===========================================================================
el('btn-be-table').addEventListener('click', () => {
  socket.emit('host:create', {}, (res) => {
    if (!res || !res.ok) return;
    role = 'host'; joinCode = res.code;
    tableQR = res.qr; tableJoinUrl = res.joinUrl;
    store.set({ role: 'host', code: res.code });
    showView('table');
    initTableSpotify();
  });
});

el('btn-join-code').addEventListener('click', () => {
  const code = el('input-join-code').value.toUpperCase().trim();
  if (code.length < 3) return;
  joinCode = code;
  el('join-code-label').textContent = code;
  const saved = store.get();
  if (saved.name) el('input-name').value = saved.name;
  if (saved.emoji) selectEmoji(saved.emoji);
  showView('join');
});
el('input-join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-join-code').click(); });

// ===========================================================================
// Join (name + emoji)
// ===========================================================================
function buildEmojiGrid() {
  const grid = el('emoji-grid');
  grid.innerHTML = '';
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.textContent = e;
    b.addEventListener('click', () => selectEmoji(e));
    b.dataset.emoji = e;
    grid.appendChild(b);
  });
  selectEmoji(pickedEmoji);
}
function selectEmoji(e) {
  pickedEmoji = e;
  document.querySelectorAll('#emoji-grid button').forEach((b) => b.classList.toggle('sel', b.dataset.emoji === e));
}

el('btn-do-join').addEventListener('click', () => {
  const name = el('input-name').value.trim();
  if (!name) { showJoinError('Enter a name first 🙂'); return; }
  socket.emit('player:join', { code: joinCode, name, emoji: pickedEmoji }, (res) => {
    if (!res || !res.ok) { showJoinError(res && res.error ? res.error : 'Could not join'); return; }
    role = 'player'; myId = res.playerId; joinCode = res.code;
    store.set({ role: 'player', code: res.code, playerId: res.playerId, name, emoji: pickedEmoji });
    el('me-emoji').textContent = pickedEmoji;
    el('me-name').textContent = name;
    el('player-code').textContent = res.code;
    showView('player');
  });
});
function showJoinError(msg) { const e = el('join-error'); e.textContent = msg; e.classList.remove('hidden'); }

// ===========================================================================
// Snapshot handling
// ===========================================================================
socket.on('session:state', (s) => {
  snap = s;
  if (role === 'host') { tableJoinUrl = s.joinUrl || tableJoinUrl; renderTable(); }
  else if (role === 'player') { renderPlayer(); }
  handleReveal();
});

socket.on('connect', () => {
  // reconnect flow: re-attach identity if we already have one
  if (role === 'host' && joinCode) socket.emit('host:resume', { code: joinCode }, (res) => { if (res && res.ok) { tableQR = res.qr; tableJoinUrl = res.joinUrl; } });
  else if (role === 'player' && joinCode && myId) socket.emit('player:join', { code: joinCode, playerId: myId });
});

// ===========================================================================
// PLAYER — lobby + gameplay
// ===========================================================================
function myPlayer() { return snap && snap.teams && [...allPlayers()].find((p) => p.id === myId); }
function allPlayers() {
  const arr = [];
  if (!snap) return arr;
  for (const t of snap.teams) for (const m of t.members) arr.push({ ...m, teamId: t.id });
  for (const p of snap.lobbyPool) arr.push({ ...p, teamId: null });
  return arr;
}
function myTeam() {
  const me = myPlayer();
  if (!me || !me.teamId) return null;
  return snap.teams.find((t) => t.id === me.teamId) || null;
}

function renderPlayer() {
  const body = el('player-body');
  if (!snap) { body.innerHTML = ''; return; }
  if (snap.phase === 'lobby') return renderPlayerLobby(body);
  if (snap.phase === 'playing') return renderPlayerGame(body);
  if (snap.phase === 'ended') return renderEnded(body, false);
}

function renderPlayerLobby(body) {
  const me = myPlayer();
  const mine = myTeam();
  body.innerHTML = '';

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = mine ? 'You’re in! Wait for the table to start, or hop teams.' : 'Join a team or start your own. Teams can be any size 🎉';
  body.appendChild(hint);

  const djLobby = djPanel();
  if (djLobby) body.appendChild(djLobby);

  if (snap.themeName) {
    const badge = document.createElement('div');
    badge.className = 'theme-badge';
    badge.textContent = `${snap.themeEmoji || '🎵'} ${snap.themeName}`;
    body.appendChild(badge);
  }

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Teams';
  body.appendChild(title);

  const list = document.createElement('div');
  list.className = 'team-list';
  snap.teams.forEach((t) => list.appendChild(teamLobbyCard(t, me)));
  body.appendChild(list);

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-primary btn-block';
  newBtn.style.marginTop = '12px';
  newBtn.textContent = '＋ Start a new team';
  newBtn.addEventListener('click', () => socket.emit('team:create', {}));
  body.appendChild(newBtn);

  // unassigned pool
  if (snap.lobbyPool.length) {
    const t2 = document.createElement('div');
    t2.className = 'section-title';
    t2.textContent = 'Not on a team yet';
    body.appendChild(t2);
    const pool = document.createElement('div');
    pool.className = 'pool';
    snap.lobbyPool.forEach((p) => {
      const c = document.createElement('span');
      c.className = 'chip' + (p.connected ? '' : ' off');
      c.textContent = `${p.emoji} ${p.name}`;
      pool.appendChild(c);
    });
    body.appendChild(pool);
  }
}

function teamLobbyCard(t, me) {
  const div = document.createElement('div');
  div.className = 'team';
  div.style.setProperty('--team', t.color);
  const iAmHere = me && me.teamId === t.id;

  const head = document.createElement('div');
  head.className = 'team-head';
  head.innerHTML = `<span class="team-emoji">${t.emoji}</span><span class="team-name">${escapeHtml(t.name)}</span>`;
  if (iAmHere) {
    head.querySelector('.team-name').addEventListener('click', () => {
      const name = prompt('Rename your team', t.name);
      if (name) socket.emit('team:rename', { teamId: t.id, name });
    });
    head.querySelector('.team-name').style.textDecoration = 'underline dotted';
  }
  div.appendChild(head);

  const members = document.createElement('div');
  members.className = 'team-members';
  if (!t.members.length) members.innerHTML = '<span class="chip off">empty</span>';
  t.members.forEach((m) => {
    const c = document.createElement('span');
    c.className = 'chip' + (m.connected ? '' : ' off');
    c.textContent = `${m.emoji} ${m.name}` + (m.id === myId ? ' (you)' : '');
    members.appendChild(c);
  });
  div.appendChild(members);

  const actions = document.createElement('div');
  actions.className = 'team-actions';
  if (iAmHere) {
    const leave = document.createElement('button');
    leave.className = 'btn btn-ghost btn-sm';
    leave.textContent = 'Leave';
    leave.addEventListener('click', () => socket.emit('team:leave'));
    actions.appendChild(leave);
  } else {
    const join = document.createElement('button');
    join.className = 'btn btn-primary btn-sm';
    join.textContent = 'Join this team';
    join.addEventListener('click', () => socket.emit('team:join', { teamId: t.id }));
    actions.appendChild(join);
  }
  div.appendChild(actions);
  return div;
}

function renderPlayerGame(body) {
  const mine = myTeam();
  const currentTeam = snap.teams.find((t) => t.id === snap.currentTeamId);
  const isMyTurn = mine && currentTeam && mine.id === currentTeam.id;

  // A new mystery track means old slot/guess state is stale — clear it.
  if (snap.turn && snap.turn.id !== lastSeenTurnId) {
    lastSeenTurnId = snap.turn.id;
    pendingSlot = null;
    pendingStealSlot = null;
    titleGuessVal = '';
    artistGuessVal = '';
  }

  body.innerHTML = '';

  const djGame = djPanel();
  if (djGame) body.appendChild(djGame);

  const streak = (snap.turn && snap.turn.streak) || 0;
  const pastCap = snap.maxStreak > 0 && streak >= snap.maxStreak;
  const streakNote = snap.maxStreak !== 1 && streak > 0
    ? `<small>🔥 ${streak} in a row${pastCap ? ' · bought past the cap!' : (snap.maxStreak ? ' · going for ' + (streak + 1) + '/' + snap.maxStreak : '')}</small>` : '';

  // banner
  const banner = document.createElement('div');
  banner.className = 'banner' + (isMyTurn ? ' you' : '');
  if (!mine) {
    banner.innerHTML = `👀 Spectating — ${escapeHtml(currentTeam ? currentTeam.name : '')} is up<small>You’re not on a team</small>`;
  } else if (isMyTurn) {
    banner.innerHTML = `🎤 Your team is up!<small>Listen, then drop the song where it belongs</small>${streakNote}`;
  } else {
    banner.innerHTML = `⏳ ${escapeHtml(currentTeam ? currentTeam.name : '')} is placing…<small>Listen along — you’re up soon</small>${streakNote}`;
  }
  body.appendChild(banner);

  const revealed = snap.turn && snap.turn.revealed;
  const awaitingSteal = snap.turn && snap.turn.awaitingSteal;

  // Active placement UI (only for the active team, before reveal / steal window)
  if (isMyTurn && !revealed && !awaitingSteal) {
    const wrap = document.createElement('div');
    wrap.className = 'timeline-wrap';
    wrap.innerHTML = `<div class="timeline-label">${mine.emoji} Where does this song go?${tokenBadgeHtml(mine)}</div>`;
    wrap.appendChild(buildTimeline(mine, { withSlots: true }));
    body.appendChild(wrap);

    if (snap.wrongGuessPolicy === 'lose' && snap.turn.runGainsCount > 0) {
      const risk = document.createElement('div');
      risk.className = 'risk-banner';
      risk.textContent = `⚠️ Get this wrong and you'll lose ${snap.turn.runGainsCount} card${snap.turn.runGainsCount === 1 ? '' : 's'} from this turn!`;
      body.appendChild(risk);
    }

    if (snap.bonusGuessingEnabled) body.appendChild(bonusGuessBox());

    const bar = document.createElement('div');
    bar.className = 'placebar';
    const lock = document.createElement('button');
    lock.className = 'btn btn-good';
    lock.disabled = pendingSlot === null;
    lock.textContent = pendingSlot === null ? 'Tap a slot above ↑' : 'Lock it in 🔒';
    lock.addEventListener('click', () => {
      if (pendingSlot === null) return;
      socket.emit('turn:place', { slotIndex: pendingSlot, titleGuess: titleGuessVal.trim(), artistGuess: artistGuessVal.trim() });
      pendingSlot = null;
      titleGuessVal = '';
      artistGuessVal = '';
    });
    bar.appendChild(lock);
    body.appendChild(bar);

    const stumped = document.createElement('button');
    stumped.className = 'btn btn-ghost btn-sm';
    stumped.style.cssText = 'display:block;margin:8px auto 0;';
    stumped.textContent = '🔀 No idea? Get a new song';
    stumped.addEventListener('click', () => {
      if (confirm('Swap this song for a new one? Your team keeps its turn — no penalty.')) socket.emit('admin:redraw');
    });
    body.appendChild(stumped);
  }

  // Blind steal-challenge window: the active team locked in, the year is still
  // hidden, and another team may spend a bonus card to counter their placement.
  if (awaitingSteal) appendStealWindow(body, { currentTeam, mine, isMyTurn });

  // Every team's timeline on each player's own device — the active team pinned
  // first, then the rest. Scroll down to see the whole board from your phone.
  appendAllTimelines(body, { currentTeam, mine, isMyTurn, revealed, awaitingSteal });
}

// UI for the blind steal-challenge window (see engine attemptSteal). The active
// team waits (with a Reveal button); other teams that can afford it get to place
// a counter-guess in the active team's timeline.
function appendStealWindow(body, { currentTeam, mine, isMyTurn }) {
  if (isMyTurn) {
    const box = document.createElement('div');
    box.className = 'steal-box mine';
    box.innerHTML = `<div class="steal-title">✅ Locked in!</div>
      <div class="steal-sub">Any other team can spend a 🎫 bonus card to challenge where this song goes. Reveal once they've had their chance.</div>`;
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-primary btn-block';
    reveal.style.marginTop = '10px';
    reveal.textContent = 'Reveal now →';
    reveal.addEventListener('click', () => socket.emit('turn:reveal'));
    box.appendChild(reveal);
    body.appendChild(box);
    return;
  }
  if (!mine || !currentTeam) return; // spectators just wait
  const cost = snap.turn.stealCost;
  const canAfford = (mine.tokens || 0) >= cost;
  const box = document.createElement('div');
  box.className = 'steal-box';
  if (!canAfford) {
    box.innerHTML = `<div class="steal-title">🕵️ ${escapeHtml(currentTeam.name)} placed their guess…</div>
      <div class="steal-sub">A team with a 🎫 bonus card can challenge where it really goes. You don't have one to spend right now.</div>`;
    body.appendChild(box);
    return;
  }
  box.innerHTML = `<div class="steal-title">🕵️ Challenge ${escapeHtml(currentTeam.name)}?</div>
    <div class="steal-sub">They placed the mystery song somewhere in their timeline. Where do <b>you</b> think it goes? Spend ${cost} 🎫 — if they were wrong and you're right, the card is yours.</div>`;
  const tlWrap = document.createElement('div');
  tlWrap.className = 'timeline-wrap';
  tlWrap.innerHTML = `<div class="timeline-label">${currentTeam.emoji} ${escapeHtml(currentTeam.name)}’s timeline — pick the right spot</div>`;
  tlWrap.appendChild(buildTimeline(currentTeam, { stealSlots: true }));
  box.appendChild(tlWrap);
  const bar = document.createElement('div');
  bar.className = 'placebar';
  const btn = document.createElement('button');
  btn.className = 'btn btn-good';
  btn.disabled = pendingStealSlot === null;
  btn.textContent = pendingStealSlot === null ? 'Tap a spot above ↑' : `🕵️ Challenge — spend ${cost} 🎫`;
  btn.addEventListener('click', () => {
    if (pendingStealSlot === null) return;
    socket.emit('turn:steal', { slotIndex: pendingStealSlot });
    pendingStealSlot = null;
  });
  bar.appendChild(btn);
  box.appendChild(bar);
  body.appendChild(box);
}

// Read-only board of all teams' timelines, shown on every player's device.
// `placingMine` (my turn, pre-reveal) skips my own team here since it's already
// shown above with placement slots — no need to render it twice.
function appendAllTimelines(body, { currentTeam, mine, isMyTurn, revealed, awaitingSteal }) {
  const placingMine = isMyTurn && !revealed && !awaitingSteal;
  const activeId = currentTeam ? currentTeam.id : null;
  // During the steal window the active team's timeline is already shown in the
  // challenge box above (for challengers/spectators), so don't repeat it here.
  const skipActive = awaitingSteal && !isMyTurn;
  const teams = snap.teams.slice().sort((a, b) => (a.id === activeId ? 0 : 1) - (b.id === activeId ? 0 : 1));

  const section = document.createElement('div');
  section.className = 'all-timelines';
  const heading = snap.teams.length > 1 ? '📋 All timelines' : '📋 Timeline';
  section.innerHTML = `<div class="section-label">${heading}</div>`;

  teams.forEach((t) => {
    if (placingMine && mine && t.id === mine.id) return; // shown above with slots
    if (skipActive && t.id === activeId) return; // shown above in the challenge box
    const isActive = t.id === activeId;
    const isMine = mine && t.id === mine.id;
    const wrap = document.createElement('div');
    wrap.className = 'timeline-wrap' + (isActive ? ' tl-active' : '');
    const tags = (isActive ? ' <span class="tl-tag playing">🎤 up now</span>' : '')
      + (isMine ? ' <span class="tl-tag you">⭐ you</span>' : '');
    wrap.innerHTML = `<div class="timeline-label">${t.emoji} ${escapeHtml(t.name)} · ${t.score}/${snap.target}${tokenBadgeHtml(t)}${tags}</div>`;
    wrap.appendChild(buildTimeline(t, { withSlots: false }));
    section.appendChild(wrap);
  });
  body.appendChild(section);
}

// Optional bonus round: name the song and/or artist for a free extra card.
function bonusGuessBox() {
  const box = document.createElement('div');
  box.className = 'bonus-box';
  box.innerHTML = `<div class="bonus-label">🎤 Bonus: know the song? <span class="muted">(optional)</span></div>`;

  const row = document.createElement('div');
  row.className = 'bonus-row';

  const titleInput = document.createElement('input');
  titleInput.placeholder = 'Song title';
  titleInput.value = titleGuessVal;
  titleInput.autocomplete = 'off';
  titleInput.addEventListener('input', (e) => { titleGuessVal = e.target.value; });
  row.appendChild(titleInput);

  const artistInput = document.createElement('input');
  artistInput.placeholder = 'Artist';
  artistInput.value = artistGuessVal;
  artistInput.autocomplete = 'off';
  artistInput.addEventListener('input', (e) => { artistGuessVal = e.target.value; });
  row.appendChild(artistInput);

  box.appendChild(row);
  const hint = document.createElement('div');
  hint.className = 'bonus-hint';
  hint.textContent = 'Get both right (with the year) for a free bonus card!';
  box.appendChild(hint);
  return box;
}

// build a timeline element. withSlots => placement slots for the active team;
// stealSlots => challenge slots (armed into pendingStealSlot) for a steal.
function buildTimeline(team, { withSlots, stealSlots } = {}) {
  const tl = document.createElement('div');
  tl.className = 'timeline';
  const cards = team.timeline; // already sorted by year
  const slots = withSlots || stealSlots;

  const addSlot = (index) => {
    const armedIndex = stealSlots ? pendingStealSlot : pendingSlot;
    const s = document.createElement('div');
    s.className = 'slot' + (armedIndex === index ? ' armed' : '');
    if (armedIndex !== index) s.textContent = '+';
    s.addEventListener('click', () => {
      if (stealSlots) pendingStealSlot = index; else pendingSlot = index;
      renderPlayer();
    });
    tl.appendChild(s);
  };

  if (slots) addSlot(0);
  cards.forEach((c, i) => {
    tl.appendChild(makeCard(c));
    if (slots) addSlot(i + 1);
  });
  if (!cards.length && !slots) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.innerHTML = '<span class="meta" style="display:block">no cards yet</span>';
    tl.appendChild(empty);
  }
  return tl;
}

function makeCard(c) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="yr">${c.year}</div>
    <div class="meta"><b>${escapeHtml(c.title)}</b><br>${escapeHtml(c.artist)}</div>
    <div class="flip-hint">tap</div>`;
  card.addEventListener('click', () => card.classList.toggle('flipped'));
  return card;
}

// ===========================================================================
// Reveal overlay (shared by table + players)
// ===========================================================================
function handleReveal() {
  const overlay = el('reveal');
  const t = snap && snap.turn;
  // The table never gets the full-screen overlay — it would block the
  // referee controls (undo/score/theme) underneath. The table shows its own
  // inline reveal + advance button in #now-playing (see renderTableGame).
  if (role === 'host') { overlay.classList.add('hidden'); return; }
  if (t && t.revealed && t.card) {
    if (lastRevealTurn !== t.id) lastRevealTurn = t.id; // (re)show on new reveal
    el('reveal-verdict').textContent = t.correct ? '✅ Nailed it!' : '❌ Not quite…';
    el('reveal-verdict').className = 'reveal-verdict ' + (t.correct ? 'good' : 'bad');
    el('reveal-year').textContent = t.card.year;
    el('reveal-title').textContent = t.card.title;
    el('reveal-artist').textContent = t.card.artist;
    el('reveal-guesses').innerHTML = guessSummaryHtml(t);
    renderRevealActions(t);
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

// Shared by the player overlay and the table's inline reveal.
function guessSummaryHtml(t) {
  const g = t.guesses;
  let html = '';
  if (g && (g.title || g.artist)) {
    html += '<div class="guess-summary">';
    if (g.title) {
      html += `<div class="guess-line ${g.titleCorrect ? 'good' : 'bad'}">${g.titleCorrect ? '✅' : '❌'} Title guess: “${escapeHtml(g.title)}”</div>`;
    }
    if (g.artist) {
      html += `<div class="guess-line ${g.artistCorrect ? 'good' : 'bad'}">${g.artistCorrect ? '✅' : '❌'} Artist guess: “${escapeHtml(g.artist)}”</div>`;
    }
    html += '</div>';
  }
  if (t.tokenEarned) {
    html += `<div class="bonus-banner">🎫 Named it! +1 bonus card saved.</div>`;
  }
  if (t.randomCardDrawn) {
    const c = t.randomCardDrawn;
    html += `<div class="bonus-banner">🎲 Cashed in a bonus card: ${c.year} · ${escapeHtml(c.title)} <span class="muted">— ${escapeHtml(c.artist)}</span></div>`;
  }
  if (t.steal) {
    const s = t.steal;
    if (s.won) {
      html += `<div class="steal-banner good">🕵️ ${s.teamEmoji} ${escapeHtml(s.teamName)} challenged and stole the card!</div>`;
    } else {
      html += `<div class="steal-banner bad">🕵️ ${s.teamEmoji} ${escapeHtml(s.teamName)} challenged${s.correct ? '' : ' but missed'} — no steal.</div>`;
    }
  }
  return html;
}

// The offer buttons for spending saved bonus cards — shown alongside the
// normal advance/pass button whenever the engine says a power actually applies.
function powerOffersHtml(t) {
  const offers = [];
  if (t.canBuyExtraSong) offers.push(`<button class="btn btn-good btn-sm power-btn" data-power="extraSong">🎫 Spend ${snap.powers.extraSong.cost} for one more song</button>`);
  if (t.canSaveWinnings) offers.push(`<button class="btn btn-good btn-sm power-btn" data-power="saveWinnings">🎫 Spend ${snap.powers.saveWinnings.cost} to keep your cards</button>`);
  if (t.canUseMargin) offers.push(`<button class="btn btn-good btn-sm power-btn" data-power="yearMargin">🎫 Spend ${snap.powers.yearMargin.cost} — you were only ${t.missBy} yr off!</button>`);
  if (t.canDrawRandomCard) offers.push(`<button class="btn btn-good btn-sm power-btn" data-power="randomCard">🎲 Spend ${snap.powers.randomCard.cost} for a random card</button>`);
  if (!offers.length) return '';
  return `<div class="power-offers">${offers.join('')}</div>`;
}

function wirePowerButtons(container) {
  container.querySelectorAll('.power-btn').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('power:' + btn.dataset.power));
  });
}

function renderRevealActions(t) {
  let actions = el('reveal-actions');
  const cardBox = document.querySelector('.reveal-card');
  if (!actions) {
    actions = document.createElement('div');
    actions.id = 'reveal-actions';
    actions.style.marginTop = '22px';
    cardBox.appendChild(actions);
  }
  // Who may advance: the table, or a member of the team that just placed.
  const canAdvance = role === 'host' || (myTeam() && myTeam().id === t.teamId);
  const willEnd = !!snap.winnerTeamId;
  if (canAdvance) {
    actions.innerHTML = willEnd ? '' : powerOffersHtml(t);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = willEnd ? 'See the winner 🏆' : nextActionLabel(t);
    btn.addEventListener('click', () => socket.emit('turn:advance'));
    actions.appendChild(btn);
    wirePowerButtons(actions);
  } else {
    actions.innerHTML = '<p class="muted">Waiting for the next song…</p>';
  }
}

// "Keep going!" if the same team continues, or names who's up next.
function nextActionLabel(t) {
  if (!t.willPassTurn) return '🔥 Keep going! Next song →';
  const idx = snap.teams.findIndex((x) => x.id === t.teamId);
  const next = snap.teams[(idx + 1) % snap.teams.length];
  return next ? `Pass to ${next.emoji} ${next.name} →` : 'Next song →';
}

// ===========================================================================
// Ended screen
// ===========================================================================
function renderEnded(container, isTable) {
  const winner = snap.teams.find((t) => t.id === snap.winnerTeamId);
  container.innerHTML = `<div class="winner">
      <div class="trophy">🏆</div>
      <h2>${winner ? escapeHtml(winner.name) : 'Nobody'} wins!</h2>
      <p class="muted">${winner ? winner.emoji + ' ' + winner.score + ' cards on the timeline' : ''}</p>
    </div>`;
  const nerd = [...snap.teams].sort((a, b) => (b.titleHits + b.artistHits) - (a.titleHits + a.artistHits))[0];
  if (nerd && (nerd.titleHits + nerd.artistHits) > 0) {
    const badge = document.createElement('p');
    badge.className = 'muted';
    badge.style.textAlign = 'center';
    badge.textContent = `🧠 Music Nerd Award: ${nerd.name} — named ${nerd.titleHits} title${nerd.titleHits === 1 ? '' : 's'} & ${nerd.artistHits} artist${nerd.artistHits === 1 ? '' : 's'} correctly`;
    container.appendChild(badge);
  }
  if (isTable) {
    const teams = document.createElement('div');
    teams.className = 'table-teams';
    snap.teams.slice().sort((a, b) => b.score - a.score).forEach((t) => teams.appendChild(tableTeamRow(t, false)));
    container.appendChild(teams);
  }
  if (role === 'host') {
    const again = document.createElement('button');
    again.className = 'btn btn-primary btn-block';
    again.style.maxWidth = '360px';
    again.style.margin = '20px auto 0';
    again.style.display = 'block';
    again.textContent = '↺ Play again (same teams)';
    again.addEventListener('click', () => socket.emit('game:reset'));
    container.appendChild(again);
  }
}

// ===========================================================================
// TABLE / JUKEBOX
// ===========================================================================
let tableQR = null;
let tableJoinUrl = null;

function renderTable() {
  const body = el('table-body');
  if (!snap) return;
  if (snap.phase === 'lobby') return renderTableLobby(body);
  if (snap.phase === 'playing') return renderTableGame(body);
  if (snap.phase === 'ended') { body.innerHTML = ''; const grid = document.createElement('div'); grid.className = 'table-main'; body.appendChild(grid); renderEnded(grid, true); }
}

function renderTableLobby(body) {
  const teamsWithMembers = snap.teams.filter((t) => t.members.length);
  body.innerHTML = `
    <div class="table-grid lobby">
      <div class="table-side">
        <div class="qr-box">
          ${tableQR ? `<img src="${tableQR}" alt="Join QR" />` : ''}
          <div class="code">${snap.code}</div>
        </div>
        <p class="qr-cap">Scan to join, or go to<br><b>${escapeHtml(tableJoinUrl || '')}</b></p>
        <div id="spotify-slot"></div>
        <button id="btn-start" class="btn btn-primary btn-block">Start game 🎉</button>
        <p class="qr-cap" id="start-hint"></p>
      </div>
      <div class="table-main">
        <h1 class="table-title">🎵 Hitbeat</h1>
        <p class="muted">Gather round! Grab your phone, scan the code, and build a team.</p>
        <div class="section-title">Theme <span class="muted" style="text-transform:none;font-weight:600">— tap to change</span></div>
        <div class="theme-picker" id="theme-picker"></div>
        <div class="section-title">Game settings</div>
        <div id="game-settings"></div>
        <div class="table-teams" id="table-teams"></div>
      </div>
    </div>`;

  const picker = el('theme-picker');
  availableThemes.forEach((t) => {
    const chip = document.createElement('button');
    chip.className = 'theme-chip' + (t.id === snap.themeId ? ' sel' : '');
    chip.innerHTML = `<span class="theme-emoji">${t.emoji}</span>
      <span class="theme-name">${escapeHtml(t.name)}</span>
      <span class="theme-count">${t.count} songs</span>`;
    chip.addEventListener('click', () => socket.emit('theme:select', { themeId: t.id }));
    picker.appendChild(chip);
  });

  el('game-settings').appendChild(gameSettingsPanel());

  const teamsBox = el('table-teams');
  teamsBox.innerHTML = '<div class="section-title">Teams <span class="muted" style="text-transform:none;font-weight:600">— reassign players or remove empty teams</span></div>';
  teamsBox.appendChild(teamManagementConsole());

  const audioSlot = el('spotify-slot');
  audioSlot.innerHTML = '';
  audioSlot.appendChild(audioModeEl());
  const djLobbyPanel = djPanel();
  if (djLobbyPanel) audioSlot.appendChild(djLobbyPanel);
  // The Web Playback SDK only matters when this machine is the one playing.
  if (snap.audioMode === 'table') audioSlot.appendChild(spotifyStatusEl());

  const startBtn = el('btn-start');
  const canStart = teamsWithMembers.length >= 1;
  startBtn.disabled = !canStart;
  el('start-hint').textContent = !canStart
    ? 'Waiting for at least one team with a player…'
    : snap.audioMode === 'dj'
      ? (djTaken() ? '' : '↑ Nobody is the DJ yet — no music will play')
      : (jukeboxReady ? '' : '↑ Connect Spotify so songs can play (Premium)');
  startBtn.addEventListener('click', () => {
    if (snap.audioMode === 'dj' && !djTaken()) {
      const go = confirm('Nobody has taken the DJ role yet, so no music will play.\n\nClick Cancel, then have the person with the speaker tap “I’m the DJ” on their phone.\nOr click OK to start without music.');
      if (!go) return;
    } else if (snap.audioMode === 'table' && spotifyConfigured && !jukeboxReady) {
      const go = confirm('Spotify isn’t connected yet — no music will play.\n\nClick Cancel, then tap “Connect” above and log in (Premium account).\nOr click OK to play without music.');
      if (!go) return;
    }
    if (snap.audioMode === 'table') SpotifyJukebox.activate(); // unlock audio within this user gesture
    socket.emit('game:start', {}, (res) => { if (res && !res.ok) alert(res.error); });
  });
}

function renderTableGame(body) {
  const currentTeam = snap.teams.find((t) => t.id === snap.currentTeamId);
  const revealed = snap.turn && snap.turn.revealed;
  const awaitingSteal = snap.turn && snap.turn.awaitingSteal;
  body.innerHTML = `<div class="table-grid"><div class="table-main">
      <div class="banner you" style="animation:none">${currentTeam ? currentTeam.emoji + ' ' + escapeHtml(currentTeam.name) + '’s turn' : ''}</div>
      <div class="now-playing" id="now-playing"></div>
      <div class="table-teams" id="table-teams"></div>
    </div></div>`;

  const np = el('now-playing');
  if (revealed) {
    const t = snap.turn;
    np.innerHTML = `<div class="now-playing-info">
        <div style="font-weight:800">${t.correct ? '✅ Correct!' : '❌ Wrong'} — ${t.card.year} · ${escapeHtml(t.card.title)} <span class="muted">— ${escapeHtml(t.card.artist)}</span></div>
        ${guessSummaryHtml(t)}
        ${snap.winnerTeamId ? '' : powerOffersHtml(t)}
      </div>`;
    wirePowerButtons(np);
    const next = document.createElement('button');
    next.className = 'btn btn-primary btn-sm';
    next.style.marginLeft = 'auto';
    next.textContent = snap.winnerTeamId ? 'See the winner 🏆' : nextActionLabel(t);
    next.addEventListener('click', () => socket.emit('turn:advance'));
    np.appendChild(next);
  } else if (awaitingSteal) {
    np.innerHTML = `<div class="now-playing-info">
        <div style="font-weight:800">🕵️ Challenge window open</div>
        <div class="muted">${currentTeam ? escapeHtml(currentTeam.name) + ' locked in' : ''} — another team can spend a 🎫 bonus card to challenge where the song goes. Reveal once they’ve had their chance.</div>
      </div>`;
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-primary btn-sm';
    reveal.style.marginLeft = 'auto';
    reveal.textContent = 'Reveal now →';
    reveal.addEventListener('click', () => socket.emit('turn:reveal'));
    np.appendChild(reveal);
  } else {
    const risk = snap.wrongGuessPolicy === 'lose' && snap.turn.runGainsCount > 0
      ? `<div class="risk-banner" style="margin:6px 0 0">⚠️ ${snap.turn.runGainsCount} card${snap.turn.runGainsCount === 1 ? '' : 's'} at risk this turn</div>` : '';
    np.innerHTML = `<div class="eq"><span></span><span></span><span></span><span></span></div>
      <div class="now-playing-info"><div style="font-weight:800">Now playing a mystery track…</div><div class="muted">${currentTeam ? escapeHtml(currentTeam.name) + ' is placing it' : ''}</div>${risk}</div>`;
    const replay = document.createElement('button');
    replay.className = 'btn btn-ghost btn-sm';
    replay.style.marginLeft = 'auto';
    replay.textContent = '🔊 Replay';
    replay.addEventListener('click', () => { SpotifyJukebox.activate(); socket.emit('jukebox:replay'); });
    np.appendChild(replay);
  }

  // Several failures in a row — auto-redraw is paused so we don't burn
  // through the whole song pool. This needs to be impossible to miss.
  if (jukeboxStalled) {
    const stall = document.createElement('div');
    stall.className = 'risk-banner';
    stall.style.margin = '10px 0';
    stall.innerHTML = `⚠️ <b>Spotify's having trouble</b> (${escapeHtml(jukeboxStalled.reason || 'unknown')}) — several songs in a row failed, so auto-skip is paused.
      Check the connection below, then hit <b>🔊 Replay</b> or <b>🔀 New song</b> to keep going.`;
    el('table-teams').before(stall);
  }

  // live Spotify status so problems are visible on the table during play
  const status = document.createElement('div');
  status.className = 'qr-cap';
  status.style.textAlign = 'left';
  if (snap.audioMode === 'dj') {
    // The table holds no Spotify connection in this mode — the only thing that
    // can go wrong here is that nobody is holding the DJ role.
    status.textContent = djTaken()
      ? `🔊 ${djName()} is the DJ`
      : '🔇 Nobody is the DJ — someone needs to tap “I’m the DJ”';
    const p = djPanel();
    if (p && iAmDj()) el('table-teams').before(p);
  }
  else if (jukeboxError) status.innerHTML = `<span style="color:var(--bad)">⚠️ ${escapeHtml(jukeboxError)}</span>`;
  else if (!spotifyConfigured) status.textContent = '🔇 Spotify not configured — no music (see README).';
  else if (!jukeboxToken) status.innerHTML = '🔇 Spotify not connected. <b>Reset to lobby and click Connect.</b>';
  else if (!jukeboxReady) status.textContent = '⏳ Spotify connecting…';
  else status.textContent = jukeboxPlaying ? '🔊 Playing' : '🎧 Spotify ready';
  el('table-teams').before(status);

  const teamsBox = el('table-teams');
  snap.teams.forEach((t) => teamsBox.appendChild(tableTeamRow(t, t.id === snap.currentTeamId)));

  body.querySelector('.table-main').style.paddingBottom = '84px'; // clear the control tray
  body.appendChild(tableControlTray());
}

// Always-reachable table controls so a game can never get stuck.
function tableControlTray() {
  const tray = document.createElement('div');
  tray.className = 'control-tray';

  const mk = (label, onClick, cls) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + (cls || 'btn-ghost');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  tray.appendChild(mk('🔀 New song', () => {
    SpotifyJukebox.activate();
    socket.emit('admin:redraw');
  }));
  tray.appendChild(mk('⏭️ Skip team', () => {
    SpotifyJukebox.activate();
    socket.emit('admin:skip');
  }));
  if (jukeboxToken) {
    tray.appendChild(mk(jukeboxPlaying ? '⏸️ Pause' : '▶️ Play', () => SpotifyJukebox.togglePlay()));
  }
  tray.appendChild(mk('🎵 Theme', () => openThemeSwitcher()));
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  tray.appendChild(spacer);
  tray.appendChild(mk('↺ Lobby', () => {
    if (confirm('Send everyone back to the lobby? Timelines are cleared but teams stay.')) socket.emit('game:reset');
  }));
  tray.appendChild(mk('🏁 End game', () => {
    if (confirm('End the game now and show the standings?')) socket.emit('admin:end');
  }));
  return tray;
}

// Mid-game theme switcher overlay (table only).
function openThemeSwitcher() {
  const existing = document.getElementById('theme-switcher');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'theme-switcher';
  ov.className = 'reveal'; // reuse the dimmed backdrop styling
  const card = document.createElement('div');
  card.className = 'reveal-card';
  card.style.maxWidth = '640px';
  card.innerHTML = `<div class="reveal-verdict">🎵 Switch theme</div>
    <p class="muted" style="margin-top:0">Cards already earned stay. The current team gets a fresh song from the new pool.</p>`;
  const picker = document.createElement('div');
  picker.className = 'theme-picker';
  picker.style.justifyContent = 'center';
  availableThemes.forEach((t) => {
    const chip = document.createElement('button');
    chip.className = 'theme-chip' + (t.id === snap.themeId ? ' sel' : '');
    chip.innerHTML = `<span class="theme-emoji">${t.emoji}</span>
      <span class="theme-name">${escapeHtml(t.name)}</span>
      <span class="theme-count">${t.count} songs</span>`;
    chip.addEventListener('click', () => {
      SpotifyJukebox.activate();
      socket.emit('theme:select', { themeId: t.id });
      ov.remove();
    });
    picker.appendChild(chip);
  });
  card.appendChild(picker);
  const close = document.createElement('button');
  close.className = 'btn btn-ghost btn-block';
  close.style.marginTop = '18px';
  close.textContent = 'Cancel';
  close.addEventListener('click', () => ov.remove());
  card.appendChild(close);
  ov.appendChild(card);
  document.body.appendChild(ov);
}

// Lobby-only house rules: songs per turn, what a wrong guess costs, bonus toggle.
function gameSettingsPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'settings-panel';

  const streakRow = document.createElement('div');
  streakRow.className = 'setting-row';
  streakRow.innerHTML = `<div class="setting-label">🎵 Songs per turn <span class="muted">— keep going while you're right</span></div>`;
  const streakSeg = document.createElement('div');
  streakSeg.className = 'segmented';
  [[1, '1'], [2, '2'], [3, '3'], [5, '5'], [0, '∞']].forEach(([val, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = val === snap.maxStreak ? 'sel' : '';
    b.addEventListener('click', () => socket.emit('settings:update', { maxStreak: val }));
    streakSeg.appendChild(b);
  });
  streakRow.appendChild(streakSeg);
  wrap.appendChild(streakRow);

  const missRow = document.createElement('div');
  missRow.className = 'setting-row' + (snap.maxStreak === 1 ? ' disabled' : '');
  missRow.innerHTML = `<div class="setting-label">❌ On a wrong guess <span class="muted">${snap.maxStreak === 1 ? '— only matters when songs per turn > 1' : '— what happens to this turn\'s cards'}</span></div>`;
  const missSeg = document.createElement('div');
  missSeg.className = 'segmented';
  [['keep', 'Keep cards'], ['lose', 'Lose them']].forEach(([val, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = val === snap.wrongGuessPolicy ? 'sel' : '';
    b.disabled = snap.maxStreak === 1;
    b.addEventListener('click', () => socket.emit('settings:update', { wrongGuessPolicy: val }));
    missSeg.appendChild(b);
  });
  missRow.appendChild(missSeg);
  wrap.appendChild(missRow);

  const bonusRow = document.createElement('div');
  bonusRow.className = 'setting-row';
  bonusRow.innerHTML = `<div class="setting-label">🎤 Title/artist bonus guessing <span class="muted">— name both, save a bonus card</span></div>`;
  const toggle = document.createElement('button');
  toggle.className = 'switch' + (snap.bonusGuessingEnabled ? ' on' : '');
  toggle.innerHTML = '<span class="knob"></span>';
  toggle.addEventListener('click', () => socket.emit('settings:update', { bonusGuessingEnabled: !snap.bonusGuessingEnabled }));
  bonusRow.appendChild(toggle);
  wrap.appendChild(bonusRow);

  if (snap.bonusGuessingEnabled) wrap.appendChild(powersChecklist());

  return wrap;
}

// Bonus cards (saved by naming a song correctly — see the inventory badge on
// team rows) can be spent on optional powers. Each is its own checkbox;
// ticking one reveals its cost/tuning fields. Nothing here is automatic —
// a team always chooses when (and whether) to cash in what they've saved.
const POWER_DEFS = [
  { key: 'extraSong', emoji: '🎵', label: 'Extra song', hint: 'past the per-turn cap, pay to keep going' },
  { key: 'saveWinnings', emoji: '🛟', label: 'Save your winnings', hint: "about to lose this turn's cards? pay to keep them" },
  { key: 'yearMargin', emoji: '📏', label: 'Year margin', hint: 'missed by a little? pay to count it as correct' },
  { key: 'randomCard', emoji: '🎲', label: 'Random card', hint: 'pay for a guaranteed card, straight onto your timeline' },
  { key: 'steal', emoji: '🕵️', label: 'Steal (challenge)', hint: "after another team places, pay to say where it really goes — steal the card if they were wrong" },
];

// What each enabled power currently costs, per the table's settings — shown
// as the badge's tooltip so a team can check prices without leaving the game.
function powersCostSummary() {
  const enabled = POWER_DEFS.filter((def) => snap.powers && snap.powers[def.key] && snap.powers[def.key].enabled);
  if (!enabled.length) return 'No powers enabled yet — cards are just banked for now.';
  return enabled.map((def) => `${def.emoji} ${def.label}: ${snap.powers[def.key].cost}`).join(' · ');
}

// Bonus-card balance. Shown any time bonus guessing is on (even before any
// power is switched on) so a team can see cards piling up as they earn them —
// not just once a power exists to spend them on.
function tokenBadgeHtml(team) {
  if (!snap.bonusGuessingEnabled) return '';
  return ` · <span class="token-badge" title="${escapeHtml(powersCostSummary())}">🎫 ${team.tokens || 0}</span>`;
}

function powersChecklist() {
  const box = document.createElement('div');
  box.className = 'powers-box';
  box.innerHTML = '<div class="setting-label">🎫 Bonus card powers <span class="muted">— what a saved bonus card can buy</span></div>';

  const emit = (key, patch) => socket.emit('settings:update', { powers: { [key]: patch } });
  const numField = (labelText, value, min, onChange) => {
    const field = document.createElement('label');
    field.className = 'power-field';
    field.textContent = labelText + ' ';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.value = String(value);
    input.addEventListener('change', () => {
      const v = Math.max(min, Math.round(Number(input.value) || min));
      input.value = String(v);
      onChange(v);
    });
    field.appendChild(input);
    return field;
  };

  POWER_DEFS.forEach((def) => {
    const p = snap.powers[def.key];
    const row = document.createElement('div');
    row.className = 'power-row';

    const head = document.createElement('label');
    head.className = 'power-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.addEventListener('change', () => emit(def.key, { enabled: cb.checked }));
    head.appendChild(cb);
    const text = document.createElement('span');
    text.innerHTML = `${def.emoji} <b>${def.label}</b> <span class="muted">— ${def.hint}</span>`;
    head.appendChild(text);
    row.appendChild(head);

    if (p.enabled) {
      const config = document.createElement('div');
      config.className = 'power-config';
      config.appendChild(numField('Cost', p.cost, 1, (v) => emit(def.key, { cost: v })));
      if (def.key === 'saveWinnings') config.appendChild(numField('Max uses/game', p.maxUses, 1, (v) => emit(def.key, { maxUses: v })));
      if (def.key === 'yearMargin') config.appendChild(numField('Margin (years)', p.margin, 1, (v) => emit(def.key, { margin: v })));
      row.appendChild(config);
    }
    box.appendChild(row);
  });

  return box;
}

// Host-only lobby console: see every team + its players (with connection
// status), reassign players between teams / to unassigned, and remove teams
// (empty ones won't be dealt in; removing a team drops its players to the pool).
function teamManagementConsole() {
  const box = document.createElement('div');
  box.className = 'team-console';

  const memberRow = (p, currentTeamId) => {
    const row = document.createElement('div');
    row.className = 'tm-member';
    const off = p.connected ? '' : ' <span class="tm-off" title="Disconnected">· offline</span>';
    const who = document.createElement('span');
    who.className = 'tm-who';
    who.innerHTML = `${p.emoji} ${escapeHtml(p.name)}${off}`;
    row.appendChild(who);
    const sel = document.createElement('select');
    sel.className = 'tm-move';
    sel.title = 'Move to another team';
    const optU = new Option('— Unassigned —', '');
    if (!currentTeamId) optU.selected = true;
    sel.appendChild(optU);
    snap.teams.forEach((t) => {
      const opt = new Option(`${t.emoji} ${t.name}`, t.id);
      if (t.id === currentTeamId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => socket.emit('admin:movePlayer', { playerId: p.id, teamId: sel.value || null }));
    row.appendChild(sel);
    return row;
  };

  snap.teams.forEach((t) => {
    const connected = t.members.filter((m) => m.connected).length;
    const empty = t.members.length === 0;
    const allOff = !empty && connected === 0;
    const card = document.createElement('div');
    card.className = 'tm-team' + (empty || allOff ? ' tm-empty' : '');
    card.style.setProperty('--team', t.color);
    const head = document.createElement('div');
    head.className = 'tm-head';
    const tag = empty ? '<span class="tm-tag">empty</span>' : (allOff ? '<span class="tm-tag">all offline</span>' : '');
    head.innerHTML = `<span class="tm-name">${t.emoji} ${escapeHtml(t.name)}</span>
      <span class="muted tm-count">${t.members.length} player${t.members.length === 1 ? '' : 's'}</span>${tag}`;
    const rm = document.createElement('button');
    rm.className = 'btn btn-ghost btn-sm tm-remove';
    rm.textContent = '🗑';
    rm.title = empty ? 'Remove this empty team' : 'Remove team (players go back to unassigned)';
    rm.addEventListener('click', () => {
      if (empty || confirm(`Remove “${t.name}”? Its ${t.members.length} player(s) go back to unassigned.`)) {
        socket.emit('admin:removeTeam', { teamId: t.id });
      }
    });
    head.appendChild(rm);
    card.appendChild(head);
    if (empty) {
      const hint = document.createElement('div');
      hint.className = 'muted tm-hint';
      hint.textContent = 'No players — won’t be dealt into the game. Safe to remove.';
      card.appendChild(hint);
    } else {
      t.members.forEach((m) => card.appendChild(memberRow(m, t.id)));
    }
    box.appendChild(card);
  });

  if (snap.lobbyPool.length) {
    const card = document.createElement('div');
    card.className = 'tm-team tm-unassigned';
    card.innerHTML = `<div class="tm-head"><span class="tm-name">🧍 Unassigned</span> <span class="muted tm-count">${snap.lobbyPool.length}</span></div>`;
    snap.lobbyPool.forEach((p) => card.appendChild(memberRow(p, null)));
    box.appendChild(card);
  }

  if (!snap.teams.length && !snap.lobbyPool.length) {
    box.innerHTML = '<p class="muted">No players yet — share the QR to get people in.</p>';
  }
  return box;
}

function tableTeamRow(t, active) {
  const row = document.createElement('div');
  row.className = 'table-team-row' + (active ? ' active' : '');
  row.style.setProperty('--team', t.color);
  const head = document.createElement('div');
  head.className = 'team-head';
  head.innerHTML = `<span class="team-emoji">${t.emoji}</span>
    <span class="team-name">${escapeHtml(t.name)}</span>
    ${tokenBadgeHtml(t).replace(/^ · /, '')}
    <span class="team-score-pill">${t.score}/${snap.target}</span>`;
  // per-team referee controls during play (host/table only)
  if (role === 'host' && snap.phase === 'playing') {
    const adm = document.createElement('span');
    adm.className = 'team-admin';
    const mk = (label, title, onClick) => {
      const b = document.createElement('button');
      b.className = 'team-admin-btn';
      b.textContent = label; b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    adm.appendChild(mk('−', 'Score −1', () => socket.emit('admin:score', { teamId: t.id, delta: -1 })));
    adm.appendChild(mk('+', 'Score +1', () => socket.emit('admin:score', { teamId: t.id, delta: 1 })));
    adm.appendChild(mk('↩︎', 'Undo last card', () => socket.emit('admin:undo', { teamId: t.id })));
    head.appendChild(adm);
  }
  row.appendChild(head);
  const tl = buildTimeline(t, { withSlots: false });
  row.appendChild(tl);
  return row;
}

// ---- Spotify status widget (table only) ----
function spotifyStatusEl() {
  const box = document.createElement('div');
  box.className = 'spotify-status';
  const dot = document.createElement('span');
  dot.className = 'dot' + (jukeboxReady ? ' on' : '');
  box.appendChild(dot);
  const label = document.createElement('span');
  label.style.flex = '1';
  if (jukeboxReady) label.textContent = 'Spotify connected 🎧';
  else if (jukeboxError) { label.innerHTML = `<span style="color:var(--bad)">⚠️ ${escapeHtml(jukeboxError)}</span>`; }
  else if (jukeboxToken) label.textContent = 'Starting player…';
  else if (!spotifyConfigured) label.textContent = 'Spotify not configured (see README)';
  else label.textContent = 'Not connected';
  box.appendChild(label);
  // Always offer a way in when the player isn't actually ready — including the
  // "Starting player…" limbo where a stale token never produced a ready event.
  // Never leave the table with no button to click.
  if (spotifyConfigured && !jukeboxReady) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-good btn-sm';
    btn.textContent = jukeboxToken ? 'Reconnect' : 'Connect';
    btn.addEventListener('click', () => SpotifyJukebox.connect());
    box.appendChild(btn);
  }
  // On-screen SDK diagnostics — so a stuck player can be diagnosed from a
  // screenshot without opening DevTools. Only shown when not yet connected.
  if (!jukeboxReady && jukeboxDiag && jukeboxDiag.length) {
    const diag = document.createElement('details');
    diag.className = 'spotify-diag';
    diag.style.cssText = 'flex-basis:100%;margin-top:8px;font-size:12px;';
    const sum = document.createElement('summary');
    sum.textContent = '🔎 Spotify player log (tap to expand)';
    sum.style.cssText = 'cursor:pointer;color:var(--muted);';
    diag.appendChild(sum);
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.5;';
    pre.textContent = jukeboxDiag.join('\n');
    diag.appendChild(pre);
    box.appendChild(diag);
  }
  return box;
}

// ===========================================================================
// Jukebox wiring (host only) — bridges server cues to the Spotify SDK
// ===========================================================================
let jukeboxReady = false;
let jukeboxToken = null;
let spotifyConfigured = false;
let jukeboxPlaying = false;
let jukeboxError = null;
let jukeboxStalled = null; // {reason, detail} once the server's failure-cascade breaker trips
let jukeboxDiag = []; // SDK lifecycle log lines, shown on-screen when the player won't start
let jukeboxSig = '';
let availableThemes = [];
let lastReportedFailure = ''; // dedupe guard so the same failure isn't reported twice

let jukeboxInited = false;
function initJukebox() {
  if (jukeboxInited) return; // registering the socket handlers twice would double-fire
  jukeboxInited = true;
  fetch('/themes').then((r) => r.json()).then((t) => {
    availableThemes = t;
    if (role === 'host' && snap && snap.phase === 'lobby') renderTable();
  }).catch(() => {});

  socket.on('jukebox:play', (payload = {}) => {
    jukeboxStalled = null; // a fresh card being cued means we're no longer stuck
    // DJ mode sends only an id, and only to the DJ's device. Table mode sends
    // the whole card to the host, which needs it to search the Web API.
    if (payload.spotifyId !== undefined) {
      djTrack = { turnId: payload.turnId, spotifyId: payload.spotifyId, linkStyle: payload.linkStyle };
      if (role === 'player') renderPlayer();
      else if (role === 'host') renderTable(); // the host may be the DJ itself
      return;
    }
    if (role === 'host') SpotifyJukebox.play(payload.card);
  });
  socket.on('jukebox:stop', () => {
    // Nothing can stop playback in DJ mode — Spotify owns it — so just retire
    // the stale play button rather than leaving it tappable.
    djTrack = null;
    if (role === 'host') { SpotifyJukebox.pause(); renderTable(); }
    else if (role === 'player') renderPlayer();
  });
  // Several song failures in a row — the server paused auto-redraw rather
  // than silently burning through the whole theme. Surface it clearly so the
  // table knows to check the Spotify connection instead of just seeing dead air.
  socket.on('jukebox:stall', ({ reason, detail } = {}) => {
    jukeboxStalled = { reason, detail };
    if (role === 'host') renderTable();
  });

  SpotifyJukebox.onState = (s) => {
    jukeboxReady = s.ready;
    jukeboxToken = s.token;
    spotifyConfigured = s.configured;
    jukeboxPlaying = s.playing;
    jukeboxError = s.error;
    jukeboxDiag = s.diag || [];
    // A song that couldn't be found/played gets reported once, so the table
    // can build a "songs to fix" list and skip it in future games — and the
    // game keeps moving instead of sitting stuck on a track that'll never play.
    if (s.failedCard) {
      const failKey = s.failedCard.card.id + '|' + s.failedCard.reason;
      if (failKey !== lastReportedFailure) {
        lastReportedFailure = failKey;
        socket.emit('song:failed', s.failedCard);
      }
    }
    // Re-render only when something meaningful changed (avoids churn). Include
    // the diag length so the on-screen SDK log updates line-by-line as it fills.
    const sig = [s.ready, s.hasDevice, s.token, s.configured, s.playing, s.error, (s.diag || []).length].join('|');
    if (sig !== jukeboxSig) { jukeboxSig = sig; if (role === 'host') renderTable(); }
  };
}

// Only the table ever runs Spotify's player. Kept separate from initJukebox so
// player phones still get the socket wiring without spinning up an SDK they
// have no use for.
function initTableSpotify() {
  initJukebox();
  SpotifyJukebox.init();
}


// ===========================================================================
// The DJ — one phone plays each song in its own Spotify app
// ===========================================================================
// Only the Spotify id ever reaches this device (see cueAudio in server.js), so
// nothing rendered here can give the answer away before Spotify itself does.
let djTrack = null; // { turnId, spotifyId, linkStyle }

function iAmDj() {
  if (!snap) return false;
  return role === 'host' ? !!snap.djIsHost : !!(myId && snap.djPlayerId === myId);
}
function djTaken() { return !!(snap && (snap.djPlayerId || snap.djIsHost)); }

function djName() {
  if (snap && snap.djIsHost) return 'The table';
  if (!snap || !snap.djPlayerId) return null;
  const p = [...allPlayers()].find((x) => x.id === snap.djPlayerId);
  return p ? `${p.emoji} ${p.name}` : 'someone';
}

// The custom scheme is handed straight to the Spotify app by iOS. The https
// link is smoother when it works, but only reaches the app on a phone that has
// opened Spotify from a link before — otherwise it quietly lands in Spotify's
// web player, which cannot use the phone's Bluetooth output and shows the
// title immediately. Hence scheme by default.
function djDeepLink(spotifyId, style) {
  return style === 'https'
    ? 'https://open.spotify.com/track/' + spotifyId
    : 'spotify:track:' + spotifyId;
}

function djPanel() {
  if (!snap || snap.audioMode !== 'dj') return null;

  // Someone else is holding it — everyone else just needs to know who.
  if (djTaken() && !iAmDj()) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `🔊 ${djName()} is the DJ`;
    return note;
  }

  const box = document.createElement('div');
  box.className = 'audio-panel';

  // Nobody has claimed it. The role follows the phone that is paired to the
  // speaker, so only a player (not the table) can take it.
  if (!djTaken()) {
    const h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = '🔊 Who has the speaker?';
    box.appendChild(h);
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'The DJ’s device plays every song in its own Spotify app, so the sound comes out wherever that device is connected. Whoever is paired to the speaker should take this.';
    box.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-block';
    btn.textContent = role === 'host' ? '🎧 This device is the DJ' : '🎧 I’m the DJ';
    btn.addEventListener('click', () => socket.emit('dj:claim', {}, (res) => {
      if (res && !res.ok) alert(res.error || 'Could not take the DJ role.');
    }));
    box.appendChild(btn);
    return box;
  }

  // It's me.
  const h = document.createElement('div');
  h.className = 'section-title';
  h.textContent = role === 'host' ? '🎧 This device is the DJ' : '🎧 You’re the DJ';
  box.appendChild(h);

  const cued = djTrack && snap.turn && djTrack.turnId === snap.turn.id;

  if (cued && djTrack.spotifyId) {
    // A real anchor, not a scripted navigation: iOS is far more willing to
    // hand a tapped link to another app than a programmatic location change.
    const a = document.createElement('a');
    a.className = 'btn btn-good btn-block btn-play';
    // Live session setting first, cue-time value only as a fallback: the DJ
    // flips this precisely because the current link isn't opening, so it has to
    // affect the button in front of them, not just the next song.
    a.href = djDeepLink(djTrack.spotifyId, snap.linkStyle || djTrack.linkStyle);
    a.rel = 'noreferrer';
    a.textContent = '▶︎ Play the song';
    box.appendChild(a);
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Spotify takes over and starts playing on its own — turn the phone face down, then come back here.';
    box.appendChild(p);
  } else if (cued && !djTrack.spotifyId) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'This song has no Spotify id yet — ask the table to redraw it.';
    box.appendChild(p);
  } else {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Waiting for the next song…';
    box.appendChild(p);
  }

  // Which link style actually reaches the app varies by phone, so let the DJ
  // switch it here rather than walking back to the table.
  const usingHttps = snap.linkStyle === 'https';
  const styleBtn = document.createElement('button');
  styleBtn.className = 'btn btn-ghost btn-sm';
  styleBtn.textContent = usingHttps
    ? 'Landing in the browser? Switch to app links'
    : 'Spotify not opening? Switch to browser links';
  styleBtn.addEventListener('click', () => socket.emit('audio:linkStyle', { style: usingHttps ? 'scheme' : 'https' }));
  box.appendChild(styleBtn);

  const hand = document.createElement('button');
  hand.className = 'btn btn-ghost btn-sm';
  hand.textContent = 'Hand the DJ role over';
  hand.addEventListener('click', () => socket.emit('dj:release'));
  box.appendChild(hand);

  return box;
}

// Table lobby: where the music comes out.
function audioModeEl() {
  const box = document.createElement('div');
  box.className = 'audio-panel';
  const h = document.createElement('div');
  h.className = 'section-title';
  h.textContent = '🔈 Where does the music play?';
  box.appendChild(h);

  const opts = [
    { mode: 'dj', label: '🎧 A player’s phone (DJ)', blurb: 'No Spotify setup at all. One phone opens each song in its own Spotify app and plays through whatever it’s connected to.' },
    { mode: 'table', label: '💻 This machine', blurb: 'Needs a Spotify Premium login here and speakers attached — but no player ever sees a track.' },
  ];
  opts.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'btn btn-block ' + (snap.audioMode === o.mode ? 'btn-good' : 'btn-ghost');
    b.innerHTML = `<strong>${o.label}</strong><br><small class="muted">${escapeHtml(o.blurb)}</small>`;
    b.addEventListener('click', () => socket.emit('audio:mode', { mode: o.mode }));
    box.appendChild(b);
  });

  return box;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
