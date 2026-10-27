import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { buildRoutes, matchRoute, emptyDb, seasonCaptain, seasonCoach, coachOf, HFL_TEAMS } from '../public/league.js';
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
  db.games.push({ id: 'old', date: '2099-10-10', season: db.settings.season, status: 'scheduled', rsvps: { paul: 'in', max: 'in', evan: 'in' }, teams: { A: ['paul', 'max'], B: ['evan'] }, events: [], mvpVotes: {}, teamNames: { A: 'Shirts', B: 'Skins' } });
  const r = call(db, 'POST', '/api/setup-teams');
  assert.deepEqual(r.teams, ['Giffinland', 'Sostreville']);
  assert.deepEqual(db.settings.teams[0].players, HFL_TEAMS[0].players.map(id));
  assert.equal(call(db, 'POST', '/api/setup-teams').changed, false, 'only once');
  const old = db.games[0];
  assert.deepEqual(old.teamNames, { A: 'Giffinland', B: 'Sostreville' });
  assert.deepEqual(old.teams.A, ['paul'], 'already-scheduled game re-lined up by team');
  assert.ok(old.teams.B.includes('max') && old.teams.B.includes('evan'), 'free agent Evan stays where he was');

  const g = call(db, 'POST', '/api/games', { date: '2099-10-17' });
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
  const g = call(db, 'POST', '/api/games', { date: '2099-10-17' });
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

test('coaches: admins set them, a coach plays for his team, one coach per team', () => {
  const db = setup();
  call(db, 'POST', '/api/setup-teams');
  const admin = { as: 'paul', pinHash: H('a') };
  const teams = () => db.settings.teams.map((x) => ({ ...x }));
  // Evan is a free agent: making him Giffinland's coach puts him on Giffinland
  const t1 = teams(); t1[0].coachId = 'evan';
  // (rejected changes run on a copy: the real app throws the whole change away)
  assert.throws(() => call(structuredClone(db), 'PUT', '/api/season-teams', { teams: t1, _auth: { as: 'ben', pinHash: H('b') } }), /locked/, 'admins only');
  call(db, 'PUT', '/api/season-teams', { teams: t1, _auth: admin });
  assert.equal(seasonCoach(db, db.settings.teams[0]), 'evan');
  assert.ok(db.settings.teams[0].players.includes('evan'));
  assert.equal(coachOf(db, 'evan').name, 'Giffinland');
  // Max (Sostreville) as Giffinland's coach moves him over
  const t2 = teams(); t2[0].coachId = 'max';
  call(db, 'PUT', '/api/season-teams', { teams: t2, _auth: admin });
  assert.ok(db.settings.teams[0].players.includes('max') && !db.settings.teams[1].players.includes('max'));
  // same coach for both teams: no
  const t3 = teams(); t3[1].coachId = 'max';
  assert.throws(() => call(structuredClone(db), 'PUT', '/api/season-teams', { teams: t3, _auth: admin }), /one coach per team/);
  // saving without a coachId keeps the coach; an empty one clears it
  const t4 = teams().map(({ coachId, ...x }) => x);
  call(db, 'PUT', '/api/season-teams', { teams: t4, _auth: admin });
  assert.equal(db.settings.teams[0].coachId, 'max');
  const t5 = teams(); t5[0].coachId = null;
  call(db, 'PUT', '/api/season-teams', { teams: t5, _auth: admin });
  assert.equal(seasonCoach(db, db.settings.teams[0]), null);
  assert.throws(() => call(structuredClone(db), 'PUT', '/api/season-teams', { teams: [{ ...teams()[0], coachId: 'nobody' }, teams()[1]], _auth: admin }), /coach/);
});

test('Bowls: the next scheduled game becomes Bowl I once; admins mark Bowls; one per name a season', () => {
  const db = setup();
  call(db, 'POST', '/api/setup-teams');
  const admin = { as: 'paul', pinHash: H('a') };
  const done = call(db, 'POST', '/api/games', { date: '2000-01-01' });
  done.status = 'final';
  const later = call(db, 'POST', '/api/games', { date: '2099-10-24' });
  const next = call(db, 'POST', '/api/games', { date: '2099-10-17' });
  const r = call(db, 'POST', '/api/setup-bowls');
  assert.equal(r.gameId, next.id, 'the soonest upcoming game, not an old one or a later one');
  assert.equal(next.bowlName, 'Bowl I');
  assert.ok(!later.bowlName && !done.bowlName);
  assert.equal(call(db, 'POST', '/api/setup-bowls').changed, false, 'one time only');
  // only admins change Bowls; a Bowl name moves rather than duplicating
  assert.throws(() => call(structuredClone(db), 'PATCH', `/api/games/${later.id}`, { bowlName: 'Bowl II', _auth: { as: 'ben', pinHash: H('b') } }), /locked/);
  call(db, 'PATCH', `/api/games/${later.id}`, { bowlName: 'Bowl I', _auth: admin });
  assert.equal(later.bowlName, 'Bowl I');
  assert.equal(next.bowlName, undefined, 'Bowl I moved to the other game');
  call(db, 'PATCH', `/api/games/${later.id}`, { bowlName: 'Super Bowl', _auth: admin });
  assert.equal(later.bowlName, 'Super Bowl');
  assert.throws(() => call(structuredClone(db), 'PATCH', `/api/games/${later.id}`, { bowlName: 'Toilet Bowl', _auth: admin }), /Bowl I, Bowl II or the Super Bowl/);
  call(db, 'PATCH', `/api/games/${later.id}`, { location: 'The park' }); // other edits still open to everyone
  assert.equal(later.bowlName, 'Super Bowl');
  call(db, 'PATCH', `/api/games/${later.id}`, { bowlName: null, _auth: admin });
  assert.equal(later.bowlName, undefined);

  // nothing on the schedule yet: the next game made is Bowl I
  const db2 = setup();
  call(db2, 'POST', '/api/setup-teams');
  assert.equal(call(db2, 'POST', '/api/setup-bowls').pending, true);
  assert.equal(call(db2, 'POST', '/api/games', { date: '2099-11-01' }).bowlName, 'Bowl I');
  assert.equal(call(db2, 'POST', '/api/games', { date: '2099-11-08' }).bowlName, undefined, 'just that one');
});
