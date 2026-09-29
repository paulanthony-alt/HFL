# 🏈 HFL

The official app of the HFL pickup football league. Works on any phone browser — add it to your home screen and it behaves like a real app.

## What it does

| | |
|---|---|
| **RSVP + auto teams** | Everyone taps in or out. One button splits whoever's in into the fairest possible teams (it checks every possible split and picks one of the most even, so "Reshuffle" gives new-but-still-fair teams). If you have two QBs, they get split up. Tap a player to swap him manually. |
| **Madden-style ratings** | Every player has nine ratings from 20 to 99: Speed, Catching, Route Running, Throw Power, Throw Accuracy, Strength, Man Coverage, Tackling and Stamina. OVR is a position-weighted mix, like Madden (a QB's is mostly throwing, a WR's is catching, routes and speed). Set them in ⚙️ Settings → **Rate players**. After every game they progress: catches build CTH, drops cost it, completions build THA, picks build MCV, sacks build TAK, and beating the odds lifts everyone a little. Gains slow down near 99. Team balancing uses OVR. |
| **Live game tracker** | One guy logs plays on his phone: TD pass, TD run, catch, incompletion, drop, INT, pick six and sack. Every TD is worth 6. Two taps per play (what happened → who). Score updates on everyone's phone instantly. Mistakes can be deleted. |
| **Leaderboards** | MVP race, TDs, QB rating, win-loss record, receiving (including drops 🧈), defense, and ratings. By season or career. |
| **Player cards** | Trading-card profiles with OVR, position, nickname, season stats and badges. Bronze, silver and gold tiers, plus holographic cards for 90+ players. Tap to flip for career stats and rating history. |
| **Playbook** | Draw routes with your finger on a 5v5 field (QB + 4 receivers, no center). Wobbly lines get cleaned up into sharp cuts. Supports pre-snap motion, blocks, preset formations and defenses. Hit ▶ to watch the play run, and share it to the group chat as an image. |
| **Trash-talk wall + MVP vote** | Post smack, react 🔥😂💀🧂🗑️, and use 🎲 Roast to get a burn written from someone's real stats. Everyone who played votes for MVP (no voting for yourself). |
| **Hall of Fame** | Best plays, dumbest moments and worst drops, with photos and upvotes. Tap 🏛️ on any logged play to enshrine it. |

## Putting it online (Firebase)

The HFL runs entirely on Firebase's free plan: Firebase Hosting serves the app, Firestore stores the league, and the crew signs in with one shared password. Always on, nothing to keep running. Once it's set up, every change pushed to GitHub goes live by itself.

**One-time setup (all in the browser):**

1. **Create the project.** [console.firebase.google.com](https://console.firebase.google.com) → *Create a project*.
2. **Turn on the database.** *Build → Firestore Database → Create database* → **Standard edition**, database ID `(default)`, a location near you, **production mode**.
3. **Register the web app.** *Project Overview → + Add app → Web (`</>`)* → nickname `HFL` → tick **Also set up Firebase Hosting** → *Register app*. (No need to copy the config it shows; the app reads it automatically.)
4. **Create the crew login.** *Build → Authentication → Get started → Email/Password → Enable → Save*. Then *Users → Add user*: email **`crew@hfl.app`** (exactly this; the security rules only let this account in) and the crew password (6+ characters, e.g. `hfl6767`).
5. **Get a deploy key.** ⚙️ *Project settings → Service accounts → Generate new private key*. Keep the downloaded file private.
6. **Let the key deploy.** Open [console.cloud.google.com/iam-admin/iam](https://console.cloud.google.com/iam-admin/iam), pick your project, click ✏️ next to the `firebase-adminsdk-…` account → *Add another role* → **Firebase Admin** → *Save*.
7. **Give the key to GitHub.** In this repo on GitHub: *Settings → Secrets and variables → Actions → New repository secret*. Name: `FIREBASE_SERVICE_ACCOUNT`. Value: paste the **entire** key file. Save.
8. **Deploy.** GitHub → *Actions → Deploy to Firebase → Run workflow*. When it's green, the summary shows your link: `https://<project-id>.web.app`.

Open the link, type the crew password, tap **Who are you?**, and send the link to the group chat. On iPhone use Share → **Add to Home Screen**; on Android ⋮ → **Add to Home screen**.

The deploy also installs `firestore.rules`, which blocks everyone except the crew login. Change the crew password any time in ⚙️ Settings; other phones get signed out within the hour.

## Running it on your own computer

For trying things out, or if you'd rather host it yourself. Needs [Node.js](https://nodejs.org) 20+, nothing else to install.

```bash
npm start            # http://localhost:3000
```

Data is saved to `data/db.json` (photos in `data/uploads/`). Set a crew passcode in ⚙️ Settings, or with the `HFL_PASSCODE` environment variable. `PORT` and `HFL_DATA_DIR` change the port and data folder.

**Moving data between the two:** ⚙️ Settings → *Download backup* on one, *Restore* on the other.

## For developers

- `public/engine.js`: all the league math (stats, QB rating, ratings, MVP, team balancing). Pure, shared by everything, unit-tested.
- `public/league.js`: every change the app can make, with validation. The same code runs on the local server and, on Firebase, in the browser.
- `public/backend-firebase.js`: Firebase mode. Live Firestore listeners, and each change runs `league.js` on a draft then writes the changed documents in one transaction, checking each document's revision so simultaneous edits from different phones never overwrite each other.
- `public/app.js`: the app itself (vanilla JS, hash routing, no build step). Picks Firebase when `/__/firebase/init.json` exists (Firebase Hosting), otherwise the local server.
- `public/playbook.js`: field rendering, the touch play editor, animation and PNG export.
- `public/vendor/firebase.js`: the Firebase SDK, bundled from `tools/firebase-entry.js` (rebuild command at the top of the file).
- `server.js` + `storage.js`: the zero-dependency local server (JSON file storage, live updates over Server-Sent Events).
- `firestore.rules`, `firebase.json`, `.github/workflows/deploy-firebase.yml`: Firebase security rules, hosting config and auto-deploy.

```bash
npm test            # engine + league + local server tests (node:test)
npm run dev         # local server, restarts on file changes
npm run emulators   # Firebase Auth + Firestore emulators (needs Java), for testing Firebase mode
```

**QB rating** uses the NFL passer-rating formula without the yardage part (nobody measures yards at the park), scaled so a perfect game is still 158.3.
