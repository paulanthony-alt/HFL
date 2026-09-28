# 🏈 HFL

The official app of the HFL pickup football league. Works on any phone browser — add it to your home screen and it behaves like a real app.

## What it does

| | |
|---|---|
| **RSVP + auto teams** | Everyone taps in or out. One button splits whoever's in into the fairest possible teams (it checks every possible split and picks one of the most even, so "Reshuffle" gives new-but-still-fair teams). If you have two QBs, they get split up. Tap a player to swap him manually. |
| **Rate players** | ⚙️ Settings → **Rate players**: drag a slider to set anyone's rating, or tap **📊 Stats say** to use the rating the app works out from logged games (production per game vs. the crew, win %, MVPs). From then on, the rating keeps moving with every game. |
| **Ratings that learn** | Every player has an OVR (40–99). After each game, ratings move Elo-style: beat the odds and you go up, get upset and you go down, blowouts count more, and guys who ball out get a bonus. Ratings are recalculated from every game ever played, so fixing a stat later keeps everything consistent. |
| **Live game tracker** | One guy logs plays on his phone: TD pass, TD run, catch, incompletion, drop, INT, pick six, sack, safety, PAT. Two taps per play (what happened → who). Score updates on everyone's phone instantly. Mistakes can be deleted. |
| **Leaderboards** | MVP race, TDs, QB rating, win-loss record, receiving (including drops 🧈), defense, and ratings. By season or career. |
| **Player cards** | Trading-card profiles with OVR, position, nickname, season stats and badges. Bronze, silver and gold tiers, plus holographic cards for 90+ players. Tap to flip for career stats and rating history. |
| **Playbook** | Draw routes with your finger on a 5v5 field (QB + 4 receivers, no center). Wobbly lines get cleaned up into sharp cuts. Supports pre-snap motion, blocks, preset formations and defenses. Hit ▶ to watch the play run, and share it to the group chat as an image. |
| **Trash-talk wall + MVP vote** | Post smack, react 🔥😂💀🧂🗑️, and use 🎲 Roast to get a burn written from someone's real stats. Everyone who played votes for MVP (no voting for yourself). |
| **Hall of Fame** | Best plays, dumbest moments and worst drops, with photos and upvotes. Tap 🏛️ on any logged play to enshrine it. |

## Running it

You need [Node.js](https://nodejs.org) 20 or newer. There's nothing to install.

```bash
npm start            # http://localhost:3000
```

Open it, tap **Load a demo crew** to look around, or add your real crew. Each person taps **Who are you?** once on their phone so their RSVPs, votes and posts are theirs.

Settings you can pass as environment variables:

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on (default `3000`) |
| `HFL_PASSCODE` | Optional. Locks the passcode from the server side (overrides the one set in the app). |
| `HFL_DATA_DIR` | Where data is stored (default `./data`) |

### Crew passcode

Open ⚙️ Settings → **Crew passcode**, type a code, and tap **Set passcode**. From then on every phone has to type it once (it's remembered after that), and anyone who's already in gets asked for it right away. You can change or remove it from the same place. The server only stores a scrambled (hashed) copy, never the code itself, and it isn't included in backups.

Everything is saved to `data/db.json` (photos go in `data/uploads/`). You can also download and restore a backup from ⚙️ Settings.

## Putting it online for the crew

Any host that runs Node and gives you a **persistent disk** works (Render, Railway, Fly.io, a Raspberry Pi, an old laptop). Set the start command to `npm start`, point `HFL_DATA_DIR` at the persistent disk, and set the crew passcode in the app right away. Then send the link to the group chat. On iPhone use Share → **Add to Home Screen**, on Android use ⋮ → **Add to Home screen**.

> Hosts without a persistent disk wipe your data every time they restart. Use the backup button if you're not sure.

## For developers

- `server.js`: zero-dependency HTTP server and JSON API. Every change is validated on a copy of the data and only saved if it succeeds, then pushed to every open phone over Server-Sent Events.
- `public/engine.js`: all the league logic (stats, QB rating, ratings, MVP, team balancing). It's pure and shared by the server, the browser and the tests.
- `public/app.js`: the app itself (vanilla JS, hash routing, no build step).
- `public/playbook.js`: field rendering, the touch play editor, animation and PNG export.
- `demo.js`: the demo league.

```bash
npm test       # engine + API tests (node:test)
npm run dev    # restarts on file changes
```

**QB rating** uses the NFL passer-rating formula without the yardage part (nobody measures yards at the park), scaled so a perfect game is still 158.3.
