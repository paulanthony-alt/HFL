import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHflServer } from '../server.js';

let server, base, dir, PAUL;
const pinHash = (id, pin) => crypto.createHash('sha256').update(`hfl|${id}|${pin}`).digest('hex');
const asPaul = (body = {}) => ({ ...body, _auth: PAUL });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-test-'));
  server = await createHflServer({ dataDir: dir, passcode: '' });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  // The commissioner (a player named Paul) with PIN 6767.
  const paul = (await call('POST', '/api/players', { name: 'Paul' })).result;
  PAUL = { as: paul.id, pinHash: pinHash(paul.id, '6767') };
  await call('POST', `/api/players/${paul.id}/pin`, { pinHash: PAUL.pinHash });
});
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}

test('full game day: players → RSVP → teams → live stats → final → MVP', async () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/players', asPaul({ name: `Player ${i}`, nickname: `P${i}`, position: i < 2 ? 'QB' : 'WR', startOvr: 60 + i * 3 }));
    assert.equal(r.status, 200);
    ids.push(r.result.id);
  }
  const g = (await call('POST', '/api/games', { date: '2099-10-04', time: '18:00', location: 'Park' })).result;
  assert.equal(g.status, 'scheduled');

  for (const id of ids) await call('POST', `/api/games/${g.id}/rsvp`, { playerId: id, status: 'in' });
  const out = await call('POST', `/api/games/${g.id}/rsvp`, { playerId: ids[9], status: 'out' });
  assert.equal(out.result.rsvps[ids[9]], 'out');
  await call('POST', `/api/games/${g.id}/rsvp`, { playerId: ids[9], status: 'in' });

  const teams = (await call('POST', `/api/games/${g.id}/auto-teams`)).result.teams;
  assert.equal(teams.A.length, 5);
  assert.equal(teams.B.length, 5);

  assert.equal((await call('POST', `/api/games/${g.id}/events`, { type: 'catch', p1: teams.A[0], p2: teams.A[1] })).status, 400, 'cannot log before kickoff');
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  await call('PATCH', `/api/games/${g.id}`, { date: today }); // it's game day
  assert.equal((await call('POST', `/api/games/${g.id}/start`, {})).status, 200);

  const td = await call('POST', `/api/games/${g.id}/events`, { type: 'pass_td', p1: teams.A[0], p2: teams.A[1] });
  assert.equal(td.status, 200);
  assert.equal(td.result.team, 'A');
  const wrongSide = await call('POST', `/api/games/${g.id}/events`, { type: 'pass_td', p1: teams.A[0], p2: teams.B[1] });
  assert.equal(wrongSide.status, 400);
  const sack = await call('POST', `/api/games/${g.id}/events`, { type: 'sack', p1: teams.B[0], p2: teams.A[0] });
  assert.equal(sack.result.team, 'B');
  const oops = await call('POST', `/api/games/${g.id}/events`, { type: 'rush_td', p1: teams.B[2] });
  const undone = await call('DELETE', `/api/games/${g.id}/events/${oops.result.id}`);
  assert.equal(undone.db.games[0].events.length, 2);

  assert.equal((await call('POST', `/api/games/${g.id}/mvp`, { voterId: teams.A[2], playerId: teams.A[1] })).status, 400, 'no voting before final');
  const fin = await call('POST', `/api/games/${g.id}/final`);
  assert.equal(fin.result.status, 'final');

  assert.equal((await call('POST', `/api/games/${g.id}/mvp`, { voterId: teams.A[1], playerId: teams.A[1] })).status, 400, 'no self votes');
  const vote = await call('POST', `/api/games/${g.id}/mvp`, { voterId: teams.B[3], playerId: teams.A[1] });
  assert.equal(vote.status, 200);

  const state = await call('GET', '/api/state');
  assert.equal(state.db.games[0].mvpVotes[teams.B[3]], teams.A[1]);
  assert.ok(state.db.version > 10);
});

test('validation errors do not leave partial writes', async () => {
  const before = (await call('GET', '/api/state')).db;
  const r = await call('POST', '/api/plays', { name: 'Bad', players: [{ id: 'o1', label: 'QB', side: 'O', x: 50, y: 90 }], routes: [{ pid: 'nobody', style: 'route', points: [[1, 1], [2, 2]] }] });
  assert.equal(r.status, 400);
  const after = (await call('GET', '/api/state')).db;
  assert.equal(after.version, before.version);
  assert.equal(after.plays.length, before.plays.length);
});

