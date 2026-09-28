import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHflServer } from '../server.js';

let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-test-'));
  server = await createHflServer({ dataDir: dir, passcode: '' });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
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
    const r = await call('POST', '/api/players', { name: `Player ${i}`, nickname: `P${i}`, position: i < 2 ? 'QB' : 'WR', startOvr: 60 + i * 3 });
    assert.equal(r.status, 200);
    ids.push(r.result.id);
  }
  const g = (await call('POST', '/api/games', { date: '2026-10-04', time: '18:00', location: 'Park' })).result;
  assert.equal(g.status, 'scheduled');

  for (const id of ids) await call('POST', `/api/games/${g.id}/rsvp`, { playerId: id, status: 'in' });
  const out = await call('POST', `/api/games/${g.id}/rsvp`, { playerId: ids[9], status: 'out' });
  assert.equal(out.result.rsvps[ids[9]], 'out');
  await call('POST', `/api/games/${g.id}/rsvp`, { playerId: ids[9], status: 'in' });

  const teams = (await call('POST', `/api/games/${g.id}/auto-teams`)).result.teams;
  assert.equal(teams.A.length, 5);
  assert.equal(teams.B.length, 5);

  assert.equal((await call('POST', `/api/games/${g.id}/events`, { type: 'catch', p1: teams.A[0], p2: teams.A[1] })).status, 400, 'cannot log before kickoff');
  await call('POST', `/api/games/${g.id}/start`, { scorekeeperId: ids[0] });

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
  const r = await call('POST', '/api/ratings', { ratings: { [p.id]: 93 } });
  assert.equal(r.status, 200);
  assert.equal(r.db.players[0].ratingEdits.at(-1).ovr, 93);
  assert.equal((await call('POST', '/api/ratings', { ratings: { [p.id]: 150 } })).status, 400);
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
    assert.deepEqual(db.players.map((p) => p.name), ['Kellen', 'Max', 'Boden', 'Liam', 'Evan', 'Henry', 'Matteo', 'Ben', 'Lucas', 'Paul', 'Dane'], 'names tidied to the roster spelling');
    assert.equal(db.players.find((p) => p.name === 'Paul').id, paul.result.id, 'existing player kept with his stats and nickname');
    assert.equal(db.players.find((p) => p.name === 'Paul').nickname, 'Big P');
    assert.equal(db.games.length, 0, 'demo games gone');
    assert.equal(db.posts.length, 0, 'demo posts gone');
    assert.equal(db.plays.length, 0, 'demo plays gone');
    assert.equal(db.fame.length, 0, 'demo hall of fame gone');
    assert.equal(new Set(db.players.map((p) => p.color)).size, 11, 'everyone gets their own card color');

    const newbie = await post('/api/players', { name: 'Cousin Joey' });
    const again = await post('/api/setup-roster');
    assert.equal(again.result.changed, false);
    assert.ok(again.db.players.some((p) => p.id === newbie.result.id), 'players added later are never removed');
    assert.equal(again.db.players.length, 12);
  } finally {
    s.closeAllConnections();
    s.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
