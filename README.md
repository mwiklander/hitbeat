# 🎵 Hitbeat — a music-timeline party game

A phone-friendly, Hitster-style party game. A mystery song plays; the team in
the hot seat guesses **where it fits on their timeline by year**. Guess right,
keep the card. First team to **10 cards** wins.

- **The "table"** — one device shows the QR code others scan, and displays every
  team's timeline. Any device will do: a laptop, a TV, a spare tablet, or just
  somebody's phone. Whoever taps **Start a new game** first becomes the table.
- **The DJ** — one phone plays the songs, through whatever it is connected to.
  Normally that is whoever is paired to the Bluetooth speaker.
- **The players** — everyone else, on their phones. Scan the QR, pick a name +
  emoji, self-assemble into teams, and place cards on your turn.

No accounts, no admin, no physical cards, and **no Spotify setup at all** for
the machine running the server — it needs no login, no credentials and no
speakers, so it can sit in a cupboard.

---

## 1. How the music plays

Two modes, chosen in the table's lobby.

### 🎧 A player's phone (the DJ) — the default

Each song comes with its Spotify track id baked into the theme files, so the
DJ's phone just opens `spotify:track:<id>` and Spotify starts playing. The
server never talks to Spotify.

- **Nothing to register, nothing to configure.** No Client ID, no OAuth, no
  API quota. Anyone can host a game.
- The DJ needs the **Spotify app** installed and signed in — their own account.
  Premium gives full songs; a free account works with ads and limits.
- Audio follows that phone: Bluetooth speaker, car, headphones, whatever.
- The DJ taps ▶ each round, then turns the phone face down. Spotify shows the
  track, so the DJ sees what is playing — the same trade-off Hitster has when
  you scan its cards with Spotify rather than its own app.

If a link opens Spotify's **web player** instead of the app, use the
**"Switch to browser links"** toggle on the DJ panel. iOS reaches the app
reliably via the `spotify:` scheme; the `https://` form only works once that
phone has opened Spotify from a link before.

### 💻 This machine — optional

The server's own browser becomes the Spotify player via the Web Playback SDK.
Nobody ever sees a track, which is its one advantage — but it needs speakers
attached, a **Premium** login, and a registered Spotify app:

1. Go to <https://developer.spotify.com/dashboard>, **Create app**.
   - **Redirect URI:** `http://127.0.0.1:8080/callback` — exactly this.
     `127.0.0.1`, **not** `localhost`; loopback is the only plain `http`
     address Spotify still accepts, which is why this mode only works in a
     browser on the same machine as the server.
   - Tick **Web Playback SDK** and **Web API**.
2. Copy the **Client ID** from Settings, then:

   ```bash
   cp .env.example .env
   # set: SPOTIFY_CLIENT_ID=your_client_id_here
   ```

No client secret is needed here — this uses the PKCE flow.

---

## 2. Run it

```bash
npm install     # first time only
npm start
```

```
🎵  Hitbeat is live!
   Everyone opens:  http://192.168.0.175:8080
   The first device to tap "Start a new game" becomes the board and shows
   the code for everyone else to scan. No screen needed on this machine.
```

Open that address on a phone, tap **Start a new game**, and that phone is the
table — it shows the QR code and the board. Everyone else scans it. If the
person holding it is also on the speaker, they can tap **This device is the DJ**
and run the whole game from one phone.

Prefer a big screen? Open the same address on a laptop or TV instead and start
the game there.

Everyone must be on the **same Wi-Fi** — unless you set `PUBLIC_URL`.

### Playing from outside the house