test('playbook, wall and hall of fame round-trip', async () => {
  const { db } = await call('GET', '/api/state');
  const [a, b] = db.players;
  const play = await call('POST', '/api/plays', {
    name: 'Mesh', notes: 'cross at 5', formation: 'spread', authorId: a.id,
    players: [{ id: 'o1', label: 'QB', side: 'O', x: 50, y: 92, color: '#ffffff' }, { id: 'o2', label: 'X', side: 'O', x: 10, y: 80, color: '#ff6b1a' }],
    routes: [{ id: 'r1', pid: 'o2', style: 'route', points: [[10, 80], [10, 60], [30, 50]] }],
  });
  assert.equal(play.status, 200);
  const upd = await call('PUT', `/api/plays/${play.result.id}`, { ...play.result, name: 'Mesh 2' });
  assert.equal(upd.result.name, 'Mesh 2');

  const post = await call('POST', '/api/posts', { authorId: a.id, text: '<script>alert(1)</script> you can\'t guard me' });
  assert.equal(post.status, 200);
  const react = await call('POST', `/api/posts/${post.result.id}/react`, { emoji: '🔥', playerId: b.id });
  assert.deepEqual(react.result.reactions['🔥'], [b.id]);
  const unreact = await call('POST', `/api/posts/${post.result.id}/react`, { emoji: '🔥', playerId: b.id });
  assert.deepEqual(unreact.result.reactions['🔥'], []);
  assert.equal((await call('POST', '/api/posts', { authorId: a.id, text: '   ' })).status, 400);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const fame = await call('POST', '/api/fame', { category: 'drop', title: 'Wide open', playerIds: [b.id], image: png, authorId: a.id });
  assert.equal(fame.status, 200);
  const img = await fetch(base + fame.result.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const vote = await call('POST', `/api/fame/${fame.result.id}/vote`, { playerId: a.id });
  assert.deepEqual(vote.result.votes, [a.id]);
  await call('DELETE', `/api/fame/${fame.result.id}`);
  assert.equal((await fetch(base + fame.result.image)).status, 404);
});

test('state persists to disk', async () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  const live = (await call('GET', '/api/state')).db;
  assert.equal(onDisk.version, live.version);
});

test('static files are served and path traversal is blocked', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /HFL/);
  const js = await fetch(base + '/engine.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  const evil = await fetch(base + '/..%2fserver.js');
  assert.notEqual(await evil.text().then((t) => t.includes('createHflServer')), true);
});

