import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';

const game = (over = {}) => ({
  id: 'g1', date: '2026-09-01', season: '2026', status: 'final',
  teams: { A: ['qa', 'wa', 'xa'], B: ['qb', 'wb', 'xb'] },
  events: [], mvpVotes: {}, ...over,
});
const ev = (type, p1, p2 = null, team) => ({ id: Math.random().toString(36), type, p1, p2, team });

test('ovr <-> elo round-trips and clamps', () => {
  assert.equal(E.eloToOvr(E.ovrToElo(70)), 70);
  assert.equal(E.eloToOvr(E.ovrToElo(99)), 99);
  assert.equal(E.eloToOvr(5000), 99);
  assert.equal(E.eloToOvr(0), 40);
});

test('qbRating: perfect game is 158.3, null with no attempts', () => {
  assert.equal(E.qbRating(E.blankStats()), null);
  const s = { ...E.blankStats(), att: 10, comp: 10, passTD: 4, intThrown: 0 };
  assert.equal(E.qbRating(s).toFixed(1), '158.3');
  const bad = { ...E.blankStats(), att: 10, comp: 2, passTD: 0, intThrown: 3 };
  assert.equal(E.qbRating(bad), 0);
});

test('summarizeGame scores points to the right team and credits stats', () => {
  const g = game({
    events: [
      ev('pass_td', 'qa', 'wa', 'A'), ev('pat1', 'wa', null, 'A'),
      ev('catch', 'qa', 'xa', 'A'), ev('drop', 'xa', 'qa', 'A'), ev('incomplete', 'qa', null, 'A'),
      ev('pick_six', 'wb', 'qa', 'B'), ev('pat2', 'wb', null, 'B'),
      ev('sack', 'xa', 'qb', 'A'), ev('int', 'xa', 'qb', 'A'), ev('rush_td', 'xb', null, 'B'),
    ],
  });
  const s = E.summarizeGame(g);
  assert.deepEqual(s.score, { A: 7, B: 14 });
  assert.equal(s.winner, 'B');
  const qa = s.stats.qa;
  assert.equal(qa.att, 5); // td, catch, drop, incomplete, pick six
  assert.equal(qa.comp, 2);
  assert.equal(qa.passTD, 1);
  assert.equal(qa.intThrown, 1);
  assert.equal(s.stats.wa.recTD, 1);
  assert.equal(s.stats.xa.drops, 1);
  assert.equal(s.stats.xa.sacks, 1);
  assert.equal(s.stats.xa.defInt, 1);
  assert.equal(s.stats.wb.defTD, 1);
  assert.equal(s.stats.qb.sacked, 1);
  assert.equal(E.totalTDs(s.stats.wb), 1);
  assert.equal(E.totalTDs(s.stats.xb), 1);
});

test('live games have no winner yet', () => {
  assert.equal(E.summarizeGame(game({ status: 'live', events: [ev('rush_td', 'qa', null, 'A')] })).winner, null);
});

test('MVP tally: most votes wins, ties go to bigger impact', () => {
  const g = game({
    events: [ev('pass_td', 'qa', 'wa', 'A'), ev('pass_td', 'qa', 'wa', 'A')],
    mvpVotes: { xa: 'wa', xb: 'qa', qb: 'qa', wb: 'wa' },
  });
  const t = E.tallyMvp(g, E.summarizeGame(g));
  assert.equal(t.total, 4);
  assert.equal(t.winner, 'wa'); // receiver scored 2 TDs → more impact than 2 TD passes
});

