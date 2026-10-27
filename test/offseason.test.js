import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, matchRoute, emptyDb } from '../public/league.js';
import { faState, marketValue, keeperPrice, nextSeasonName, timeLeft, bowlName, CAP, FRENZY_DAYS } from '../public/offseason.js';
import * as E from '../public/engine.js';

const routes = buildRoutes();
const H = (c) => c.repeat(64);
const call = (db, m, p, b = {}) => { const hit = matchRoute(routes, m, p); return hit.route.handler(db, b, hit.params, { images: [] }); };
// rejected changes run on a copy (the real app throws the whole change away)
const refused = (db, m, p, b, re) => assert.throws(() => call(structuredClone(db), m, p, b), re);
const names = ['Paul', 'Ben', 'Boden', 'Liam', 'Bobby', 'Lucas', 'Max', 'Henry', 'Kellen', 'Dane', 'Noah', 'Matteo', 'Evan', 'Teddy', 'Logan', 'Will'];
const as = (id) => ({ _auth: { as: id, pinHash: H(id[0] < 'n' ? 'a' : 'b') } });

function league() {
  const db = emptyDb();
  db.settings.season = '2026';
  for (const [i, n] of names.entries()) {
    const id = n.toLowerCase();
    db.players.push({ id, name: n, active: true, startOvr: 60 + (i * 7) % 30, pinHash: H(id[0] < 'n' ? 'a' : 'b'), createdAt: '2026-01-01T00:00:00.000Z' });
  }
  call(db, 'POST', '/api/setup-teams');
  const teams = db.settings.teams.map((t) => ({ ...t }));
  teams[0].coachId = 'logan';
  teams[1].coachId = 'will';
  call(db, 'PUT', '/api/season-teams', { teams, ...as('paul') });
  return db;
}
const play = (db, date) => {
  const g = call(db, 'POST', '/api/games', { date });
  g.teams = { A: [...db.settings.teams[0].players], B: [...db.settings.teams[1].players] };
  g.status = 'live';
  g.events.push({ id: `e${date}`, type: 'rush_td', p1: 'ben', p2: null, team: 'A', ts: `${date}T18:00:00.000Z` });
  return g;
};

test('offseason helpers: market value, keeper tag, season names, countdown', () => {
  assert.equal(marketValue(70, 70), 14, 'an average player is worth $14M');
  assert.equal(marketValue(80, 70), 27.5, 'ten points above average: about double');
  assert.equal(marketValue(56, 70), 5.5, 'well below average is still worth something');
  assert.equal(marketValue(20, 70), 1, 'never under the minimum');
  assert.equal(marketValue(99, 60), 40, 'never over the max');
  assert.equal(keeperPrice(14), 17, 'keeper tag = 20% over market');
  assert.equal(nextSeasonName('2026'), '2026 S2');
  assert.equal(nextSeasonName('2026 S2'), '2026 S3');
  assert.equal(timeLeft(5 * 864e5 + 4 * 36e5), '5d 4h');
  assert.equal(timeLeft(-1), '0m');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(bowlName), [null, null, null, 'Bowl I', null, null, null, 'Bowl II', 'Super Bowl']);
});
// a season of game dates, one a week from Jan 1 2099
const weeks = (n, from = 0) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2099, 0, 1 + 7 * (i + from))).toISOString().slice(0, 10));

test('real app: Bowls are whatever admins mark; only the Super Bowl starts free agency', () => {
  const db = league();
  const gs = weeks(3).map((d) => play(db, d));
  call(db, 'PATCH', `/api/games/${gs[0].id}`, { bowlName: 'Bowl I', ...as('paul') });
  call(db, 'PATCH', `/api/games/${gs[1].id}`, { bowlName: 'Bowl II', ...as('paul') });
  for (const g of gs.slice(0, 2)) call(db, 'POST', `/api/games/${g.id}/final`);
  assert.equal(db.settings.offseason, undefined, 'Bowl I and Bowl II don\'t start free agency');
  call(db, 'PATCH', `/api/games/${gs[2].id}`, { bowlName: 'Super Bowl', ...as('paul') });
  call(db, 'POST', `/api/games/${gs[2].id}/final`);
  assert.equal(db.settings.offseason.phase, 'keepers');
  assert.equal(db.settings.offseason.bowlId, gs[2].id);
  // reopening and finishing the Super Bowl again (fixing a stat) doesn't restart it
  db.settings.offseason.keepers = { x: 1 };
  call(db, 'POST', `/api/games/${gs[2].id}/reopen`);
  call(db, 'POST', `/api/games/${gs[2].id}/final`);
  assert.deepEqual(db.settings.offseason.keepers, { x: 1 });
});

