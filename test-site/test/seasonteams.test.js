import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { buildRoutes, matchRoute, emptyDb, seasonCaptain, HFL_TEAMS } from '../public/league.js';
import { makeLock, encryptJSON } from '../public/teamlock.js';

const routes = buildRoutes();
const H = (c) => c.repeat(64);
const call = (db, m, p, b = {}) => { const hit = matchRoute(routes, m, p); return hit.route.handler(db, b, hit.params, { images: [] }); };
const names = ['Paul', 'Ben', 'Boden', 'Liam', 'Bobby', 'Lucas', 'Max', 'Henry', 'Kellen', 'Dane', 'Noah', 'Matteo', 'Evan', 'Teddy'];
function setup() {
  const db = emptyDb();
  for (const n of names) db.players.push({ id: n.toLowerCase(), name: n, active: true, startOvr: n === 'Kellen' ? 90 : n === 'Lucas' ? 88 : 70, pinHash: H(n[0].toLowerCase().replace(/[^a-f]/, 'a')) });
  return db;
}
const id = (n) => n.toLowerCase();

test('season teams: set up once from the names, lined up in every new game', () => {
  const db = setup();
  db.games.push({ id: 'old', date: '2026-10-10', season: db.settings.season, status: 'scheduled', rsvps: { paul: 'in', max: 'in', evan: 'in' }, teams: { A: ['paul', 'max'], B: ['evan'] }, events: [], mvpVotes: {}, teamNames: { A: 'Shirts', B: 'Skins' } });
  const r = call(db, 'POST', '/api/setup-teams');
  assert.deepEqual(r.teams, ['Giffinland', 'Sostreville']);
  assert.deepEqual(db.settings.teams[0].players, HFL_TEAMS[0].players.map(id));
  assert.equal(call(db, 'POST', '/api/setup-teams').changed, false, 'only once');
  const old = db.games[0];
  assert.deepEqual(old.teamNames, { A: 'Giffinland', B: 'Sostreville' });
  assert.deepEqual(old.teams.A, ['paul'], 'already-scheduled game re-lined up by team');
  assert.ok(old.teams.B.includes('max') && old.teams.B.includes('evan'), 'free agent Evan stays where he was');

  const g = call(db, 'POST', '/api/games', { date: '2026-10-17' });
  assert.deepEqual(g.teamIds, { A: 'giffinland', B: 'sostreville' });
  call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: 'ben', status: 'in' });
  call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: 'kellen', status: 'in' });
  call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: 'teddy', status: 'in' });
  assert.deepEqual(g.teams, { A: ['ben'], B: ['kellen'] }, 'RSVP in = on your team; free agents wait to be placed');
  call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: 'ben', status: 'out' });
  assert.deepEqual(g.teams.A, [], 'RSVP out takes you off');
  call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: 'ben', status: 'in' });
  call(db, 'POST', `/api/games/${g.id}/auto-teams`);
  assert.deepEqual(g.teams, { A: ['ben'], B: ['kellen'] }, 'no shuffling with season teams');
});

test('season teams: only admins edit them; one team per player', () => {
  const db = setup();
  call(db, 'POST', '/api/setup-teams');
  const teams = db.settings.teams.map((t) => ({ ...t }));
  teams[0] = { ...teams[0], players: [...teams[0].players, 'evan'] };
  assert.throws(() => call(db, 'PUT', '/api/season-teams', { teams, _auth: { as: 'ben', pinHash: H('b') } }), /locked/);
  call(db, 'PUT', '/api/season-teams', { teams, _auth: { as: 'paul', pinHash: H('a') } });
  assert.ok(db.settings.teams[0].players.includes('evan'));
  const dup = [teams[0], { ...teams[1], players: [...teams[1].players, 'evan'] }];
  assert.throws(() => call(db, 'PUT', '/api/season-teams', { teams: dup, _auth: { as: 'paul', pinHash: H('a') } }), /one team/);
});

test('season teams: captains, standings and season-long private playbooks', async () => {
  const db = setup();
  call(db, 'POST', '/api/setup-teams');
  const league = E.computeLeague(db);
  assert.equal(seasonCaptain(db, db.settings.teams[0], league), 'lucas');
  assert.equal(seasonCaptain(db, db.settings.teams[1], league), 'kellen');
  // standings
  const g = call(db, 'POST', '/api/games', { date: '2026-10-17' });
  for (const p of ['ben', 'kellen']) call(db, 'POST', `/api/games/${g.id}/rsvp`, { playerId: p, status: 'in' });
  g.status = 'final';
  g.box = { kellen: { rushTD: 2 }, ben: { rushTD: 1 } };
  const st = E.seasonStandings(db, E.computeLeague(db), db.settings.season);
  assert.deepEqual(st.map((r) => [r.id, r.w, r.l, r.pf, r.pa]), [['sostreville', 1, 0, 12, 6], ['giffinland', 0, 1, 6, 12]]);
  // playbook belongs to the team, across games
  const { lock, secrets } = await makeLock('135790', { iter: 50_000 });
  assert.throws(() => call(db, 'POST', '/api/season-teams/sostreville/lock', { lock, _auth: { as: 'dane', pinHash: H('d') } }), /captain/);
  call(db, 'POST', '/api/season-teams/sostreville/lock', { lock, _auth: { as: 'kellen', pinHash: H('a') } });
  const box = await encryptJSON(secrets.key, { name: 'Sosty special' });
  const play = call(db, 'POST', '/api/plays', { teamId: 'sostreville', enc: box, _team: secrets.proof });
  assert.equal(play.teamId, 'sostreville');
  assert.equal(play.gameId, undefined);
  assert.throws(() => call(db, 'POST', '/api/plays', { teamId: 'giffinland', enc: box, _team: secrets.proof }), /team PIN/);
  assert.throws(() => call(db, 'DELETE', `/api/plays/${play.id}`, { _auth: { as: 'lucas', pinHash: H('a') } }), /team PIN/, 'the other captain can’t delete it');
});
