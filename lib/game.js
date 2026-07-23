'use strict';

const { matchTitle, matchArtist } = require('./match');

// ---------------------------------------------------------------------------
// Hitster-style game engine. Pure logic, no networking. The server wraps this
// and broadcasts sanitized snapshots over socket.io.
//
// Core rule: a mystery song plays. The active team places it on their timeline
// relative to the years they already own. Correct if the song's year fits
// between its chosen neighbours (ties allowed). Correct placements are kept;
// first team to TARGET cards wins.
//
// Bonus rule (optional, like real Hitster): while listening, the active team
// may also type a title and/or artist guess. If the year placement is
// correct AND both guesses fuzzy-match, the team banks a token instead of an
// instant reward.
//
// Tokens are a spendable currency. The game master enables zero or more
// "powers" (each with its own settings) that a team can pay tokens for at the
// moment they're relevant — the engine surfaces the offer only when it
// actually applies:
//   - extraSong:    past the per-turn cap? Pay to draw one more song anyway.
//   - saveWinnings: about to forfeit this run's cards (the 'lose' wrong-guess
//                   policy)? Pay to keep them instead. Capped at maxUses/game.
//   - yearMargin:   missed by a small margin? Pay to count it as correct.
// ---------------------------------------------------------------------------

const TEAM_COLORS = [
  '#ff5c8a', '#4dd0e1', '#ffd54f', '#7e57c2',
  '#66bb6a', '#ff8a65', '#42a5f5', '#ec407a',
];

const TEAM_EMOJI = ['🦩', '🐙', '🦊', '🐸', '🦄', '🐝', '🦖', '🐼', '🦁', '🐨'];

