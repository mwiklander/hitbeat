'use strict';

// Regenerates data/themes/mixed.json ("All Songs") as the de-duplicated union
// of every OTHER theme file. Run this after adding/editing songs in any
// individual theme so "All Songs" stays in sync:
//
//   node scripts/build-all-songs.js
//
// Restart the server afterwards to pick up the change.

const fs = require('fs');
const path = require('path');
const { writeTheme } = require('./theme-file');

const dir = path.join(__dirname, '..', 'data', 'themes');
// A theme may opt out of the merge with "excludeFromMixed": true. That exists
// for themes using a different dating convention: "Billboard No. 1s" dates a
// song by the year it topped the chart, which disagrees with the release-style
// year used everywhere else for 54 songs. Merging both would leave "All Songs"
// telling players two different years for the same record depending on which
// theme happened to win the de-duplication.
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'mixed.json')
  .filter((f) => {
    try {
      if (!JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).excludeFromMixed) return true;
      console.log(`Skipping ${f} — excludeFromMixed is set.`);
      return false;
    } catch { return true; }
  });

const seen = new Map(); // normalized "title|artist" -> song
let totalBeforeDedup = 0;

for (const f of files) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const s of t.songs) {
    totalBeforeDedup++;
    const key = (s.title + '|' + s.artist).toLowerCase().trim().replace(/\s+/g, ' ');
    // Carry spotifyId across: without it, regenerating "All Songs" silently
    // strips every baked track id and the theme stops working in DJ mode
    // until the resolver is re-run over ~1,800 songs.
    if (!seen.has(key)) {
      const song = { title: s.title, artist: s.artist, year: s.year };
      if (s.spotifyId) song.spotifyId = s.spotifyId;
      seen.set(key, song);
    } else if (s.spotifyId && !seen.get(key).spotifyId) {
      seen.get(key).spotifyId = s.spotifyId; // first theme lacked one, a later one has it
    }
  }
}

const songs = [...seen.values()].sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));

const out = {
  id: 'mixed',
  name: 'All Songs',
  emoji: '🌐',
  blurb: `Everything in one pool — ${songs.length} songs spanning every theme`,
  target: 10,
  songs,
};

writeTheme('mixed.json', out); // one song per line — see scripts/theme-file.js

console.log('Merged', files.length, 'themes:', files.join(', '));
console.log('Total songs before dedup:', totalBeforeDedup);
console.log('Unique songs after dedup:', songs.length, `(${totalBeforeDedup - songs.length} cross-theme duplicates removed)`);
