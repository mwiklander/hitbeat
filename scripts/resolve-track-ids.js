'use strict';

// ===========================================================================
// resolve-track-ids.js — ONE-TIME BUILD STEP (not part of the running game).
//
// Looks every song up on Spotify once and bakes its track id into
// data/themes/*.json as "spotifyId". After this has run, the game needs NO
// Spotify credentials and NO OAuth at runtime: it just deep-links to
// https://open.spotify.com/track/<id>, which any Spotify account can open.
//
// Auth is the Client Credentials flow (app-level, no user login), so this does
// not consume one of the 5 Development Mode user slots.
//
// Usage:
//   node scripts/resolve-track-ids.js --only=christmas   # try a small theme first
//   node scripts/resolve-track-ids.js                    # everything
//   node scripts/resolve-track-ids.js --report           # audit, no API calls
//
// Flags:
//   --only=<a,b,c>    restrict to these theme files (comma-separated)
//   --limit=<n>       stop after n new lookups (quota-safe trial run)
//   --dry-run         search, but don't write theme files
//   --report          print the current state from cache only; no network
//   --retry-misses    re-search songs previously recorded as "no match"
//   --max-calls=<n>   stop after n API calls (stay deliberately under quota)
// ===========================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const THEME_DIR = path.join(__dirname, '..', 'data', 'themes');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'track-ids.json');
const OVERRIDE_FILE = path.join(__dirname, '..', 'data', 'track-id-overrides.json');

const args = process.argv.slice(2);
const flag = (n) => args.some((a) => a === '--' + n);
const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : null; };

const ONLY = opt('only') ? new Set(opt('only').split(',').map((x) => x.trim()).filter(Boolean)) : null;
const LIMIT = opt('limit') ? parseInt(opt('limit'), 10) : Infinity;
const DRY_RUN = flag('dry-run');
const REPORT = flag('report');
const RETRY_MISSES = flag('retry-misses');
const MAX_CALLS = opt('max-calls') ? parseInt(opt('max-calls'), 10) : Infinity;

// ---- the same normalisation the game already uses (public/spotify.js) ------
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const primaryArtist = (a) => String(a).split(/\s*(?:feat\.?|ft\.?|&|,|x)\s+/i)[0].trim();
const keyOf = (song) => norm(song.title) + '|' + norm(song.artist);

// ---- cache -----------------------------------------------------------------
// key -> { spotifyId, matchedTitle, matchedArtist, matchedYear, score } | { miss: true }
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

// Hand-picked corrections, for the cases automated scoring gets wrong (a
// re-recording that matches title and artist perfectly, say). Keys are
// "Title|Artist" as they appear on the card; values are a Spotify track URL or
// a bare id. These always win, and are never overwritten by a lookup.
function loadOverrides() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('//') || !v) continue; // allow "//note" comment keys
    const [title, artist] = String(k).split('|');
    const m = String(v).match(/([A-Za-z0-9]{22})/);
    if (!m) { console.warn(`   ⚠ override "${k}" is not a Spotify track id or URL — ignored`); continue; }
    out[norm(title) + '|' + norm(artist || '')] = m[1];
  }
  return out;
}

// ---- theme files -----------------------------------------------------------
function themeFiles() {
  return fs.readdirSync(THEME_DIR).filter((f) => f.endsWith('.json'))
    .filter((f) => !ONLY || ONLY.has(path.basename(f, '.json')))
    .sort();
}
const { readTheme, writeTheme } = require('./theme-file');

// ---- Spotify client credentials -------------------------------------------
let token = null;
let tokenExpiry = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiry - 30000) return token;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('\n✖ Missing credentials.\n');
    console.error('  This build step needs BOTH values in your .env:');
    console.error('    SPOTIFY_CLIENT_ID=...');
    console.error('    SPOTIFY_CLIENT_SECRET=...');
    console.error('\n  Get them at https://developer.spotify.com/dashboard → your app →');
    console.error('  Settings → "View client secret". The secret is only used here, by this');
    console.error('  one-time script; the game itself never sees it. .env is gitignored.\n');
    process.exit(1);
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    console.error(`✖ Token request failed (${res.status}). Check the Client ID / Secret in .env.`);
    process.exit(1);
  }
  const data = await res.json();
  token = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 429 with a short Retry-After is an ordinary burst limit — worth waiting out.