`PUBLIC_URL` decides what the QR code advertises. Leave it empty for a game in
one room. Point it at a public address — a [Cloudflare
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
is the tidy way, since it needs no forwarded ports — and remote players can
join:

```
PUBLIC_URL=https://hitbeat.example.com
```

Without it, remote players are handed a `192.168.x.x` address they cannot
reach. Put an authentication layer in front if you do this; Hitbeat has no
accounts and no login of its own.

---
## 3. How to play

1. **Pick a DJ.** Whoever's phone is on the speaker taps **🎧 I'm the DJ** —
   or the table taps **This device is the DJ** if it's doing both jobs. The
   role stays put for the whole game; nobody re-pairs Bluetooth mid-party.
2. **Join & team up.** Players scan the QR, pick a name + emoji, then either
   **join a team** or **start a new one**. Teams can be any size, mixed however
   you like. Tap your team's name to rename it.
3. **Start.** When at least one team has a player, the table's **Start game**
   button lights up. Each team is dealt one starting card (a revealed year).
4. **A mystery song plays.** The DJ taps **▶ Play the song** and turns the
   phone face down. The team whose turn it is listens, then on their
   phones taps a **slot** on their timeline — before, between, or after the
   years they already have.
5. **Bonus round (optional).** While listening, they can also type the
   **song title** and/or **artist** into the two bonus fields — no pressure,
   leave them blank to skip. Then hit **Lock it in**.
6. **Reveal.** The song's year, title and artist flip up on every screen. If
   the year landed in the right spot, the card joins that team's timeline
   (kept sorted); wrong year guesses are discarded. Typos and near-misses
   count ("Bohemian Rapsody", missing "The", swapped word order, missing
   accents — all fine) — matching is deliberately forgiving, not exact-text.
   **Name both the title and the artist correctly (with the year also right)
   and the team saves a 🎫 bonus card** — nothing happens to it automatically.
   It sits in the team's inventory (shown as a 🎫 count) until they choose to
   spend it on one of the powers the table has switched on (see below).
7. **Next team — or keep going.** By default one song = one turn, but the table
   can raise "Songs per turn" (see **Game settings** below) so a team keeps
   playing while they're right. **First team to 10 correctly-placed cards wins.**
   At the end, a "🧠 Music Nerd Award" calls out whoever named the most songs.

The year-only mini-cards along each timeline can be **tapped to flip** and see
which song they were, and the strip **scrolls left/right** as timelines grow.

Every player's phone shows an **📋 All timelines** section — scroll down to see
every team's board at once, with the team currently up marked "🎤 up now" and
your own tagged "⭐ you".

### Team management (table lobby)

Below the settings, the table shows a **Teams** console for tidying up how
people have grouped themselves before you start:

- **Reassign a player** — each player has a dropdown; pick another team (or
  **Unassigned**) to move them. Handy when the group wants to even out teams.
- **Remove a team** — the 🗑 button drops a team; any players on it go back to
  the unassigned pool to re-pick. Empty teams are flagged and are never dealt
  into the game anyway, so you can safely clear them out.
- Players who've lost connection show as **offline**, so you can spot a team
  that's effectively empty (everyone left) and remove it.

Switching teams no longer leaves a stray empty team behind — it's cleaned up
automatically.

### Game settings (table lobby, before you start)

- **🎵 Songs per turn** — how many songs in a row a team can keep placing
  before it's the next team's turn: **1** (classic, default), 2, 3, 5, or **∞**
  (keep going until they get one wrong).
- **❌ On a wrong guess** — only matters when songs per turn is above 1:
  **Keep cards** (default — the team keeps whatever they've already earned
  this turn) or **Lose them** (push-your-luck — one miss forfeits every card
  gained since the turn started). The active team sees a ⚠️ warning showing
  exactly how many cards are on the line before they commit to another song.
- **🎤 Title/artist bonus guessing** — turn the guessing bonus round (above)
  on or off. Naming both saves a bonus card; there's nothing to spend it on
  until you enable at least one power below.

When bonus guessing is on, a **🎫 Bonus card powers** checklist appears —
tick any combination on, each with its own cost (and extra settings). None of
these happen automatically — a team always chooses when to cash a card in:

- **🎵 Extra song** — past the per-turn cap, pay to draw one more song for the
  same team anyway. Repeatable as long as they can afford it.
- **🛟 Save your winnings** — about to forfeit this turn's cards (the "Lose
  them" setting above)? Pay to keep them instead. Capped at a set number of
  uses per team per game, so it stays a rare lifeline.
- **📏 Year margin** — missed the timeline slot by a small number of years?
  Pay to count it as correct after all — the card joins the timeline for
  real. Configurable margin (default ±1 year).
- **🎲 Random card** — pay for a guaranteed card, drawn straight onto your
  timeline. No listening, no guessing, no placement risk — this is the
  original "auto bonus card" idea from early testing, now an explicit choice
  instead of something that happened automatically.
- **🕵️ Steal (challenge)** — when the team in the hot seat locks in their
  placement, everyone else gets a brief blind window (the year stays hidden) to
  spend a bonus card and challenge: on your phone you pick where *you* think the
  song fits in **their** timeline. If they were wrong and your spot is right,
  the card — and the point — come to your team instead. Only one challenge per
  song (first to lock in), and the bonus card is spent whether you nail it or
  not. The active team (or the table) taps **Reveal** once challengers have had
  their moment.

Each offer only appears on the table/phone **exactly when it applies** — you
never see a power you can't afford or that wouldn't do anything right now.
Team bonus-card balances show as a 🎫 badge — on the table, on your own
timeline, and during your turn — any time bonus guessing is switched on, even
before any power is. Tap or hover it to see what each enabled power currently
costs, straight from the table's settings, without leaving the game.

All settings are locked in once a game starts — change them from the lobby
between rounds (use **↺ Lobby** on the table if you want to adjust mid-event).

### Table controls (if you get stuck)

A control tray sits at the bottom of the table screen during play, so a game
can never trap you (no more restarting the server):

- **🔀 New song** — ditch the current track and draw a fresh one for the *same*
  team. No score change. Use it when the team is stumped or wasn't ready. The
  active team also has a "No idea? Get a new song" button on their own phone.
- **⏭️ Skip team** — abandon the turn and move to the next team.
- **⏸️ Pause / ▶️ Play** — pause or resume the music. Only in "This machine"
  mode: in DJ mode Spotify owns playback, so the DJ pauses in Spotify itself.
- **↺ Lobby** — send everyone back to the lobby (timelines cleared, teams kept).
- **🏁 End game** — stop now and show the final standings.

---

## 4. Themes

Before starting, the table picks a **theme** — a curated song pool. Tap any
theme chip in the lobby to switch; everyone's phone shows the chosen theme.
Ships with 17, ~3,400 songs total: **🌐 All Songs** (every other theme merged
and de-duplicated — 1,700+ songs on its own), the decades (**60s–2010s**,
~140–370 each), **Sommarplågor** (summer hits), **Svenska hits** (ABBA to
Avicii), **Disco & Funk**, **Rock Classics**, **Party Anthems**,
**Hip-Hop & R&B**, **Jul / Christmas Hits**, **Eurovision Winners**
(every winner 1956–2024, skipping only the four-way tie of 1969 and the
cancelled 2020 contest), **🎹 Max Martin: Billboard Top 100** (100
Billboard hits written or produced by the Swedish songwriter behind Britney,
Katy Perry, Taylor Swift and The Weeknd), and **🎸 Rutger Gunnarsson: Basisten
bakom hits** (40 songs Sweden's most in-demand session bassist played on,
1973–1986 — mostly ABBA, plus Carola, Tomas Ledin, Magnus Uggla and others).

### Adding or editing a theme

Each theme is one file in [`data/themes/`](data/themes/). Drop a new `.json`
file in that folder and it appears automatically after a server restart:

```json
{
  "id": "my-theme",
  "name": "Our Road-Trip Bangers",
  "emoji": "🚗",
  "blurb": "Songs from the summer of 2019",
  "target": 8,
  "songs": [
    { "title": "Song name", "artist": "Artist", "year": 1999 },
    { "title": "Another one", "artist": "Someone Else", "year": 2005 }
  ]
}
```

- Songs need **title / artist / year**. For DJ mode they also need a
  `spotifyId`, which you don't write by hand — run the resolver below and it
  fills them in. "This machine" mode looks tracks up at play time instead, so
  it works without ids.
- The **year is the source of truth** for scoring, so keep it accurate.
- `target` is how many cards win a game (default 10; use 6–8 for smaller pools).
- Aim for ~25+ songs so a game doesn't run out. Restart the server after edits.

#### Baking in the Spotify track ids

DJ mode plays a song by its id, so a song without one **cannot** be played —
those are dropped from the pool rather than dealt as a dead card. The server
prints which themes are fully resolved at startup.

```bash
node scripts/resolve-track-ids.js --only=80s,90s   # one or more themes
node scripts/resolve-track-ids.js                  # everything
node scripts/resolve-track-ids.js --report         # audit, no API calls
```

This is a build step, not part of the running game — it needs
`SPOTIFY_CLIENT_ID` **and** `SPOTIFY_CLIENT_SECRET` in `.env` (dashboard →
your app → Settings → View client secret). It uses the Client Credentials
flow, so it doesn't consume one of the five Development Mode user slots.

Things worth knowing before a long run:

- **The daily quota is roughly 700 calls**, shared across your whole developer
  account. A full pass over ~1,800 songs therefore spans a few days. Progress
  is cached in `data/track-ids.json`, so re-running resumes where it stopped,
  and `--max-calls=N` keeps a run deliberately under the limit.
- Work is **de-duplicated across themes**, so resolving every theme costs far
  less than the sum of their song counts.
- `--report` classifies what it found: songs with no match, and songs where
  the match looks like a **different performance** (a live take, a karaoke
  version, a re-recording). Those match title and artist perfectly and are
  otherwise invisible, so they're worth a glance. Radio and mono edits are
  *not* flagged — those are the single versions people recognise.
- Fix a bad pick by pinning it in
  [`data/track-id-overrides.json`](data/track-id-overrides.json): find the
  right version in Spotify, Share → Copy Song Link, and paste it under
  `"Title|Artist"`. Overrides always win and cost no quota.

**🌐 All Songs** (`data/themes/mixed.json`) is special — it's auto-generated as
the de-duplicated union of every other theme, so it always has the most
variety without hand-curating a separate list. After adding or editing songs
in any theme, regenerate it with:

```bash
node scripts/build-all-songs.js
```

then restart the server. (It's a plain file like any other theme, so nothing
breaks if you skip this — All Songs just won't include your newest additions
until you regenerate it.)

---

## 5. Troubleshooting

### DJ mode

- **No music, and the table says "Nobody is the DJ"** — nobody claimed the
  role. Someone taps **🎧 I'm the DJ** on their phone, or the table taps
  **This device is the DJ**.
- **The link opens Spotify's web player instead of the app** — use the
  **"Switch to browser links"** toggle on the DJ panel to flip between the
  `spotify:` scheme and the `https://` form. The scheme reaches the app
  reliably on iOS; the https link only does so on a phone that has already
  opened Spotify from a link at least once, and otherwise falls back to the
  web player, which can't use the phone's Bluetooth output.
- **"Open in Spotify?" prompt every time** — normal for the `spotify:` scheme,
  and harmless. Accept it; iOS stops asking.
- **Audio comes out of the phone, not the speaker** — that's the phone's own
  output routing, nothing to do with the game. Check the speaker is awake and
  still paired; a sleeping Bluetooth speaker is the usual culprit.
- **A theme has fewer songs than expected** — songs without a baked
  `spotifyId` can't be played in DJ mode, so they're left out of the pool. The
  server prints which themes are fully resolved at startup; run
  `node scripts/resolve-track-ids.js` to fill in more.

### "This machine" mode

- **"Spotify not configured"** — `SPOTIFY_CLIENT_ID` isn't set in `.env`, or
  the server wasn't restarted after editing it.
- **Token exchange fails / "INVALID_CLIENT: Invalid redirect URI"** — the
  redirect URI in your Spotify app settings must be *exactly*
  `http://127.0.0.1:8080/callback`.
- **"This account is not Premium"** — full-song playback needs Premium.
- **Stuck on "Starting player…"** — most common in **Safari**, which only lets
  the player finish starting after you interact with the page: **tap anywhere
  on the table screen once** after connecting. (If it still won't: confirm the
  account is Premium and isn't playing on another device, or use Chrome.)
  There's a **🔎 Spotify player log** under the status line showing exactly
  where startup stopped.
- **The table must run on the same machine as the server** — Spotify only
  allows plain `http` callbacks on loopback, so this mode can't be driven from
  another device over the LAN. DJ mode has no such limit.

### Anything else

- **Phones can't reach the game** — same Wi-Fi, and the firewall must allow
  port 8080. On macOS, allow incoming connections the first time you're asked.
- **Remote players get an unreachable address** — set `PUBLIC_URL` (see
  above); without it the QR encodes a LAN address.
- **Different port?** Set `PORT` in `.env`. If you use "This machine" mode,
  update the redirect URI in both `.env` and the Spotify dashboard to match.

### Songs that won't play

This applies to **"This machine"** mode, where tracks are looked up at play
time. Every so often a song can't be found on Spotify, or Spotify refuses to
play it (regional restriction, catalog gap, etc.). When that happens the table
**automatically records it and skips straight to a new song** for the same
team — you shouldn't need to do anything mid-game.

In DJ mode this mostly can't happen: ids are resolved ahead of time, and a
song without one is left out of the pool before the game starts rather than
failing mid-turn.

Behind the scenes it's logged to [`data/broken-songs.json`](data/broken-songs.json)
(also viewable at `/broken-songs` on the server) with a reason, how many
times it's happened, and when. Every future game **automatically skips**
anything on that list, across all themes. Review it whenever you like —
either delete the bad entry once you've fixed the theme file's title/artist
spelling (a mismatch is the most common cause), or just leave it there to
keep skipping the track for good.

Inspired by the board game Hitster. Built for home use — not affiliated with or
endorsed by Spotify or the makers of Hitster.
