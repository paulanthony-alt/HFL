# 🏈 HFL

The official app of the HFL pickup football league. Works on any phone browser — add it to your home screen and it behaves like a real app.

## What it does

| | |
|---|---|
| **RSVP + auto teams** | Everyone taps in or out. One button splits whoever's in into the fairest possible teams (it checks every possible split and picks one of the most even, so "Reshuffle" gives new-but-still-fair teams). If you have two QBs, they get split up. Tap a player to swap him manually. |
| **Madden-style ratings** | Every player has seventeen ratings from 20 to 99: Speed, Acceleration, Catching, Route Running, Release, Throw Power, Throw Accuracy, Strength, Man Coverage, Tackling, Stamina, Ball Carrier Vision, Break Tackle, Change of Direction, Juke Move, Carrying and Run After Catch. Height and weight go on the card and player page too (set by league admins in Rate players or the player's edit screen). OVR is a position-weighted mix, like Madden (a QB's is mostly throwing, a WR's is catching, routes and speed). Set them in ⚙️ Settings → **Rate players**. After every game they progress: catches build CTH, drops cost it, completions build THA, picks build MCV, sacks build TAK, touchdowns with the ball in your hands build BCV, BTK, COD and JKM, and beating the odds lifts everyone a little. Gains slow down near 99. Team balancing uses OVR. |
| **Awards & progression** | Player of the Week (best stat impact each week), season awards (MVP, Most Improved, Butterfingers: "leader so far" during the season, locked in when it ends), and career milestones like the first TD, 25th catch or **100th TD**, stamped with the game they happened in. Awards and milestones add card badges and unlock card designs (Heat Check, Crowned, Glow Up, Butter, Milestone Foil, Century Club) you can wear from your player page. The player page also shows your progression this season. |
| **HFL Center recaps** | The moment a game goes final, a SportsCenter-style recap appears on the game and at the top of the Wall: headline, score, goat of the day, top plays, worst drop, milestones and a roast. **Share recap** turns it into an image for the group chat. |
| **Personal PINs** | The first time someone picks their name under "Who are you?", they create a 4-digit PIN. Only that player can change their own nickname, photo, jersey number, emoji, card color and card design. Ratings, positions, names, retiring players and restoring backups are locked to the league admins (the players named Paul, Max and Henry, plus anyone in `settings.commissionerIds`); the app still moves ratings after every game. Admins can edit anyone and reset forgotten PINs in ⚙️ Settings, and none of this is labeled in the app. (PINs stop anyone from editing through the app; they're not bank-grade security.) |
| **Win probability & momentum** | Every game gets an ESPN-style win-probability chart that updates as plays are logged, and calls out the play with the **biggest momentum swing** (also in the recap). With no game clock, "how late is it" is plays logged vs. a typical HFL game. |
| **Scouting report** | Under the win odds (before the game) and the win probability chart (during and after), each team gets 2–3 strengths and weaknesses from its players' ratings, like "Speed to burn", "Gunslinger at QB", "Leaky secondary" or "Fade late". Each team is graded against the league, the team across the field and its own profile. |
| **Clutch** | Plays made in a one-score game (7 or less) late in the game count as clutch: TDs, picks and sacks add points, throwing a pick or dropping one takes them away. Stats → 🧊 Clutch has the leaderboard; the season leader gets a 🧊 Clutch badge and 15+ career clutch points makes you 🧊 Mr. Clutch. |
| **Hot & cold** | Score or throw a TD in 3 straight games and your card catches fire 🔥. Two or more straight games with a drop or a pick and no TDs and it frosts over ❄️. It lasts until the streak ends. |
| **Live game tracker** | One guy logs plays on his phone: TD pass, TD run, catch, incompletion, drop, INT, pick six and sack. Every TD is worth 6. Two taps per play (what happened → who). Score updates on everyone's phone instantly. Mistakes can be deleted. |
| **Voice logging** | Tap **🎤 Log by voice** once and just talk: "Kellen to Max, touchdown", "Lucas touchdown run", "Boden picks off Kellen", "Ben sacks Kellen", "Dane dropped it". Each play is logged the moment it's heard (the phone buzzes), with an Undo button for the last one. It keeps listening until you tap Stop or leave the game. Works in Chrome and Safari; the rest of the logger still works without it. |
| **AR Scoreboard (Cast / Film)** | A second phone on a tripod films the game with a TV-style scoreboard drawn on the picture: team names, colors and score bottom-left, quarter and game clock top-right, a last-play ticker ("TD · Don → Robert") and a big banner for 2 seconds on every touchdown. Tap REC and the scoreboard is baked into the video (with sound), then Save / Share it or download it. Videos stay on the phone and are never uploaded. The camera phone only watches the live game; it never logs plays. The optional **game clock** (⏱ on the logger: start, pause, next quarter) shows on every phone at the same time. |
| **HFL Wrapped** | A Spotify-Wrapped-style story for every player's season: record and ride-or-die teammate, your biggest numbers and where they rank, favorite target (or QB), your nemesis, your best play (the one that swung the win probability most), best game, clutch and heaters, ratings glow-up, hardware, and a roast. Ends on a summary card you can share as a story-sized image. It's under Stats → 🎁 Wrapped anytime ("so far"), on every player page, and a banner announces it when a season ends. |
| **Leaderboards** | MVP race, TDs, QB rating, win-loss record, receiving (including drops 🧈), defense, and ratings. By season or career. |
| **Player cards** | Trading-card profiles with OVR, position, nickname, season stats and badges. Bronze, silver and gold tiers, plus holographic cards for 90+ players. Uploaded photos are cropped to the card automatically, centered on the face (using the phone's face detection when it has it), with a preview before saving. Tap to flip for the six ratings that matter most at his position, season stats and accolades (all sixteen ratings are on his player page). |
| **Playbook** | Draw routes with your finger on a 5v5 field (QB + 4 receivers, no center). Wobbly lines get cleaned up into sharp cuts. Supports pre-snap motion, blocks, preset formations and defenses. Hit ▶ to watch the play run, and share it to the group chat as an image. |
| **Trash-talk wall + MVP vote** | Post smack, react 🔥😂💀🧂🗑️, and use 🎲 Roast to get a burn written from someone's real stats. Everyone who played votes for MVP (no voting for yourself). |
| **Rules** | The Rules tab holds the league's rules, numbered in order. League admins add, edit, reorder and delete them; everyone else can read them. |
| **Hall of Fame** | Best plays, dumbest moments and worst drops, with photos and upvotes. Tap 🏛️ on any logged play to enshrine it. |

### How to use the AR Scoreboard

1. **Logger phone:** open the live game and log plays like always. Tap **⏱ Start game clock** if you want a clock (⋯ has Next quarter, Reset and Turn clock off).
2. **Tripod phone:** open the same live game and tap **📹 Cast / Film** (or go to `#/cast`). Allow the camera, turn the phone sideways, and frame the field. The score, clock and plays update by themselves.
3. Tap the red **REC** button to record and tap it again to stop. Then tap **Save / Share** (on iPhone, pick **Save Video** to put it in Photos) or **Download**. Save before closing: the video only lives on that phone.
4. Plug the tripod phone in for long games. Recordings stop at 10 minutes so the phone doesn't run out of memory (tap REC again to keep going). If the screen might lock, turn off Auto-Lock.

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
- `public/crop.js`: works out the card-shaped crop for an uploaded photo.
- `public/cast.js`: the AR Scoreboard camera screen (camera → canvas + scoreboard → MediaRecorder, wake lock). `public/clock.js`: the optional game clock (`game.clock = { startedAt, pausedAt, quarter }`).
- `public/voice.js`: turns a spoken sentence into a play (names, play words, who did what).
- `public/wrapped.js`: builds each player's season Wrapped and its share image.
- `public/insights.js`: win probability, momentum swings, clutch scoring and hot/cold form.
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