// A long one means the Development Mode quota is spent (it is shared across all
// of a developer account's Client IDs since July 2026), and that resets on a
// ~24h rolling window. Sleeping through that would hang the run for most of a
// day, so anything above this ceiling stops the run instead.
const MAX_BACKOFF_S = 120;
let apiCalls = 0;

// Search with 429 backoff. Returns { items } or { error }.
async function search(q, attempt = 0) {
  const tok = await getToken();
  // limit=10 is the Development Mode maximum since the Feb 2026 changes.
  const url = 'https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(q);
  apiCalls++;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  } catch (e) {
    if (attempt < 3) { await sleep(2000 * (attempt + 1)); return search(q, attempt + 1); }
    return { error: 'network' };
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '5', 10);
    let reason = '';
    try { reason = (await res.clone().json()).reason || ''; } catch (_) {}
    if (wait > MAX_BACKOFF_S) return { error: 'quota', retryAfter: wait, reason };
    console.warn(`   … rate limited${reason ? ' (' + reason + ')' : ''}, waiting ${wait}s`);
    await sleep((wait + 1) * 1000);
    if (attempt < 5) return search(q, attempt + 1);
    return { error: 'rate-limited' };
  }
  if (res.status === 401) { token = null; if (attempt < 2) return search(q, attempt + 1); return { error: 'auth' }; }
  if (!res.ok) return { error: 'http-' + res.status };
  const body = await res.json();
  return { items: ((body.tracks || {}).items || []) };
}

// Spotify labels alternate takes in a qualifier tail — "Title - Live",
// "Title (Karaoke Version)", "Title (Taylor's Version)". Only that tail is
// inspected, so a song genuinely called "Live and Let Die" isn't punished.
// Remaster/mono/stereo tails are deliberately NOT penalised: those ARE the
// original recording, just reissued.
function variantPenalty(trackName, cardTitle) {
  const tails = [];
  const dash = trackName.split(/\s+-\s+/).slice(1).join(' ');
  if (dash) tails.push(dash);
  for (const m of trackName.matchAll(/[([]([^)\]]+)[)\]]/g)) tails.push(m[1]);
  const tail = tails.join(' ').toLowerCase();
  if (!tail) return 0;
  const card = String(cardTitle).toLowerCase();
  let p = 0;
  // A re-recording is a different performance of the same song — the thing most
  // likely to be quietly wrong, since the title and artist both still match.
  if (/(taylor|\w+)'?s version|re-?record/.test(tail)) p -= 90;
  if (/\bkaraoke\b|\btribute\b|\bcover\b|\binstrumental\b|made famous|originally performed/.test(tail)) p -= 120;
  if (/\bsped up\b|\bslowed\b|\bnightcore\b/.test(tail)) p -= 100;
  if (/\blive\b|\bconcert\b|\bsession\b/.test(tail) && !/\blive\b/.test(card)) p -= 70;
  // "Radio Edit" / "Mono Edit" are usually the hit single version — the take
  // people actually recognise — so an edit is not a defect. A remix is.
  if (/\bremix\b/.test(tail) && !/\bremix\b/.test(card)) p -= 30;
  return p;
}

