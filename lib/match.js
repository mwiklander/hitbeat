'use strict';

// ---------------------------------------------------------------------------
// Fuzzy matching for the title/artist bonus guess. Party-game tolerant:
// typos, missing "The", reordered words, missing diacritics, and common
// text-speak ("2" -> "to") should all count as correct. Wrong songs should
// not. No dependencies — small, self-contained, and unit-testable in isolation
// (see the validation script run during development).
// ---------------------------------------------------------------------------

// Unicode combining diacritical marks block (U+0300–U+036F), built from code
// points rather than a literal char range to avoid any source-encoding risk.
const DIACRITICS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function normalize(str) {
  return String(str || '')
    .normalize('NFD').replace(DIACRITICS_RE, '') // strip diacritics (e.g. -> e)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')                  // drop parenthetical/bracketed suffixes
    .replace(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')                       // punctuation -> space
    .replace(/\b2\b/g, 'to').replace(/\b4\b/g, 'for').replace(/\bu\b/g, 'you') // light text-speak
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[bl];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// One string fully containing the other (handles missing "The", extra words).
function containmentMatch(a, b) {
  if (a.length < 3 || b.length < 3) return a === b; // avoid trivial short-string false positives
  return a.includes(b) || b.includes(a);
}

// Same words, any order (handles "Bieber Justin" vs "Justin Bieber").
function tokenOverlapRatio(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size);
}

const SIMILARITY_THRESHOLD = 0.78;
const TOKEN_OVERLAP_THRESHOLD = 0.75;

// Returns { isMatch, score } — score is the best signal found, for debugging/tuning.
function fuzzyScore(guess, canonical) {
  const g = normalize(guess);
  const c = normalize(canonical);
  if (!g || !c) return { isMatch: false, score: 0 };
  if (g === c) return { isMatch: true, score: 1 };
  if (containmentMatch(g, c)) return { isMatch: true, score: 0.95 };
  const sim = similarity(g, c);
  const overlap = tokenOverlapRatio(g, c);
  const score = Math.max(sim, overlap);
  return { isMatch: sim >= SIMILARITY_THRESHOLD || overlap >= TOKEN_OVERLAP_THRESHOLD, score };
}

function fuzzyMatch(guess, canonical) {
  return fuzzyScore(guess, canonical).isMatch;
}

function matchTitle(guess, title) {
  if (!guess || !String(guess).trim()) return null; // no guess made
  return fuzzyMatch(guess, title);
}

// Split "Mark Ronson feat. Bruno Mars" into candidates so naming any credited
// artist (not just the primary one) counts.
function artistCandidates(canonicalArtist) {
  const raw = String(canonicalArtist || '');
  const parts = raw
    .split(/\s*(?:feat\.?|ft\.?|featuring|&|,|\bx\b|\bvs\.?\b|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([raw, ...parts])];
}

function matchArtist(guess, canonicalArtist) {
  if (!guess || !String(guess).trim()) return null; // no guess made
  return artistCandidates(canonicalArtist).some((c) => fuzzyMatch(guess, c));
}

module.exports = {
  normalize, levenshtein, similarity, fuzzyScore, fuzzyMatch,
  artistCandidates, matchTitle, matchArtist,
};
