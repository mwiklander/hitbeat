#!/bin/bash
#
# Unattended chunk of track-id resolving, meant to be run on a timer until the
# backlog is gone. One pass: resolve what today's quota allows, rebuild All
# Songs, commit, push, and redeploy the Mini.
#
# Spotify's Development Mode quota is roughly 700 calls per rolling 24h, so
# this cannot finish in one run — it resumes from data/track-ids.json each
# time. Scheduled every 6 hours rather than daily on purpose: the quota window
# is rolling, so a fixed daily slot drifts a little later than the reset every
# day and would eventually never catch it. A run that finds no quota costs one
# 429 and exits.
#
#   scripts/resolve-daily.sh          run a pass
#   scripts/resolve-daily.sh --check  print status, change nothing
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="/Users/magnus/git/hitbeat"
KIT="/Users/magnus/git/mini-deploy"
LOG="$REPO/data/resolve-daily.log"
BUDGET=650

cd "$REPO" || exit 1
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M')" "$*" >> "$LOG"; }

remaining() {
  node -e '
    const fs=require("fs"); const {keyOf}=require("./scripts/resolve-track-ids.js");
    let cache={}; try{cache=JSON.parse(fs.readFileSync("data/track-ids.json","utf8"));}catch{}
    const want=new Set();
    for (const f of fs.readdirSync("data/themes")) {
      if (f==="mixed.json") continue;
      for (const s of JSON.parse(fs.readFileSync("data/themes/"+f,"utf8")).songs||[]) {
        const k=keyOf(s); if(!cache[k]||(!cache[k].spotifyId&&!cache[k].miss)) want.add(k);
      }
    }
    console.log(want.size);
  ' 2>/dev/null || echo "?"
}

if [[ "${1:-}" == "--check" ]]; then
  echo "unresolved songs remaining: $(remaining)"
  echo "--- last 20 log lines ---"
  tail -20 "$LOG" 2>/dev/null || echo "(no log yet)"
  exit 0
fi

# Refuse to run on a dirty tree — this script commits, and it must never sweep
# up someone's half-finished edit into an unattended commit.
if [[ -n "$(git status --porcelain -- data scripts 2>/dev/null)" ]]; then
  say "SKIP: working tree has uncommitted changes under data/ or scripts/"
  exit 0
fi

LEFT_BEFORE=$(remaining)
if [[ "$LEFT_BEFORE" == "0" ]]; then
  say "done — nothing left to resolve. Disable the timer with: launchctl bootout gui/\$(id -u)/se.wiklander.hitbeat-resolve"
  exit 0
fi

say "starting: $LEFT_BEFORE songs unresolved, budget $BUDGET calls"
OUT=$(node scripts/resolve-daily-run.js "$BUDGET" 2>&1)
say "$(echo "$OUT" | grep -E 'Lookups done|quota|matched|API calls' | tail -3 | tr '\n' ' ')"

LEFT_AFTER=$(remaining)
if [[ "$LEFT_AFTER" == "$LEFT_BEFORE" ]]; then
  say "no progress (quota not yet reset) — $LEFT_AFTER still to go"
  exit 0
fi

node scripts/build-all-songs.js >> "$LOG" 2>&1

if [[ -z "$(git status --porcelain -- data)" ]]; then
  say "resolver made no file changes; nothing to commit"
  exit 0
fi

RESOLVED=$((LEFT_BEFORE - LEFT_AFTER))
git add -- data
git commit -q -m "Resolve $RESOLVED more track ids ($LEFT_AFTER still to go)

Automated pass by scripts/resolve-daily.sh, bounded by the Spotify
Development Mode quota. Re-run resumes from data/track-ids.json." || { say "commit failed"; exit 1; }

if git push -q origin main 2>>"$LOG"; then
  say "committed and pushed: +$RESOLVED resolved, $LEFT_AFTER remaining"
else
  say "committed locally but PUSH FAILED — will retry next run"
  exit 0
fi

if [[ -x "$KIT/bin/service-update" ]]; then
  if "$KIT/bin/service-update" hitbeat >> "$LOG" 2>&1; then
    say "deployed to the Mini"
  else
    say "deploy FAILED — the Mini is still on the previous version"
  fi
fi

[[ "$LEFT_AFTER" == "0" ]] && say "ALL SONGS RESOLVED — the timer can be removed now."
exit 0
