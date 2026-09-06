'use strict';

// Shared reader/writer for data/themes/*.json.
//
// The house style is one song per line: a theme is a few thousand lines of
// nearly-identical records, and JSON.stringify's expanded form turns a two-song
// edit into a diff nobody can review. Both the resolver and the All Songs
// merger write theme files, so the serialiser lives here rather than in either.

const fs = require('fs');
const path = require('path');

const THEME_DIR = path.join(__dirname, '..', 'data', 'themes');

function readTheme(f) {
  return JSON.parse(fs.readFileSync(path.join(THEME_DIR, f), 'utf8'));
}

// Key order is fixed (title, artist, year, spotifyId, then anything else) so
// that re-serialising a file is a no-op when nothing has actually changed.
function writeTheme(f, theme) {
  const { songs, ...head } = theme;
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const songLines = songs.map((s) => {
    const parts = [
      `"title": ${JSON.stringify(s.title)}`,
      `"artist": ${JSON.stringify(s.artist)}`,
      `"year": ${JSON.stringify(s.year)}`,
    ];
    if (s.spotifyId) parts.push(`"spotifyId": ${JSON.stringify(s.spotifyId)}`);
    for (const [k, v] of Object.entries(s)) {
      if (!['title', 'artist', 'year', 'spotifyId'].includes(k)) parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
    return `    { ${parts.join(', ')} }`;
  });
  const out = '{\n' + headLines.join(',\n') + ',\n  "songs": [\n' + songLines.join(',\n') + '\n  ]\n}\n';
  fs.writeFileSync(path.join(THEME_DIR, f), out);
}

module.exports = { THEME_DIR, readTheme, writeTheme };