test('computeLeague: winners gain, losers lose, upsets pay more', () => {
  const players = ['qa', 'wa', 'xa', 'qb', 'wb', 'xb'].map((id) => ({ id, startOvr: 70 }));
  const db = { players, games: [game({ events: [ev('rush_td', 'xa', null, 'A')] })] };
  const L = E.computeLeague(db);
  for (const id of ['qa', 'wa']) assert.ok(L.elo[id] > 1000);
  for (const id of ['qb', 'wb', 'xb']) assert.ok(L.elo[id] < 1000);
  assert.ok(L.elo.xa > L.elo.qa, 'the TD scorer gets a performance bonus');
  assert.equal(L.history.qa.length, 2);

  // underdogs winning should move more than favourites winning
  const strong = ['qa', 'wa', 'xa'].map((id) => ({ id, startOvr: 90 }));
  const weak = ['qb', 'wb', 'xb'].map((id) => ({ id, startOvr: 60 }));
  const fav = E.computeLeague({ players: [...strong, ...weak], games: [game({ events: [ev('rush_td', 'qa', null, 'A')] })] });
  const upset = E.computeLeague({ players: [...strong, ...weak], games: [game({ events: [ev('rush_td', 'qb', null, 'B')] })] });
  assert.ok(upset.games.g1.ratingChanges.wb > fav.games.g1.ratingChanges.wa);
});

test('computeLeague ignores unfinished games for ratings', () => {
  const players = [{ id: 'qa', startOvr: 70 }, { id: 'qb', startOvr: 70 }];
  const L = E.computeLeague({ players, games: [game({ status: 'live', teams: { A: ['qa'], B: ['qb'] }, events: [ev('rush_td', 'qa', null, 'A')] })] });
  assert.equal(L.elo.qa, 1000);
  assert.equal(L.games.g1.ratingChanges, null);
});

test('seasonTable totals W/L, MVPs and filters by season', () => {
  const players = ['qa', 'wa', 'xa', 'qb', 'wb', 'xb'].map((id) => ({ id, startOvr: 70 }));
  const g1 = game({ id: 'g1', events: [ev('rush_td', 'xa', null, 'A')], mvpVotes: { qa: 'xa' } });
  const g2 = game({ id: 'g2', date: '2026-09-08', events: [ev('rush_td', 'xb', null, 'B')] });
  const g3 = game({ id: 'g3', date: '2025-09-08', season: '2025', events: [] });
  const db = { players, games: [g1, g2, g3] };
  const L = E.computeLeague(db);
  const t = E.seasonTable(db, L, '2026');
  assert.deepEqual([t.xa.gp, t.xa.w, t.xa.l, t.xa.mvps, t.xa.rushTD], [2, 1, 1, 1, 1]);
  const career = E.seasonTable(db, L, null);
  assert.equal(career.xa.gp, 3);
  assert.equal(career.xa.t, 1);
});

test('balanceTeams splits 10 players 5v5 with near-equal ratings', () => {
  const elos = [1300, 1250, 1200, 1100, 1050, 1000, 950, 900, 850, 800];
  const players = elos.map((elo, i) => ({ id: `p${i}`, elo, position: 'ATH' }));
  for (let run = 0; run < 20; run++) {
    const r = E.balanceTeams(players);
    assert.equal(r.A.length, 5);
    assert.equal(r.B.length, 5);
    assert.equal(new Set([...r.A, ...r.B]).size, 10);
    assert.ok(r.diff <= 12 + 1e-9, `diff ${r.diff}`);
    assert.ok(Math.abs(r.winProbA - 0.5) < 0.03);
  }
});

test('balanceTeams handles odd counts and splits QBs', () => {
  const players = [
    { id: 'q1', elo: 1100, position: 'QB' }, { id: 'q2', elo: 1100, position: 'QB' },
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: `p${i}`, elo: 1000 + i * 10, position: 'WR' })),
  ];
  for (let run = 0; run < 20; run++) {
    const r = E.balanceTeams(players);
    assert.equal(r.A.length + r.B.length, 9);
    assert.ok(Math.abs(r.A.length - r.B.length) === 1);
    assert.ok(r.A.includes('q1') !== r.A.includes('q2'), 'QBs end up on different teams');
  }
});

test('balanceTeams reshuffles give different fair teams', () => {
  const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, elo: 1000 + (i % 3) * 5 }));
  const seen = new Set();
  for (let run = 0; run < 30; run++) seen.add(E.balanceTeams(players).A.slice().sort().join());
  assert.ok(seen.size > 3);
});

test('balanceTeams works for big turnouts', () => {
  const players = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, elo: 800 + i * 20 }));
  const r = E.balanceTeams(players);
  assert.equal(r.A.length, 12);
  assert.ok(r.diff < 20);
});
