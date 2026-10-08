import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256hex } from '../public/sha256.js';
import { makeLock, openLock, secretsMatch, encryptJSON, decryptJSON } from '../public/teamlock.js';
import { buildRoutes, matchRoute, emptyDb, teamCaptain } from '../public/league.js';

test('sha256hex matches node:crypto', () => {
  for (const s of ['', 'abc', 'hfl|x|1234', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'é🏈'.repeat(40), 'x'.repeat(1000)]) {
    assert.equal(sha256hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), `len ${s.length}`);
  }
});

test('team lock: the right PIN opens it, a wrong one does not; plays round-trip encrypted', async () => {
  const { lock, secrets } = await makeLock('482913', { iter: 50_000 });
  assert.ok(!JSON.stringify(lock).includes('482913'), 'the PIN is never stored');
  assert.equal(await openLock(lock, '000000'), null);
  const again = await openLock(lock, '482913');
  assert.deepEqual(again, secrets);
  assert.ok(secretsMatch(lock, secrets));
  const play = { name: 'Double move', routes: [{ pid: 'x', points: [[1, 2], [3, 4]] }] };
  const box = await encryptJSON(secrets.key, play);
  assert.ok(!box.ct.includes('Double') && !JSON.stringify(box).includes('Double move'), 'unreadable without the key');
  assert.deepEqual(await decryptJSON(secrets.key, box), play);
  const other = await makeLock('482913', { iter: 50_000 }); // same PIN, different salt → different key
  await assert.rejects(() => decryptJSON(other.secrets.key, box));
  await assert.rejects(() => makeLock('12'), /4 to 8 digits/);
});

const routes = buildRoutes();
const H = (c) => c.repeat(64);
const as = (id, c) => ({ _auth: { as: id, pinHash: H(c) } });
const call = (db, method, path, body = {}) => { const hit = matchRoute(routes, method, path); return hit.route.handler(db, body, hit.params, { images: [] }); };
function setup() {
  const db = emptyDb();
  db.players.push(
    { id: 'paul', name: 'Paul', active: true, pinHash: H('a'), startOvr: 60 },
    { id: 'star', name: 'Star', active: true, pinHash: H('b'), startOvr: 90 },
    { id: 'joe', name: 'Joe', active: true, pinHash: H('c'), startOvr: 70 },
    { id: 'opp', name: 'Opp', active: true, pinHash: H('d'), startOvr: 85 },
    { id: 'opp2', name: 'Opp2', active: true, pinHash: H('e'), startOvr: 65 },
  );
  db.games.push({ id: 'g1', date: '2026-10-03', season: '2026', status: 'scheduled', rsvps: {}, teams: { A: ['star', 'joe'], B: ['opp', 'opp2', 'paul'] }, events: [], mvpVotes: {}, teamNames: { A: 'Shirts', B: 'Skins' } });
  return db;
}

test('team captains are the highest-rated player on each side', () => {
  const db = setup();
  assert.equal(teamCaptain(db, db.games[0], 'A'), 'star');
  assert.equal(teamCaptain(db, db.games[0], 'B'), 'opp');
});

test('team playbook rules: captain/admin sets the PIN, only the PIN opens writes, changing re-locks everything', async () => {
  const db = setup();
  const g = db.games[0];
  const { lock, secrets } = await makeLock('111111', { iter: 50_000 });
  assert.throws(() => call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock, ...as('joe', 'c') }), /captain/);
  assert.throws(() => call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock, ...as('opp', 'd') }), /captain/, 'the other captain can’t');
  call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock, ...as('star', 'b') });
  assert.equal(g.teamLocks.A.proofHash, lock.proofHash);
  assert.equal(g.teamLocks.A.setBy, 'star');
  // admin (Paul is on the other team) can set team B's
  const lockB = await makeLock('222222', { iter: 50_000 });
  call(db, 'POST', '/api/games/g1/team-lock', { side: 'B', lock: lockB.lock, ...as('paul', 'a') });

  const box = await encryptJSON(secrets.key, { name: 'Flood' });
  assert.throws(() => call(db, 'POST', '/api/plays', { gameId: 'g1', side: 'A', enc: box }), /team PIN/);
  assert.throws(() => call(db, 'POST', '/api/plays', { gameId: 'g1', side: 'A', enc: box, _team: lockB.secrets.proof }), /team PIN/, "team B's PIN doesn't open team A");
  const p = call(db, 'POST', '/api/plays', { gameId: 'g1', side: 'A', enc: box, _team: secrets.proof, authorId: 'joe' });
  assert.deepEqual(Object.keys(p).sort(), ['authorId', 'createdAt', 'enc', 'gameId', 'id', 'side', 'updatedAt'], 'no play name or routes in the clear');
  assert.throws(() => call(db, 'PUT', `/api/plays/${p.id}`, { enc: box, _team: lockB.secrets.proof }), /team PIN/);
  assert.throws(() => call(db, 'DELETE', `/api/plays/${p.id}`, as('opp', 'd')), /team PIN/, 'the other team can’t delete it');
  assert.throws(() => call(db, 'POST', '/api/plays', { gameId: 'g1', side: 'A', enc: { iv: 'x', ct: 'y' }, _team: secrets.proof }), /encrypted/);
  // league plays can't be turned into team plays
  const league = call(db, 'POST', '/api/plays', { name: 'Public', players: [], routes: [] });
  assert.throws(() => call(db, 'PUT', `/api/plays/${league.id}`, { enc: box, gameId: 'g1', side: 'A', _team: secrets.proof }), /copy/);

  // change the PIN: needs the old one and every play re-locked
  const next = await makeLock('333333', { iter: 50_000 });
  const rebox = await encryptJSON(next.secrets.key, { name: 'Flood' });
  assert.throws(() => call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock: next.lock, plays: [{ id: p.id, enc: rebox }], ...as('star', 'b') }), /current team PIN/);
  assert.throws(() => call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock: next.lock, plays: [], _team: secrets.proof, ...as('star', 'b') }), /every team play/);
  call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', lock: next.lock, plays: [{ id: p.id, enc: rebox }], _team: secrets.proof, ...as('star', 'b') });
  assert.deepEqual(await decryptJSON(next.secrets.key, db.plays.find((x) => x.id === p.id).enc), { name: 'Flood' });

  // forgot it: reset wipes that team's plays only
  call(db, 'POST', '/api/games/g1/team-lock', { side: 'A', reset: true, lock: null, ...as('paul', 'a') });
  assert.equal(g.teamLocks.A, undefined);
  assert.equal(db.plays.filter((x) => x.gameId === 'g1' && x.side === 'A').length, 0);
  assert.equal(db.plays.filter((x) => !x.gameId).length, 1, 'league playbook untouched');
});
