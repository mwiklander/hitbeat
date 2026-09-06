'use strict';
// Thin wrapper: run the resolver across every theme with a call budget.
// Kept separate so resolve-daily.sh has no argument-mangling to get wrong.
const { spawnSync } = require('child_process');
const budget = parseInt(process.argv[2] || '650', 10);
const r = spawnSync(process.execPath, [__dirname + '/resolve-track-ids.js', `--max-calls=${budget}`], {
  stdio: 'inherit',
  cwd: __dirname + '/..',
});
process.exit(r.status === null ? 1 : r.status);
