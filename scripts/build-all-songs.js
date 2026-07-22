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

const dir = path.join(__dirname, '..', 'data', 'themes');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'mixed.json');

const seen = new Map(); // normalized "title|artist" -> song
let totalBeforeDedup = 0;

for (const f of files) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const s of t.songs) {
    totalBeforeDedup++;
    const key = (s.title + '|' + s.artist).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!seen.has(key)) seen.set(key, { title: s.title, artist: s.artist, year: s.year });
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

fs.writeFileSync(path.join(dir, 'mixed.json'), JSON.stringify(out, null, 2) + '\n');

console.log('Merged', files.length, 'themes:', files.join(', '));
console.log('Total songs before dedup:', totalBeforeDedup);
console.log('Unique songs after dedup:', songs.length, `(${totalBeforeDedup - songs.length} cross-theme duplicates removed)`);
