# HFL test site

A full copy of the HFL app for trying things out. Change anything in this folder; the real app
(the `public/` folder at the top of the repo) and the real league's data are never touched.

- **Its own data.** On Firebase it uses separate `test_…` collections (test_players, test_games,
  test_meta, …) in the same project, so it starts empty and the real league never sees it. Run
  locally (`npm start` in this folder), it keeps its data in `test-site/data/`.
- **Its own web address.** Pushing changes in this folder deploys it to a Firebase preview
  channel called `test` (see `.github/workflows/deploy-test-site.yml`); the link is in the
  workflow run's summary. It's a different address from the real app, and pushes here never
  redeploy the real app.
- **Same crew password** as the real app.
- A yellow **TEST SITE** badge in the header so nobody mixes them up.

Preview channels expire after 30 days without a deploy; pushing again (or running the workflow)
brings it back. To move something you like into the real app, copy the change into `public/`.

## Trying out: Bowl games and free agency (not in the real app yet)

Rules live in `public/offseason.js`; routes in `public/league.js` (`/api/offseason/...`); screens
at `#/fa` (Free agency) and `#/fa/p/<player>` (a player's free agency page).

- A season is **9 games**. Every 4th game is a Bowl: **Bowl I** (game 4) and **Bowl II** (game 8).
  Game 9 is **the HFL Super Bowl**. The standings show who won each one. Only games made since
  this was added count.
- When the **Super Bowl** ends (not the Bowls), each **coach keeps up to 2 players** (a keeper costs
  his market value + 20%).
- Both coaches lock in (or an admin opens it early) → a **7-day free agency frenzy**. Equal
  **$100M cap** per team, roster max = half the crew. Coaches tap a free agent and offer a
  1-season (9-game) contract ($1M–$40M); players tap **Sign contract** on the offer they want.
- When the week is up (or an admin closes it), the next season starts (`2026` → `2026 S2`) with
  coach + keepers + signings on each team. Unsigned players stay free agents.

To try it here: an admin sets both coaches in Settings, schedules 9 games for today, starts each,
logs a play and blows the final whistle. Games 4 and 8 are the Bowls; the 9th is the Super Bowl,
and the offseason starts when it ends.
