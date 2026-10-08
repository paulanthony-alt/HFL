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