const ADJECTIVES = [
  'Groovy', 'Funky', 'Turbo', 'Cosmic', 'Sneaky', 'Velvet', 'Electric',
  'Disco', 'Rowdy', 'Mellow', 'Neon', 'Glitter', 'Jazzy', 'Wild',
];
const NOUNS = [
  'Gerbils', 'Llamas', 'Comets', 'Waffles', 'Ninjas', 'Otters', 'Rockets',
  'Pandas', 'Sardines', 'Wizards', 'Badgers', 'Narwhals', 'Pineapples',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTeamName() {
  return `The ${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let idCounter = 1;
function uid(prefix) {
  return `${prefix}_${(idCounter++).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

class Session {
  constructor(code, songs) {
    this.code = code;
    this.songs = songs; // full curated pool [{title, artist, year, uri}]
    this.players = new Map(); // playerId -> {id, name, emoji, teamId, connected}
    this.teams = []; // {id, name, color, emoji, timeline:[track], score}
    this.phase = 'lobby'; // lobby | playing | ended
    this.target = 10;
    this.themeId = null;   // set by the server from data/themes/*
    this.themeName = null;
    this.themeEmoji = null;
    this.deck = [];
    this.usedIds = new Set();
    this.currentTeamIdx = 0;
    this.turn = null; // active turn, see startTurn()
    this.winnerTeamId = null;
    this.createdAt = Date.now();
    this._teamColorIdx = 0;
    this._teamEmojiIdx = 0;

    // ---- game settings (lobby-only; game master sets these before starting) --
    this.maxStreak = 1;              // songs a team may keep playing in a row; 0 = unlimited (until wrong)
    this.wrongGuessPolicy = 'keep';  // 'keep' = keep this run's cards on a miss; 'lose' = forfeit them
    this.bonusGuessingEnabled = true; // title/artist bonus round on/off
    this.powers = {
      extraSong: { enabled: false, cost: 2 },
      saveWinnings: { enabled: false, cost: 3, maxUses: 3 },
      yearMargin: { enabled: false, cost: 2, margin: 1 },
      randomCard: { enabled: false, cost: 3 },
      steal: { enabled: false, cost: 2 },
    };

    // ---- current "run" state (a run = one team's consecutive correct songs) --
    this.streak = 0;   // correct placements in a row this run
    this.runGains = []; // cards earned this run, for the 'lose' policy
  }

  // Lobby-only: game master tunes the house rules before starting.
  applySettings({ maxStreak, wrongGuessPolicy, bonusGuessingEnabled, powers } = {}) {
    if (this.phase !== 'lobby') return false;
    if (maxStreak !== undefined && [0, 1, 2, 3, 5].includes(Number(maxStreak))) this.maxStreak = Number(maxStreak);
    if (wrongGuessPolicy === 'keep' || wrongGuessPolicy === 'lose') this.wrongGuessPolicy = wrongGuessPolicy;
    if (typeof bonusGuessingEnabled === 'boolean') this.bonusGuessingEnabled = bonusGuessingEnabled;
    if (powers && typeof powers === 'object') {
      for (const key of ['extraSong', 'saveWinnings', 'yearMargin', 'randomCard', 'steal']) {
        const incoming = powers[key];
        const cur = this.powers[key];
        if (!incoming || typeof incoming !== 'object') continue;
        if (typeof incoming.enabled === 'boolean') cur.enabled = incoming.enabled;
        if (Number.isFinite(Number(incoming.cost)) && Number(incoming.cost) >= 1) cur.cost = Math.round(Number(incoming.cost));
        if (key === 'saveWinnings' && Number.isFinite(Number(incoming.maxUses)) && Number(incoming.maxUses) >= 1) {
          cur.maxUses = Math.round(Number(incoming.maxUses));
        }
        if (key === 'yearMargin' && Number.isFinite(Number(incoming.margin)) && Number(incoming.margin) >= 1) {
          cur.margin = Math.round(Number(incoming.margin));
        }
      }
    }
    return true;
  }

  canAfford(team, key) {
    const p = this.powers[key];
    return !!(p && p.enabled && team && team.tokens >= p.cost);
  }

  // ---- lobby ----------------------------------------------------------------

  addPlayer(name, emoji) {
    const id = uid('p');
    const player = { id, name: name.trim().slice(0, 20) || 'Player', emoji: emoji || '🎧', teamId: null, connected: true };
    this.players.set(id, player);
    return player;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.leaveTeam(playerId);
    this.players.delete(playerId);
  }

  createTeam(playerId, opts = {}) {
    if (this.phase !== 'lobby') return null;
    const team = {
      id: uid('t'),
      name: (opts.name && opts.name.trim().slice(0, 24)) || randomTeamName(),
      color: opts.color || TEAM_COLORS[this._teamColorIdx++ % TEAM_COLORS.length],
      emoji: opts.emoji || TEAM_EMOJI[this._teamEmojiIdx++ % TEAM_EMOJI.length],
      timeline: [],
      score: 0,
    };
    this.teams.push(team);
    if (playerId) this.joinTeam(playerId, team.id);
    return team;
  }

  joinTeam(playerId, teamId) {
    if (this.phase !== 'lobby') return;
    const p = this.players.get(playerId);
    const team = this.teams.find((t) => t.id === teamId);
    if (!p || !team) return;
    p.teamId = teamId;
  }

  leaveTeam(playerId) {
    if (this.phase !== 'lobby') return;
    const p = this.players.get(playerId);
    if (!p) return;
    const oldTeam = p.teamId;
    p.teamId = null;
    // clean up empty teams
    if (oldTeam && !this.membersOf(oldTeam).length) {
      this.teams = this.teams.filter((t) => t.id !== oldTeam);
    }
  }

  renameTeam(teamId, name) {
    const team = this.teams.find((t) => t.id === teamId);
    if (team && name) team.name = name.trim().slice(0, 24);
  }

  membersOf(teamId) {
    return [...this.players.values()].filter((p) => p.teamId === teamId);
  }

  canStart() {
    const teamsWithMembers = this.teams.filter((t) => this.membersOf(t.id).length > 0);
    return teamsWithMembers.length >= 1 && this.songs.length > teamsWithMembers.length + 2;
  }

  // ---- game flow ------------------------------------------------------------

  startGame() {
    if (this.phase !== 'lobby' || !this.canStart()) return false;
    // drop empty teams
    this.teams = this.teams.filter((t) => this.membersOf(t.id).length > 0);
    this.deck = shuffle(this.songs);
    this.usedIds = new Set();
    // deal one revealed anchor card to each team
    for (const team of this.teams) {
      const card = this.drawCard();
      if (card) {
        team.timeline = [card];
        team.score = 0; // anchor doesn't count toward win target
        team.added = []; // score cards in insertion order (for undo); excludes anchor
        team.titleHits = 0; // correctly-named songs, for end-game flavor stats
        team.artistHits = 0;
        team.tokens = 0; // spendable currency, earned via the bonus-guess round
        team.saveWinningsUsed = 0; // caps how many times 'saveWinnings' can be spent
      }
    }
    this.phase = 'playing';
    this.currentTeamIdx = 0;
    this.streak = 0;
    this.runGains = [];
    this.startTurn();
    return true;
  }

  drawCard() {
    while (this.deck.length) {
      const card = this.deck.pop();
      if (!this.usedIds.has(card.id)) {
        this.usedIds.add(card.id);
        return card;
      }
    }
    // reshuffle unused if we somehow ran dry
    const remaining = this.songs.filter((s) => !this.usedIds.has(s.id));
    if (!remaining.length) return null;
    this.deck = shuffle(remaining);
    const card = this.deck.pop();
    this.usedIds.add(card.id);
    return card;
  }

  startTurn() {
    const team = this.teams[this.currentTeamIdx];
    const card = this.drawCard();
    if (!card) {
      // out of songs: highest score wins
      return this.endGame();
    }
    this.turn = {
      id: uid('turn'),
      teamId: team.id,
      card, // secret until revealed
      revealed: false,
      slotIndex: null,
      correct: null,
    };
    return this.turn;
  }

  // Place the mystery card at slotIndex in the active team's sorted timeline.
  // slotIndex 0 = before the first card, n = after the last. `guesses` is an
  // optional { titleGuess, artistGuess } — the Hitster-style bonus round.
  placeCard(playerId, slotIndex, guesses = {}) {
    if (this.phase !== 'playing' || !this.turn || this.turn.revealed || this.turn.awaitingSteal) return null;
    const player = this.players.get(playerId);
    if (!player) return null;
    const team = this.teams.find((t) => t.id === this.turn.teamId);
    if (!team || player.teamId !== team.id) return null; // only the active team places

    const sorted = [...team.timeline].sort((a, b) => a.year - b.year);
    const leftYear = slotIndex > 0 ? sorted[slotIndex - 1].year : -Infinity;
    const rightYear = slotIndex < sorted.length ? sorted[slotIndex].year : Infinity;
    const y = this.turn.card.year;
    const correct = y >= leftYear && y <= rightYear;

    // Record the active team's placement + bonus-guess verdicts. Side effects
    // (adding the card, scoring, tokens) are deferred to _revealAndResolve so a
    // blind "steal" challenge window can open in between, before the year shows.
    this.turn.slotIndex = slotIndex;
    this.turn.correct = correct;
    this.turn.placedBy = player.id;
    this.turn.leftYear = leftYear;   // kept for the yearMargin power's post-reveal rescue
    this.turn.rightYear = rightYear;

    // Bonus guess evaluation — null means "didn't guess", true/false is a verdict.
    // Ignored entirely (forced null) when the game master has switched it off.
    this.turn.titleCorrect = this.bonusGuessingEnabled ? matchTitle(guesses.titleGuess, this.turn.card.title) : null;
    this.turn.artistCorrect = this.bonusGuessingEnabled ? matchArtist(guesses.artistGuess, this.turn.card.artist) : null;
    this.turn.titleGuess = this.bonusGuessingEnabled ? ((guesses.titleGuess || '').trim() || null) : null;
    this.turn.artistGuess = this.bonusGuessingEnabled ? ((guesses.artistGuess || '').trim() || null) : null;

    // If the steal power is on and another team can afford it, hold the reveal
    // open for one blind challenge instead of revealing right away.
    if (this._stealWindowApplies()) {
      this.turn.awaitingSteal = true;
      return this.turn; // card identity stays hidden until reveal
    }
    this._revealAndResolve();
    return this.turn;
  }

  // True when a blind steal-challenge window should open after the active team
  // locks in: the power is enabled and at least one OTHER team can pay for it.
  _stealWindowApplies() {
    const p = this.powers.steal;
    if (!p || !p.enabled || !this.turn) return false;
    return this.teams.some((t) => t.id !== this.turn.teamId && this.canAfford(t, 'steal'));
  }

  // Another team spends a bonus card to challenge the active placement, proposing
  // a different slot in the ACTIVE team's timeline (blind — the year is hidden).
  // First come, first served: one challenge per song. Reveals immediately after.
  attemptSteal(playerId, slotIndex) {
    if (this.phase !== 'playing' || !this.turn || !this.turn.awaitingSteal || this.turn.steal) return false;
    const player = this.players.get(playerId);
    if (!player || !player.teamId || player.teamId === this.turn.teamId) return false; // must be a different team
    const team = this.teams.find((t) => t.id === player.teamId);
    if (!team || !this.canAfford(team, 'steal')) return false;

    // Judge the challenger's slot against the ACTIVE team's (still-unchanged) timeline.
    const activeTeam = this.teams.find((t) => t.id === this.turn.teamId);
    const sorted = [...activeTeam.timeline].sort((a, b) => a.year - b.year);
    const leftYear = slotIndex > 0 ? sorted[slotIndex - 1].year : -Infinity;
    const rightYear = slotIndex < sorted.length ? sorted[slotIndex].year : Infinity;

    team.tokens -= this.powers.steal.cost; // always consumed, win or lose
    this.turn.steal = { teamId: team.id, byPlayer: player.id, slotIndex, leftYear, rightYear };
    this._revealAndResolve();
    return true;
  }

  // Close the steal window with no challenge (active team or table gives up
  // waiting) — reveal and resolve the active placement as usual.
  revealNow() {
    if (this.phase !== 'playing' || !this.turn || !this.turn.awaitingSteal || this.turn.revealed) return false;
    this._revealAndResolve();
    return true;
  }

  // Apply the active team's placement outcome, then settle any steal challenge.
  // A steal only pays out when the active team was WRONG and the challenger's
  // proposed slot was RIGHT — then the card (and the point) go to the challenger.
  _revealAndResolve() {
    this.turn.revealed = true;
    this.turn.awaitingSteal = false;
    const team = this.teams.find((t) => t.id === this.turn.teamId);
    const y = this.turn.card.year;

    if (this.turn.titleCorrect) team.titleHits = (team.titleHits || 0) + 1;
    if (this.turn.artistCorrect) team.artistHits = (team.artistHits || 0) + 1;

    if (this.turn.correct) {
      team.timeline.push(this.turn.card);
      team.timeline.sort((a, b) => a.year - b.year);
      (team.added || (team.added = [])).push(this.turn.card);
      team.score += 1;
      this.streak += 1;
      this.runGains.push(this.turn.card);
      if (team.score >= this.target) this.winnerTeamId = team.id;

      // Named both the song and the artist? Bank a spendable token.
      if (this.turn.titleCorrect && this.turn.artistCorrect) {
        team.tokens = (team.tokens || 0) + 1;
        this.turn.tokenEarned = true;
      }
    }

    if (this.turn.steal) {
      const chTeam = this.teams.find((t) => t.id === this.turn.steal.teamId);
      const chCorrect = y >= this.turn.steal.leftYear && y <= this.turn.steal.rightYear;
      this.turn.steal.correct = chCorrect;
      this.turn.steal.won = !this.turn.correct && chCorrect;
      if (this.turn.steal.won && chTeam) {
        chTeam.timeline.push(this.turn.card);
        chTeam.timeline.sort((a, b) => a.year - b.year);
        (chTeam.added || (chTeam.added = [])).push(this.turn.card);
        chTeam.score += 1;
        if (chTeam.score >= this.target) this.winnerTeamId = chTeam.id;
      }
    }
  }

  // ---- bonus token powers ---------------------------------------------------

  // Past the per-turn cap after a correct placement? Pay to draw one more song
  // for the same team anyway.
  buyExtraSong(teamId) {
    if (this.phase !== 'playing' || !this.turn || !this.turn.revealed || !this.turn.correct) return false;
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || team.id !== this.turn.teamId) return false;
    if (!this.canAfford(team, 'extraSong')) return false;
    team.tokens -= this.powers.extraSong.cost;
    this.startTurn(); // same team, one more song — streak/cap bookkeeping unchanged
    return true;
  }

  // About to forfeit this run's cards under the 'lose' wrong-guess policy?
  // Pay to keep them. Capped at maxUses per team per game.
  useSaveWinnings(teamId) {
    if (this.phase !== 'playing' || !this.turn || !this.turn.revealed || this.turn.correct) return false;
    if (this.wrongGuessPolicy !== 'lose') return false;
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || team.id !== this.turn.teamId) return false;
    const p = this.powers.saveWinnings;
    if (!this.canAfford(team, 'saveWinnings')) return false;
    if ((team.saveWinningsUsed || 0) >= p.maxUses) return false;
    team.tokens -= p.cost;
    team.saveWinningsUsed = (team.saveWinningsUsed || 0) + 1;
    this.turn.savedWinnings = true; // advance() checks this to skip the revert
    return true;
  }

  // Missed by a small margin? Pay to count it as correct after all — the card
  // joins the timeline for real, exactly as if the placement had been right.
  useYearMargin(teamId) {
    if (this.phase !== 'playing' || !this.turn || !this.turn.revealed || this.turn.correct) return false;
    if (this.turn.steal && this.turn.steal.won) return false; // card already went to the challenger
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || team.id !== this.turn.teamId) return false;
    if (!this.canAfford(team, 'yearMargin')) return false;
    const margin = this.powers.yearMargin.margin;
    const y = this.turn.card.year;
    const withinMargin = y >= this.turn.leftYear - margin && y <= this.turn.rightYear + margin;
    if (!withinMargin) return false;

    team.tokens -= this.powers.yearMargin.cost;
    this.turn.correct = true;
    this.turn.marginUsed = true;
    team.timeline.push(this.turn.card);
    team.timeline.sort((a, b) => a.year - b.year);
    (team.added || (team.added = [])).push(this.turn.card);
    team.score += 1;
    this.streak += 1;
    this.runGains.push(this.turn.card);
    if (team.score >= this.target) this.winnerTeamId = team.id;
    if (this.turn.titleCorrect && this.turn.artistCorrect) {
      team.tokens += 1;
      this.turn.tokenEarned = true;
    }
    return true;
  }

  // Cash in bonus cards for a guaranteed card: draws a fresh song and adds it
  // straight to the timeline — no listening, no guessing, no placement risk.
  // Available on the reveal screen (either outcome) during the team's turn.
  useRandomCard(teamId) {
    if (this.phase !== 'playing' || !this.turn || !this.turn.revealed) return false;
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || team.id !== this.turn.teamId) return false;
    if (!this.canAfford(team, 'randomCard')) return false;
    const card = this.drawCard();
    if (!card) return false; // deck exhausted

    team.tokens -= this.powers.randomCard.cost;
    team.timeline.push(card);
    team.timeline.sort((a, b) => a.year - b.year);
    (team.added || (team.added = [])).push(card);
    team.score += 1;
    this.runGains.push(card);
    if (team.score >= this.target) this.winnerTeamId = team.id;
    this.turn.randomCardDrawn = card;
    return true;
  }

  // Revert every card earned during the current run (the 'lose' wrong-guess
  // policy). Defensive about cards an admin may have already undone.
  revertRunGains(team) {
    for (const card of this.runGains) {
      const i = team.timeline.indexOf(card);
      if (i >= 0) team.timeline.splice(i, 1);
      const j = team.added.indexOf(card);
      if (j >= 0) team.added.splice(j, 1);
      team.score = Math.max(0, team.score - 1);
    }
    if (this.winnerTeamId === team.id && team.score < this.target) this.winnerTeamId = null;
  }

  // End the current run (pass turn to the next team), resetting streak state.
  passToNextTeam() {
    this.streak = 0;
    this.runGains = [];
    this.currentTeamIdx = (this.currentTeamIdx + 1) % this.teams.length;
    this.startTurn();
  }

  advance() {
    if (this.phase !== 'playing' || !this.turn || !this.turn.revealed) return false;
    if (this.winnerTeamId) {
      this.phase = 'ended';
      this.turn = null;
      return true;
    }

    const team = this.teams.find((t) => t.id === this.turn.teamId);
    if (this.turn.correct) {
      // Correct: keep going for the same team unless they've hit the cap.
      const cap = this.maxStreak; // 0 = unlimited
      if (!cap || this.streak < cap) {
        this.startTurn(); // same team, fresh mystery song
      } else {
        this.passToNextTeam();
      }
    } else {
      // Wrong: the run ends. Apply the house rule for what they keep, unless
      // the team already paid to save their winnings this turn.
      if (this.wrongGuessPolicy === 'lose' && team && !this.turn.savedWinnings) this.revertRunGains(team);
      this.passToNextTeam();
    }
    return true;
  }

  endGame() {
    this.phase = 'ended';
    if (!this.winnerTeamId && this.teams.length) {
      const best = [...this.teams].sort((a, b) => b.score - a.score)[0];
      this.winnerTeamId = best ? best.id : null;
    }
    this.turn = null;
  }

  // ---- recovery / table controls -------------------------------------------
  // Abandon the current mystery track and draw a fresh one for the SAME team.
  // No score change — the "give them another chance" escape hatch.
  redraw() {
    if (this.phase !== 'playing' || !this.teams.length) return false;
    this.startTurn(); // startTurn draws for the current team without advancing
    return true;
  }

  // Abandon the current turn and move on to the next team. A referee override,
  // never punitive — the team keeps whatever it already earned this run.
  skipTeam() {
    if (this.phase !== 'playing' || !this.teams.length) return false;
    this.passToNextTeam();
    return true;
  }

  // Remove a team's most-recently-added card (fixes a mis-scored placement).
  // Never touches the anchor card. Score drops with it.
  undoLast(teamId) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team || !team.added || !team.added.length) return false;
    const card = team.added.pop();
    const i = team.timeline.indexOf(card);
    if (i >= 0) team.timeline.splice(i, 1);
    team.score = Math.max(0, team.score - 1);
    if (this.winnerTeamId === teamId && team.score < this.target) this.winnerTeamId = null;
    return true;
  }

  // Manual score nudge (house-rule bonus / correction). Doesn't touch cards.
  adjustScore(teamId, delta) {
    const team = this.teams.find((t) => t.id === teamId);
    if (!team) return false;
    team.score = Math.max(0, team.score + (delta > 0 ? 1 : -1));
    if (this.winnerTeamId === teamId && team.score < this.target) this.winnerTeamId = null;
    return true;
  }

  // Switch song pool mid-game: fresh deck from the new theme, current team
  // gets a new mystery track from it. Timelines already earned stay put.
  reshuffleForTheme() {
    this.deck = shuffle(this.songs);
    this.usedIds = new Set();
    if (this.phase === 'playing') this.startTurn();
  }

  // ---- snapshots ------------------------------------------------------------

  // Public snapshot: hides the identity of the in-flight mystery card.
  snapshot() {
    const teams = this.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      emoji: t.emoji,
      score: t.score,
      target: this.target,
      titleHits: t.titleHits || 0,
      artistHits: t.artistHits || 0,
      tokens: t.tokens || 0,
      saveWinningsUsed: t.saveWinningsUsed || 0,
      members: this.membersOf(t.id).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, connected: p.connected })),
      // timeline sorted by year; each card shows year always, title/artist for the flip side
      timeline: [...t.timeline].sort((a, b) => a.year - b.year),
    }));

    const lobbyPool = [...this.players.values()]
      .filter((p) => !p.teamId)
      .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, connected: p.connected }));

    let turn = null;
    if (this.turn) {
      turn = {
        id: this.turn.id,
        teamId: this.turn.teamId,
        revealed: this.turn.revealed,
        slotIndex: this.turn.slotIndex, // active team's chosen slot (visible during the steal window)
        // NEVER leak the verdict before reveal — it's computed at placement time now.
        correct: this.turn.revealed ? this.turn.correct : null,
        placedBy: this.turn.placedBy || null,
        streak: this.streak,
        runGainsCount: this.runGains.length,
        // Blind steal-challenge window (see attemptSteal): open after the active
        // team locks in, before the year is shown. Card identity stays hidden.
        awaitingSteal: !!this.turn.awaitingSteal,
        stealEnabled: !!this.powers.steal.enabled,
        stealCost: this.powers.steal.cost,
      };
      // reveal identity (and any bonus-guess verdicts) only after locked in
      if (this.turn.revealed) {
        turn.card = this.turn.card;
        turn.guesses = {
          title: this.turn.titleGuess || null,
          titleCorrect: this.turn.titleCorrect,
          artist: this.turn.artistGuess || null,
          artistCorrect: this.turn.artistCorrect,
        };
        turn.tokenEarned = !!this.turn.tokenEarned;
        turn.marginUsed = !!this.turn.marginUsed;
        turn.savedWinnings = !!this.turn.savedWinnings;
        turn.randomCardDrawn = this.turn.randomCardDrawn || null;
        turn.willPassTurn = !this.turn.correct || (this.maxStreak > 0 && this.streak >= this.maxStreak);

        // Steal challenge outcome (if any team challenged this song).
        if (this.turn.steal) {
          const st = this.turn.steal;
          const chTeam = this.teams.find((x) => x.id === st.teamId);
          turn.steal = {
            teamId: st.teamId,
            teamName: chTeam ? chTeam.name : '',
            teamEmoji: chTeam ? chTeam.emoji : '',
            slotIndex: st.slotIndex,
            correct: !!st.correct,
            won: !!st.won,
          };
        } else {
          turn.steal = null;
        }

        // Power offers — only surfaced when they'd actually apply.
        const activeTeam = this.teams.find((x) => x.id === this.turn.teamId);
        const stolen = !!(this.turn.steal && this.turn.steal.won);
        turn.canBuyExtraSong = this.turn.correct && turn.willPassTurn && this.canAfford(activeTeam, 'extraSong');
        turn.canSaveWinnings = !this.turn.correct && this.wrongGuessPolicy === 'lose'
          && this.canAfford(activeTeam, 'saveWinnings')
          && (activeTeam.saveWinningsUsed || 0) < this.powers.saveWinnings.maxUses;
        turn.canDrawRandomCard = !this.turn.randomCardDrawn && this.canAfford(activeTeam, 'randomCard');
        if (!this.turn.correct && !stolen) {
          const y = this.turn.card.year;
          const missBy = y < this.turn.leftYear ? this.turn.leftYear - y : (y > this.turn.rightYear ? y - this.turn.rightYear : 0);
          turn.missBy = missBy;
          turn.canUseMargin = missBy > 0 && missBy <= this.powers.yearMargin.margin && this.canAfford(activeTeam, 'yearMargin');
        } else {
          turn.missBy = 0;
          turn.canUseMargin = false;
        }
      }
    }

    return {
      code: this.code,
      phase: this.phase,
      target: this.target,
      themeId: this.themeId,
      themeName: this.themeName,
      themeEmoji: this.themeEmoji,
      maxStreak: this.maxStreak,
      wrongGuessPolicy: this.wrongGuessPolicy,
      bonusGuessingEnabled: this.bonusGuessingEnabled,
      powers: this.powers,
      teams,
      lobbyPool,
      playerCount: this.players.size,
      currentTeamId: this.teams[this.currentTeamIdx] ? this.teams[this.currentTeamIdx].id : null,
      turn,
      winnerTeamId: this.winnerTeamId,
      songCount: this.songs.length,
    };
  }
}

module.exports = { Session, randomTeamName, TEAM_COLORS, TEAM_EMOJI };
