import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { buildRoutes, matchRoute, emptyDb } from '../public/league.js';

const teams = { A: ['qa', 'wa'], B: ['qb', 'wb'] };
const players = ['qa', 'wa', 'qb', 'wb'].map((id) => ({ id, name: id.toUpperCase(), startOvr: 70 }));
const ev = (type, p1, p2, team, i) => ({ id: `e${i}`, type, p1, p2, team, ts: '2026-10-03T18:00:00Z' });

test('box score: typed totals give the same stats and score as the same game logged play by play', () => {
  const events = [ev('pass_td', 'qa', 'wa', 'A', 1), ev('catch', 'qa', 'wa', 'A', 2), ev('int', 'wb', 'qa', 'B', 3), ev('rush_td', 'qb', null, 'B', 4), ev('pick_six', 'wa', 'qb', 'A', 5), ev('sack', 'wb', 'qa', 'B', 6), ev('drop', 'wb', 'qb', 'B', 7)];
  const logged = E.summarizeGame({ status: 'final', teams, events });
  const typed = E.summarizeGame({ status: 'final', teams, events: [], box: {
    qa: { comp: 2, att: 3, passTD: 1, intThrown: 1 },
    wa: { rec: 2, recTD: 1, defInt: 1, defTD: 1 },
    qb: { rushTD: 1, att: 2, intThrown: 1 },
    wb: { defInt: 1, sacks: 1, drops: 1 },
  } });
  assert.deepEqual(typed.score, logged.score);
  assert.equal(typed.winner, 'A');
  for (const id of ['qa', 'wa']) for (const k of ['comp', 'att', 'passTD', 'intThrown', 'rec', 'recTD', 'defInt', 'defTD']) assert.equal(typed.stats[id][k], logged.stats[id][k], `${id}.${k}`);
  assert.equal(E.qbRating(typed.stats.qa), E.qbRating(logged.stats.qa));
});

test('box score: typed lines are made consistent instead of rejected', () => {
  const v = E.normalizeBoxLine({ passTD: 3, recTD: 2, defTD: 1, intThrown: 1, comp: 'x', att: -4 });
  assert.deepEqual([v.comp, v.att, v.rec, v.defInt], [3, 4, 2, 1]);
  assert.equal(E.boxPoints({ recTD: 2, rushTD: 1, defTD: 1, passTD: 5 }), 24, 'TD passes don’t score twice');
});

test('box score: ratings, MVP math and records work from typed stats', () => {
  const g = { id: 'g1', date: '2026-10-03', season: '2026', status: 'final', teams, events: [], mvpVotes: {}, endedAt: '2026-10-03T20:00:00Z',
    box: { wa: { rec: 6, recTD: 3 }, qa: { comp: 6, att: 8, passTD: 3 } } };
  const league = E.computeLeague({ players, games: [g] });
  assert.equal(league.games.g1.summary.score.A, 18);
  assert.ok(league.elo.wa > E.ovrToElo(70), 'the guy with 3 TD catches went up');
  const table = E.seasonTable({ players, games: [g] }, league, '2026');
  assert.equal(table.wa.recTD, 3);
  assert.equal(table.wa.w, 1);
});

test('box score route: anyone can enter it once the game starts; only real players; null switches back', () => {
  const routes = buildRoutes();
  const call = (db, m, p, b = {}) => { const hit = matchRoute(routes, m, p); return hit.route.handler(db, b, hit.params, { images: [] }); };
  const db = emptyDb();
  db.players.push(...players);
  const g = { id: 'g1', date: '2026-10-03', season: '2026', status: 'scheduled', rsvps: {}, teams, events: [], mvpVotes: {}, teamNames: { A: 'Shirts', B: 'Skins' } };
  db.games.push(g);
  assert.throws(() => call(db, 'PUT', '/api/games/g1/box', { box: { qa: { passTD: 1 } } }), /start the game/);
  g.status = 'live';
  assert.throws(() => call(db, 'PUT', '/api/games/g1/box', { box: { nobody: { passTD: 1 } } }), /isn’t in this game/);
  assert.throws(() => call(db, 'PUT', '/api/games/g1/box', { box: { qa: { yards: 300 } } }), /unknown stat/);
  call(db, 'PUT', '/api/games/g1/box', { box: { qa: { passTD: 2 }, wa: { recTD: 2 }, qb: {} }, by: 'qa' });
  assert.deepEqual(Object.keys(g.box), ['qa', 'wa'], 'empty lines are dropped');
  assert.equal(g.box.qa.comp, 2);
  assert.equal(E.summarizeGame(g).score.A, 12);
  call(db, 'PUT', '/api/games/g1/box', { box: null });
  assert.equal('box' in g, false);
});