test('free agency: bowl → keepers → a week of offers and signings → next season', () => {
  const db = league();
  const [gif, sos] = db.settings.teams.map((t) => t.id);
  refused(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: [], ...as('logan') }, /after the Super Bowl/);
  for (const d of weeks(8)) { const g = play(db, d); call(db, 'POST', `/api/games/${g.id}/final`); }
  assert.equal(db.settings.offseason, undefined, 'no free agency without a Super Bowl');
  const bowl = play(db, weeks(1, 8)[0]);
  call(db, 'PATCH', `/api/games/${bowl.id}`, { bowlName: 'Super Bowl', ...as('paul') });
  call(db, 'POST', `/api/games/${bowl.id}/final`);
  const os = db.settings.offseason;
  assert.equal(os.phase, 'keepers');
  assert.equal(os.season, '2026');
  refused(db, 'POST', '/api/games', { date: weeks(1, 9)[0] }, /picking keepers/);

  // keepers: only that team's coach (or an admin), up to 2, from his own roster
  refused(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: ['ben'], lock: true, ...as('ben') }, /coach/);
  refused(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: ['ben'], lock: true, ...as('will') }, /coach/);
  refused(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: ['ben', 'boden', 'liam'], lock: true, ...as('logan') }, /up to 2/);
  refused(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: ['max'], lock: true, ...as('logan') }, /isn't on Giffinland/);
  call(db, 'POST', '/api/offseason/keepers', { teamId: gif, ids: ['ben', 'lucas'], lock: true, ...as('logan') });
  assert.equal(os.phase, 'keepers', 'waits for the other coach');
  refused(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'max', amount: 10, ...as('logan') }, /picking keepers/);
  call(db, 'POST', '/api/offseason/keepers', { teamId: sos, ids: ['max'], lock: true, ...as('will') });
  assert.equal(os.phase, 'frenzy', 'both locked: free agency opens');
  assert.equal(Date.parse(os.endsAt) - Date.parse(os.opensAt), FRENZY_DAYS * 864e5, 'a week long');

  let st = faState(db, { ovr: E.computeLeague(db).ovr });
  const g = st.teamOf(gif);
  assert.deepEqual(g.roster, ['logan', 'ben', 'lucas'], 'coach + keepers');
  assert.equal(g.capUsed, g.kept.reduce((t, k) => t + k.amount, 0), 'keeper tags count against the cap');
  assert.ok(!st.freeAgents.includes('ben') && !st.freeAgents.includes('logan') && st.freeAgents.includes('henry'));
  assert.equal(st.rosterMax, 8, '16 players, 2 teams');

  // offers: coach of that team, free agents only, within the cap
  refused(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'henry', amount: 10, ...as('kellen') }, /coach/);
  refused(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'max', amount: 10, ...as('logan') }, /not a free agent/);
  refused(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'henry', amount: g.capSpace + 1, ...as('logan') }, /cap space|biggest/);
  const o1 = call(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'henry', amount: 18, ...as('logan') });
  const o2 = call(db, 'POST', '/api/offseason/offers', { teamId: sos, playerId: 'henry', amount: 20, ...as('will') });
  call(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'henry', amount: 22.3, ...as('logan') });
  assert.equal(os.offers.find((o) => o.id === o1.id).amount, 22.5, 'one offer per team, updated, rounded to $0.5M');
  assert.equal(os.feed.filter((f) => f.kind === 'offer').length, 2, 'the wire reports interest once per team');

  // signing: the player himself (or an admin)
  refused(db, 'POST', `/api/offseason/offers/${o1.id}/sign`, as('kellen'), /Only Henry/);
  call(db, 'POST', `/api/offseason/offers/${o1.id}/sign`, as('henry'));
  assert.deepEqual(os.signings.map((s) => [s.playerId, s.teamId, s.amount]), [['henry', gif, 22.5]]);
  assert.ok(!os.offers.some((o) => o.playerId === 'henry'), "Sostreville's offer is off the table");
  assert.deepEqual(os.feed.at(-1).passedOn, [sos]);
  refused(db, 'POST', `/api/offseason/offers/${o2.id}/sign`, as('henry'), /gone/);
  // decline
  const o3 = call(db, 'POST', '/api/offseason/offers', { teamId: sos, playerId: 'dane', amount: 5, ...as('will') });
  call(db, 'POST', `/api/offseason/offers/${o3.id}/decline`, as('dane'));
  assert.ok(!os.offers.some((o) => o.id === o3.id));
  // withdraw
  const o4 = call(db, 'POST', '/api/offseason/offers', { teamId: sos, playerId: 'noah', amount: 5, ...as('will') });
  refused(db, 'DELETE', `/api/offseason/offers/${o4.id}`, as('logan'), /coach/);
  call(db, 'DELETE', `/api/offseason/offers/${o4.id}`, as('will'));

  // the cap: signing has to fit when he signs
  st = faState(db, { ovr: E.computeLeague(db).ovr });
  const space = st.teamOf(gif).capSpace;
  const big = call(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'kellen', amount: Math.min(40, space), ...as('logan') });
  const big2 = call(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: 'noah', amount: Math.min(40, space), ...as('logan') });
  call(db, 'POST', `/api/offseason/offers/${big.id}/sign`, as('kellen'));
  refused(db, 'POST', `/api/offseason/offers/${big2.id}/sign`, as('noah'), /cap space/);

  // closing early: admins only (until the week is up)
  refused(db, 'POST', '/api/offseason/close', as('ben'), /close free agency early/);
  // the week runs out: anyone's phone can close it
  os.endsAt = new Date(Date.now() - 1000).toISOString();
  refused(db, 'POST', '/api/offseason/offers', { teamId: sos, playerId: 'teddy', amount: 5, ...as('will') }, /over/);
  call(db, 'POST', '/api/offseason/close');
  assert.equal(os.phase, 'closed');
  assert.equal(db.settings.season, '2026 S2');
  const [t0, t1] = db.settings.teams;
  assert.deepEqual(t0.players, ['logan', 'ben', 'lucas', 'henry', 'kellen'], 'coach, keepers, signings');
  assert.deepEqual(t1.players, ['will', 'max']);
  assert.equal(t0.season, '2026 S2');
  assert.deepEqual(db.settings.contracts.map((c) => [c.playerId, c.kind, c.season]),
    [['ben', 'keeper', '2026 S2'], ['lucas', 'keeper', '2026 S2'], ['henry', 'signed', '2026 S2'], ['kellen', 'signed', '2026 S2'], ['max', 'keeper', '2026 S2']]);
  assert.ok(os.feed.at(-1).unsigned.includes('teddy'), 'unsigned players stay free agents');
  // next season: games can be scheduled again, in the new season
  assert.equal(call(db, 'POST', '/api/games', { date: '2099-02-01' }).season, '2026 S2');
});

