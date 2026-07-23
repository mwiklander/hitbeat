# 🎵 Hitbeat — a LAN music-timeline party game

A phone-friendly, Hitster-style party game for one room. A mystery song plays
from Spotify; the team in the hot seat guesses **where it fits on their
timeline by year**. Guess right, keep the card. First team to **10 cards** wins.

- **The "table"** — the machine running the server. Shows a QR code, plays the
  music out loud, and displays every team's timeline. Gather around it.
- **The players** — everyone else, on their phones. Scan the QR, pick a name +
  emoji, self-assemble into teams, and place cards on your turn.

No accounts, no admin, no physical cards. Just a laptop with speakers and
everyone's phones on the same Wi-Fi.

---

## 1. One-time Spotify setup (~3 minutes)

Playing full songs uses Spotify's Web Playback SDK, so the **table** needs to be
logged into a **Spotify Premium** account, and you need a free "app" registered
with Spotify to get a Client ID.

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. Click **Create app**. Fill in:
   - **App name:** `Hitbeat` (anything)
   - **App description:** `home party game` (anything)
   - **Redirect URI:** `http://127.0.0.1:8080/callback`
     ⚠️ Must be exactly this — use `127.0.0.1`, **not** `localhost`. This is the
     only `http` address Spotify still accepts.
   - **Which API/SDKs are you planning to use?** tick **Web Playback SDK** and
     **Web API**.
3. Save. Open the app → **Settings** → copy the **Client ID**.
4. In this folder, copy `.env.example` to `.env` and paste your Client ID:

   ```bash
   cp .env.example .env
   # then edit .env and set:  SPOTIFY_CLIENT_ID=your_client_id_here
   ```

No client secret is needed — Hitbeat uses the PKCE flow, which is safe to run in
the browser.

---

## 2. Run it

```bash
npm install     # first time only
npm start
```

You'll see:

```
Jukebox / table:  http://127.0.0.1:8080   ← open this on the machine with the speakers
Players join at:  http://192.168.68.120:8080   ← or just scan the QR
```

- On the **table machine**, open **http://127.0.0.1:8080** and click
  **Start the game table**. Click **Connect** next to the Spotify status to log
  in (Premium account). The dot turns green when ready.
- Everyone else **scans the QR** (or opens the LAN URL) on their phone.

Everyone must be on the **same Wi-Fi**.

---

## 3. How to play

1. **Join & team up.** Players scan the QR, pick a name + emoji, then either
   **join a team** or **start a new one**. Teams can be any size, mixed however
   you like. Tap your team's name to rename it.
2. **Start.** When at least one team has a player, the table's **Start game**
   button lights up. Each team is dealt one starting card (a revealed year).
3. **A mystery song plays.** The team whose turn it is listens, then on their
   phones taps a **slot** on their timeline — before, between, or after the
   years they already have.
4. **Bonus round (optional).** While listening, they can also type the
   **song title** and/or **artist** into the two bonus fields — no pressure,
   leave them blank to skip. Then hit **Lock it in**.
5. **Reveal.** The song's year, title and artist flip up on every screen. If
   the year landed in the right spot, the card joins that team's timeline
   (kept sorted); wrong year guesses are discarded. Typos and near-misses
   count ("Bohemian Rapsody", missing "The", swapped word order, missing
   accents — all fine) — matching is deliberately forgiving, not exact-text.
   **Name both the title and the artist correctly (with the year also right)
   and the team saves a 🎫 bonus card** — nothing happens to it automatically.
   It sits in the team's inventory (shown as a 🎫 count) until they choose to
   spend it on one of the powers the table has switched on (see below).
6. **Next team — or keep going.** By default one song = one turn, but the table
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
- **⏸️ Pause / ▶️ Play** — pause or resume the music (shown when Spotify is
  connected) if a track ever hangs.
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

- Songs only need **title / artist / year** — no track links to hunt down.
  Hitbeat looks the track up on Spotify at play time by title + artist,
  preferring the original artist and most popular version.
- The **year is the source of truth** for scoring, so keep it accurate.
- `target` is how many cards win a game (default 10; use 6–8 for smaller pools).
- Aim for ~25+ songs so a game doesn't run out. Restart the server after edits.

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

- **"Spotify not configured"** — you haven't set `SPOTIFY_CLIENT_ID` in `.env`,
  or you didn't restart the server after editing it.
- **Token exchange fails / "INVALID_CLIENT: Invalid redirect URI"** — the
  redirect URI in your Spotify app settings must be *exactly*
  `http://127.0.0.1:8080/callback`.
- **"This account is not Premium"** — full-song playback needs Premium. Log the
  table into a Premium account.
- **Stuck on "Starting player…" / "Spotify connected but the player isn't
  active yet"** — most common in **Safari**, which only lets the player finish
  starting after you interact with the page: **tap anywhere on the table
  screen once** after connecting and it should go green. (If it still won't:
  confirm the account is Premium and isn't playing on another device, or open
  the table in Google Chrome.) There's a **🔎 Spotify player log** under the
  status line that shows exactly where startup stopped if you need to dig in.
- **Song won't play** — make sure the Spotify status dot is green on the table
  before starting, and that no other device is grabbing that Spotify account's
  playback. Use the **🔊 Replay** button to re-trigger.
- **Phones can't reach the game** — confirm they're on the same Wi-Fi and your
  firewall allows connections to port 8080.
- **Different port?** Set `PORT` in `.env` and update the redirect URI (both in
  `.env` and in the Spotify dashboard) to match.

### Songs that won't play

Every so often a song can't be found on Spotify, or Spotify refuses to play
it (regional restriction, catalog gap, etc.). When that happens the table
**automatically records it and skips straight to a new song** for the same
team — you shouldn't need to do anything mid-game.

Behind the scenes it's logged to [`data/broken-songs.json`](data/broken-songs.json)
(also viewable at `/broken-songs` on the server) with a reason, how many
times it's happened, and when. Every future game **automatically skips**
anything on that list, across all themes. Review it whenever you like —
either delete the bad entry once you've fixed the theme file's title/artist
spelling (a mismatch is the most common cause), or just leave it there to
keep skipping the track for good.

Inspired by the board game Hitster. Built for home use — not affiliated with or
endorsed by Spotify or the makers of Hitster.