test('passcode locks the API', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-pass-'));
  const s2 = await createHflServer({ dataDir: d2, passcode: 'blitz' });
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://localhost:${s2.address().port}`;
  try {
    assert.equal((await fetch(b2 + '/api/state')).status, 401);
    assert.equal((await fetch(b2 + '/api/state', { headers: { 'x-hfl-pass': 'nope' } })).status, 401);
    assert.equal((await fetch(b2 + '/api/state', { headers: { 'x-hfl-pass': 'blitz' } })).status, 200);
    assert.deepEqual(await (await fetch(b2 + '/api/auth')).json(), { required: true, ok: false, managedBy: 'server' });
  } finally {
    s2.closeAllConnections();
    s2.close();
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test('demo seed loads only into an empty league', async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-demo-'));
  const s3 = await createHflServer({ dataDir: d3 });
  await new Promise((r) => s3.listen(0, r));
  const b3 = `http://localhost:${s3.address().port}`;
  try {
    const r = await (await fetch(b3 + '/api/seed-demo', { method: 'POST' })).json();
    assert.equal(r.db.players.length, 12);
    assert.equal(r.db.games.filter((g) => g.status === 'final').length, 3);
    assert.equal((await fetch(b3 + '/api/seed-demo', { method: 'POST' })).status, 400);
  } finally {
    s3.closeAllConnections();
    s3.close();
    fs.rmSync(d3, { recursive: true, force: true });
  }
});

test('rate players endpoint stores dated edits and moves the rating', async () => {
  const { db } = await call('GET', '/api/state');
  const p = db.players[0];
  assert.equal((await call('POST', '/api/ratings', { ratings: { [p.id]: 93 } })).status, 403, 'nobody but the commissioner');
  const r = await call('POST', '/api/ratings', asPaul({ ratings: { [p.id]: 93 } }));
  assert.equal(r.status, 200);
  assert.equal(r.db.players[0].ratingEdits.at(-1).ovr, 93);
  assert.equal((await call('POST', '/api/ratings', asPaul({ ratings: { [p.id]: 150 } }))).status, 400);

  // Madden-style: individual ratings + position
  const m = await call('POST', '/api/ratings', asPaul({ ratings: { [p.id]: { attrs: { spd: 95, cth: 91 }, position: 'WR' } } }));
  assert.equal(m.status, 200);
  const edited = m.db.players.find((x) => x.id === p.id);
  assert.deepEqual(edited.ratingEdits.at(-1).attrs, { spd: 95, cth: 91 });
  assert.equal(edited.position, 'WR');
  assert.equal((await call('POST', '/api/ratings', asPaul({ ratings: { [p.id]: { attrs: { swag: 99 } } } }))).status, 400, 'unknown rating');
  assert.equal((await call('POST', '/api/ratings', asPaul({ ratings: { [p.id]: { attrs: { spd: 5 } } } }))).status, 400, 'below 20');
});

test('passcode set in the app locks everything, survives restart, and can be removed', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-apppass-'));
  const start = async () => { const s = await createHflServer({ dataDir: d, passcode: "" }); await new Promise((r) => s.listen(0, r)); return s; };
  // Restarting can hand out a port an earlier test used; wait for a full shutdown and
  // retry once if a stale pooled connection gets dropped, so CI deploys never flake.
  const stop = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });
  const fetch = async (...args) => {
    try { return await globalThis.fetch(...args); } catch { return globalThis.fetch(...args); }
  };
  let s = await start();
  let b = `http://localhost:${s.address().port}`;
  const post = (url, body, pass = '') => fetch(b + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hfl-pass': pass }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(b + '/api/state')).status, 200);
    assert.equal((await post('/api/passcode', { passcode: '12' })).status, 400, 'too short');
    assert.equal((await post('/api/passcode', { passcode: '6767' })).status, 200);
    assert.equal((await fetch(b + '/api/state')).status, 401);
    assert.equal((await fetch(b + '/api/state', { headers: { 'x-hfl-pass': '6767' } })).status, 200);
    assert.ok(!fs.readFileSync(path.join(d, 'auth.json'), 'utf8').includes('6767'), 'only a hash is stored');

    await stop(s); s = await start(); b = `http://localhost:${s.address().port}`;
    assert.equal((await fetch(b + '/api/state')).status, 401, 'still locked after restart');
    assert.equal((await post('/api/passcode', { passcode: '' }, 'wrong')).status, 401, 'need the code to change it');
    assert.equal((await post('/api/passcode', { passcode: '' }, '6767')).status, 200);
    assert.equal((await fetch(b + '/api/state')).status, 200, 'unlocked again');
  } finally {
    await stop(s);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('roster setup: keeps the crew, clears everyone else, runs only once', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-roster-'));
  const s = await createHflServer({ dataDir: d, passcode: '' });
  await new Promise((r) => s.listen(0, r));
  const b = `http://localhost:${s.address().port}`;
  const post = async (url, body) => (await fetch(b + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  try {
    await post('/api/seed-demo');
    const paul = await post('/api/players', { name: 'paul', nickname: 'Big P' }); // already here, odd casing
    const first = await post('/api/setup-roster');
    assert.equal(first.result.changed, true);
    const { db } = first;
    assert.deepEqual(db.players.map((p) => p.name), ['Kellen', 'Max', 'Boden', 'Liam', 'Evan', 'Henry', 'Matteo', 'Ben', 'Lucas', 'Paul', 'Dane', 'Teddy', 'Bobby', 'Noah'], 'names tidied to the roster spelling');
    assert.equal(db.players.find((p) => p.name === 'Paul').id, paul.result.id, 'existing player kept with his stats and nickname');
    assert.equal(db.players.find((p) => p.name === 'Paul').nickname, 'Big P');
    assert.equal(db.games.length, 0, 'demo games gone');
    assert.equal(db.posts.length, 0, 'demo posts gone');
    assert.equal(db.plays.length, 0, 'demo plays gone');
    assert.equal(db.fame.length, 0, 'demo hall of fame gone');
    assert.equal(new Set(db.players.map((p) => p.color)).size, 14, 'everyone gets their own card color');

    const newbie = await post('/api/players', { name: 'Cousin Joey' });
    const again = await post('/api/setup-roster');
    assert.equal(again.result.changed, false);
    assert.ok(again.db.players.some((p) => p.id === newbie.result.id), 'players added later are never removed');
    assert.equal(again.db.players.length, 15);
  } finally {
    s.closeAllConnections();
    s.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('player card photos: set, replace, remove', async () => {
  const { db } = await call('GET', '/api/state');
  const p = db.players[0];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const first = await call('POST', `/api/players/${p.id}/photo`, asPaul({ image: png }));
  assert.equal(first.status, 200);
  assert.match(first.result.photo, /^\/uploads\/player-/);
  assert.equal((await fetch(base + first.result.photo)).status, 200);
  const second = await call('POST', `/api/players/${p.id}/photo`, asPaul({ image: png }));
  assert.notEqual(second.result.photo, first.result.photo);
  assert.equal((await fetch(base + first.result.photo)).status, 404, 'old photo cleaned up');
  const gone = await call('POST', `/api/players/${p.id}/photo`, asPaul({ image: null }));
  assert.equal(gone.result.photo, null);
  assert.equal((await fetch(base + second.result.photo)).status, 404);
  assert.equal((await call('POST', `/api/players/${p.id}/photo`, asPaul({ image: 'data:text/html;base64,PHNjcmlwdD4=' }))).status, 400);
});

test('RSVPs close when game day starts, but walk-ons can still join a team', async () => {
  const { db } = await call('GET', '/api/state');
  const [a, b, c] = db.players;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const g = (await call('POST', '/api/games', { date: today })).result;
  const r = await call('POST', `/api/games/${g.id}/rsvp`, { playerId: a.id, status: 'in' });
  assert.equal(r.status, 400);
  assert.match(r.error, /game day/);
  const t = await call('PUT', `/api/games/${g.id}/teams`, { teams: { A: [a.id], B: [b.id, c.id] } });
  assert.equal(t.status, 200, 'teams (including walk-ons) can still be set on game day');
  const shuffled = await call('POST', `/api/games/${g.id}/auto-teams`);
  assert.equal(shuffled.status, 200);
  assert.deepEqual([...shuffled.result.teams.A, ...shuffled.result.teams.B].sort(), [a.id, b.id, c.id].sort(), 'reshuffle keeps walk-ons');
  const tomorrow = new Date(Date.now() + 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const g2 = (await call('POST', '/api/games', { date: tomorrow })).result;
  assert.equal((await call('POST', `/api/games/${g2.id}/rsvp`, { playerId: a.id, status: 'in' })).status, 200, 'open the day before');
  await call('DELETE', `/api/games/${g.id}`);
  await call('DELETE', `/api/games/${g2.id}`);
});

test('anyone can log plays, including after the final whistle', async () => {
  const { db } = await call('GET', '/api/state');
  const g = db.games.find((x) => x.status === 'final');
  const [qa, wa] = g.teams.A;
  const r = await call('POST', `/api/games/${g.id}/events`, { type: 'catch', p1: qa, p2: wa, by: g.teams.B[0] });
  assert.equal(r.status, 200);
  assert.equal(r.result.by, g.teams.B[0]);
});

test('PIN lock: players edit only their own profile; ratings and positions are commissioner-only', async () => {
  const kellen = (await call('POST', '/api/players', { name: 'Kellen', startOvr: 99, position: 'QB' })).result;
  assert.equal(kellen.startOvr, 70, 'only the commissioner sets starting ratings');
  assert.equal(kellen.position, 'ATH');
  const max = (await call('POST', '/api/players', { name: 'Max' })).result;
  const K = { as: kellen.id, pinHash: pinHash(kellen.id, '1111') };
  const M = { as: max.id, pinHash: pinHash(max.id, '2222') };

  assert.equal((await call('PATCH', `/api/players/${kellen.id}`, { nickname: 'K' })).status, 403, 'no PIN, no edits');
  assert.equal((await call('POST', `/api/players/${kellen.id}/pin`, { pinHash: K.pinHash })).status, 200, 'claiming your name');
  await call('POST', `/api/players/${max.id}/pin`, { pinHash: M.pinHash });
  assert.equal((await call('POST', `/api/players/${kellen.id}/pin`, { pinHash: M.pinHash, _auth: M })).status, 403, "can't steal a claimed name");

  const own = await call('PATCH', `/api/players/${kellen.id}`, { nickname: 'K-Train', number: 23, _auth: K });
  assert.equal(own.status, 200);
  assert.equal(own.result.nickname, 'K-Train');
  assert.equal((await call('PATCH', `/api/players/${kellen.id}`, { nickname: 'Loser', _auth: M })).status, 403, "Max can't rename Kellen");
  assert.equal((await call('PATCH', `/api/players/${kellen.id}`, { nickname: 'x', _auth: { as: kellen.id, pinHash: pinHash(kellen.id, '9999') } })).status, 403, 'wrong PIN');
  assert.equal((await call('PATCH', `/api/players/${kellen.id}`, { position: 'QB', _auth: K })).status, 403, 'position is a ratings thing');
  assert.equal((await call('POST', '/api/ratings', { ratings: { [kellen.id]: 99 }, _auth: K })).status, 403, "can't rate yourself");
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', `/api/players/${kellen.id}/photo`, { image: png, _auth: M })).status, 403);
  assert.equal((await call('POST', `/api/players/${kellen.id}/photo`, { image: png, _auth: K })).status, 200);

  // commissioner can do all of it, and reset a forgotten PIN
  assert.equal((await call('PATCH', `/api/players/${kellen.id}`, asPaul({ position: 'QB', nickname: 'Slinger' }))).status, 200);
  assert.equal((await call('POST', `/api/players/${kellen.id}/pin`, asPaul({ pinHash: null }))).status, 200);
  const after = (await call('GET', '/api/state')).db.players.find((p) => p.id === kellen.id);
  assert.equal(after.pinHash, null, 'PIN reset, Kellen can claim again');
  assert.equal((await call('POST', '/api/import', { db: { players: [], games: [], posts: [], plays: [], fame: [] } })).status, 403, 'restoring a backup is commissioner-only');
});

test("games can't start before game day, and an early start can be undone", async () => {
  const { db } = await call('GET', '/api/state');
  const [a, b] = db.players;
  const g = (await call('POST', '/api/games', { date: '2099-01-01' })).result;
  await call('PUT', `/api/games/${g.id}/teams`, { teams: { A: [a.id], B: [b.id] } });
  const r = await call('POST', `/api/games/${g.id}/start`, {});
  assert.equal(r.status, 400);
  assert.match(r.error, /not game day/);
  // a game started on game day whose date then moved out (like one started early before this rule)
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  await call('PATCH', `/api/games/${g.id}`, { date: today });
  assert.equal((await call('POST', `/api/games/${g.id}/start`, {})).status, 200);
  await call('PATCH', `/api/games/${g.id}`, { date: '2099-01-01' });
  const u = await call('POST', `/api/games/${g.id}/unstart`);
  assert.equal(u.result.changed, true);
  assert.equal(u.db.games.find((x) => x.id === g.id).status, 'scheduled', 'back to scheduled, RSVPs open');
  await call('DELETE', `/api/games/${g.id}`);
});

test('roster update: an already set-up league just gains Teddy, Bobby and Noah', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-roster2-'));
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({
    version: 5, settings: { crewName: 'HFL', season: '2026', rosterVersion: 1 },
    players: ['Kellen', 'Max', 'Paul', 'Cousin Joey', 'noah'].map((name, i) => ({ id: `p${i}`, name, active: true })),
    games: [{ id: 'g1', date: '2099-01-01', status: 'scheduled', rsvps: { p0: 'in' }, teams: { A: [], B: [] }, events: [], mvpVotes: {} }], posts: [], plays: [], fame: [],
  }));
  const s = await createHflServer({ dataDir: d, passcode: '' });
  await new Promise((r) => s.listen(0, r));
  try {
    const res = await (await fetch(`http://localhost:${s.address().port}/api/setup-roster`, { method: 'POST' })).json();
    assert.deepEqual(res.result.names, ['Teddy', 'Bobby']);
    const names = res.db.players.map((p) => p.name);
    assert.deepEqual(names, ['Kellen', 'Max', 'Paul', 'Cousin Joey', 'noah', 'Teddy', 'Bobby'], 'nobody removed, Noah not duplicated');
    assert.equal(res.db.games[0].rsvps.p0, 'in', 'games and RSVPs untouched');
    const again = await (await fetch(`http://localhost:${s.address().port}/api/setup-roster`, { method: 'POST' })).json();
    assert.equal(again.result.changed, false);
  } finally {
    s.closeAllConnections(); s.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('undo shuffle brings back the previous teams (and tapping again redoes)', async () => {
  const { db } = await call('GET', '/api/state');
  const ids = db.players.slice(0, 6).map((p) => p.id);
  const g = (await call('POST', '/api/games', { date: '2099-02-02' })).result;
  for (const id of ids) await call('POST', `/api/games/${g.id}/rsvp`, { playerId: id, status: 'in' });
  assert.equal((await call('POST', `/api/games/${g.id}/undo-teams`)).status, 400, 'nothing to undo yet');
  const first = (await call('POST', `/api/games/${g.id}/auto-teams`)).result.teams;
  let second;
  for (let i = 0; i < 20; i++) { second = (await call('POST', `/api/games/${g.id}/auto-teams`)).result.teams; if (JSON.stringify(second) !== JSON.stringify(first)) break; }
  const undone = (await call('POST', `/api/games/${g.id}/undo-teams`)).result.teams;
  assert.deepEqual(undone, first, 'back to the teams before the last shuffle');
  const redone = (await call('POST', `/api/games/${g.id}/undo-teams`)).result.teams;
  assert.deepEqual(redone, second);
  await call('DELETE', `/api/games/${g.id}`);
});