test('free agency: admins can act for a team without a coach, open it early, and rosters fill up', () => {
  const db = league();
  db.settings.teams[1].coachId = undefined;
  const gs = weeks(9).map((d) => play(db, d));
  call(db, 'PATCH', `/api/games/${gs[8].id}`, { bowlName: 'Super Bowl', ...as('paul') });
  for (const g of gs) call(db, 'POST', `/api/games/${g.id}/final`);
  const [gif, sos] = db.settings.teams.map((t) => t.id);
  refused(db, 'POST', '/api/offseason/open', as('ben'), /open free agency early/);
  call(db, 'POST', '/api/offseason/keepers', { teamId: sos, ids: ['max', 'henry'], ...as('paul') });
  call(db, 'POST', '/api/offseason/open', as('paul'));
  assert.equal(db.settings.offseason.phase, 'frenzy');
  const st = faState(db, { ovr: E.computeLeague(db).ovr });
  assert.deepEqual(st.teamOf(sos).roster, ['max', 'henry'], 'unlocked picks still count when an admin opens it');
  // Giffinland fills its 8 spots with $1M deals; the 9th can't sign
  const fas = st.freeAgents.filter((p) => p !== 'paul');
  const offers = fas.slice(0, 8).map((pid) => call(db, 'POST', '/api/offseason/offers', { teamId: gif, playerId: pid, amount: 1, ...as('logan') }));
  for (const o of offers.slice(0, 7)) call(db, 'POST', `/api/offseason/offers/${o.id}/sign`, as('paul'));
  assert.equal(faState(db, { ovr: E.computeLeague(db).ovr }).teamOf(gif).rosterOpen, 0);
  refused(db, 'POST', `/api/offseason/offers/${offers[7].id}/sign`, as('paul'), /roster is full/);
  assert.ok(CAP >= 100);
});