// Same shape as the runtime scoring v1 used, plus two signals it had no reason
// to weigh: variant penalties, and a nudge toward a release date that actually
// matches the card year (a strong hint it is the original single, not a reissue).
function pick(items, song) {
  const wantArtist = norm(primaryArtist(song.artist));
  const wantTitle = norm(song.title);
  const scored = items.map((t) => {
    const artistMatch = (t.artists || []).some((a) => norm(a.name).includes(wantArtist) || wantArtist.includes(norm(a.name)));
    const nt = norm(t.name);
    const titleMatch = nt === wantTitle || nt.includes(wantTitle);
    const relYear = parseInt(String((t.album || {}).release_date || '').slice(0, 4), 10) || null;
    const yearBonus = relYear && Math.abs(relYear - song.year) <= 2 ? 8 : 0;
    return {
      t,
      score: (artistMatch ? 100 : 0) + (titleMatch ? 40 : 0) + (t.popularity || 0) / 10
             + variantPenalty(t.name, song.title) + yearBonus,
    };
  }).sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

// Compact candidate record — keeping all 10 means the scoring above can be
// changed later and everything re-picked offline, without spending quota again.
function slim(t) {
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    year: parseInt(String((t.album || {}).release_date || '').slice(0, 4), 10) || null,
    pop: t.popularity || 0,
  };
}

async function resolve(song) {
  const artist = primaryArtist(song.artist);
  // Field-filtered query first (precise), then a plain query as a fallback —
  // odd punctuation and non-English titles often only match the loose form.
  for (const q of [`track:${song.title} artist:${artist}`, `${song.title} ${artist}`]) {
    const r = await search(q);
    if (r.error) return { error: r.error, retryAfter: r.retryAfter, reason: r.reason };
    if (!r.items.length) continue;
    const best = pick(r.items, song);
    if (!best) continue;
    const t = best.t;
    return {
      spotifyId: t.id,
      matchedTitle: t.name,
      matchedArtist: (t.artists || []).map((a) => a.name).join(', '),
      matchedYear: parseInt(String((t.album || {}).release_date || '').slice(0, 4), 10) || null,
      score: Math.round(best.score),
      candidates: r.items.map(slim),
    };
  }
  return { miss: true };
}

// ---- main ------------------------------------------------------------------
async function main() {
  const cache = loadCache();
  const files = themeFiles();
  if (!files.length) { console.error(`No theme files matched${ONLY ? ` --only=${[...ONLY].join(',')}` : ''}.`); process.exit(1); }

  // Unique work list across the selected themes (mixed.json duplicates every
  // other theme, so this roughly halves the number of API calls).
  const work = new Map(); // key -> song
  for (const f of files) for (const s of readTheme(f).songs || []) if (!work.has(keyOf(s))) work.set(keyOf(s), s);

  const overridden = loadOverrides();
  const needed = [...work.entries()].filter(([k]) => {
    if (overridden[k]) return false; // hand-picked; never spend quota on it
    const c = cache[k];
    if (!c) return true;
    if (c.miss && RETRY_MISSES) return true;
    return false;
  });

  console.log(`\n🎵 ${files.length} theme file(s) · ${work.size} unique songs · ${work.size - needed.length} already resolved`);

  if (REPORT) {
    const hits = [...work.keys()].filter((k) => cache[k] && cache[k].spotifyId);
    const misses = [...work.entries()].filter(([k]) => cache[k] && cache[k].miss);
    const ov = loadOverrides();
    // A variant tail on the matched title means a different PERFORMANCE slipped
    // through — that changes what players hear, so it actually matters. A late
    // release year with a clean title is just a compilation and is harmless,
    // since the card supplies the year, not Spotify.
    const variant = hits.map((k) => ({ k, c: cache[k], s: work.get(k) }))
      .filter(({ k, c, s }) => !ov[k] && variantPenalty(c.matchedTitle, s.title) < 0);
    const reissue = hits.map((k) => ({ k, c: cache[k], s: work.get(k) }))
      .filter(({ k, c, s }) => !ov[k] && c.matchedYear && Math.abs(c.matchedYear - s.year) > 2
                               && variantPenalty(c.matchedTitle, s.title) === 0);
    console.log(`   ✅ ${hits.length} matched · ❓ ${misses.length} no match`);
    console.log(`   🔴 ${variant.length} look like a different performance (live/karaoke/re-recording) — worth fixing`);
    console.log(`   ⚪ ${reissue.length} original recording on a later release — harmless`);
    if (Object.keys(ov).length) console.log(`   ✋ ${Object.keys(ov).length} pinned by hand in data/track-id-overrides.json`);
    console.log('');
    if (variant.length) {
      console.log('Likely a different performance — paste these into data/track-id-overrides.json with the right track URL:');
      for (const { c, s } of variant.slice(0, 60)) {
        console.log(`   "${s.title}|${s.artist}": "",   // got "${c.matchedTitle}" by ${c.matchedArtist} (${c.matchedYear})  https://open.spotify.com/track/${c.spotifyId}`);
      }
      if (variant.length > 60) console.log(`   …and ${variant.length - 60} more`);
      console.log('');
    }
    if (misses.length) {
      console.log('Not found on Spotify:');
      for (const [, sg] of misses.slice(0, 40)) console.log(`   ${sg.title} — ${sg.artist} (${sg.year})`);
      if (misses.length > 40) console.log(`   …and ${misses.length - 40} more`);
    }
    return;
  }

  // ---- lookups -------------------------------------------------------------
  let done = 0, found = 0, missed = 0, failed = 0, quotaHit = false;
  const todo = needed.slice(0, LIMIT === Infinity ? needed.length : LIMIT);
  if (todo.length) console.log(`   Looking up ${todo.length}…\n`);

  for (const [k, song] of todo) {
    if (apiCalls >= MAX_CALLS) { console.warn(`\n   Reached --max-calls=${MAX_CALLS}; stopping. Re-run to continue.`); quotaHit = true; break; }
    const r = await resolve(song);
    done++;
    if (r.error === 'quota') {
      const hrs = (r.retryAfter / 3600);
      const when = new Date(Date.now() + r.retryAfter * 1000);
      console.warn(`\n⏳ Development Mode quota spent${r.reason ? ' (' + r.reason + ')' : ''} after ${apiCalls} API calls this run.`);
      console.warn(`   It frees up in ${hrs.toFixed(1)}h — around ${when.toLocaleString()}.`);
      console.warn(`   Everything found so far is cached. Re-run the same command then and it picks up where it stopped.`);
      quotaHit = true;
      break;
    }
    if (r.error) {
      failed++;
      console.warn(`   ✖ ${song.title} — ${song.artist}: ${r.error}`);
      if (r.error === 'auth' || r.error === 'rate-limited') { console.warn('   Stopping early; re-run to resume where this left off.'); break; }
    } else if (r.miss) {
      missed++;
      cache[k] = { miss: true };
    } else {
      found++;
      cache[k] = r;
    }
    if (done % 25 === 0) { saveCache(cache); process.stdout.write(`   … ${done}/${todo.length} (${found} matched, ${missed} no match)\n`); }
    await sleep(120); // stay well inside the rate limit
  }
  saveCache(cache);
  if (todo.length) console.log(`\n   Lookups done: ${found} matched · ${missed} no match · ${failed} errored · ${apiCalls} API calls used`);

  // ---- bake ids into the theme files --------------------------------------
  if (DRY_RUN) { console.log('\n--dry-run: theme files not written.\n'); return; }

  const overrides = loadOverrides();
  if (Object.keys(overrides).length) console.log(`   (${Object.keys(overrides).length} manual override(s) applied)`);
  let written = 0, stamped = 0, unstamped = 0;
  for (const f of files) {
    const theme = readTheme(f);
    let touched = false;
    for (const s of theme.songs || []) {
      const c = cache[keyOf(s)];
      const id = overrides[keyOf(s)] || (c && c.spotifyId ? c.spotifyId : null);
      if (id) { stamped++; if (s.spotifyId !== id) { s.spotifyId = id; touched = true; } }
      else { unstamped++; if (s.spotifyId) { delete s.spotifyId; touched = true; } }
    }
    if (touched) { writeTheme(f, theme); written++; }
  }
  console.log(`\n✅ ${stamped} song entries carry a spotifyId · ${unstamped} still without · ${written} theme file(s) rewritten`);
  console.log(`   Audit anytime with:  node scripts/resolve-track-ids.js --report\n`);
}

module.exports = { readTheme, writeTheme, keyOf, norm, primaryArtist, pick, variantPenalty };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
