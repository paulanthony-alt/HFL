import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { computeAwards, weekOf, milestoneLabel, MILESTONES, DESIGNS, cardDesign } from '../public/awards.js';
import { buildRecap } from '../public/recap.js';

const ev = (type, p1, p2 = null, team) => ({ id: Math.random().toString(36).slice(2), type, p1, p2, team });
const players = ['qa', 'wa', 'xa', 'qb', 'wb', 'xb'].map((id) => ({ id, name: id.toUpperCase(), startOvr: 70 }));
const game = (id, date, events, over = {}) => ({
  id, date, season: '2026', status: 'final', teams: { A: ['qa', 'wa', 'xa'], B: ['qb', 'wb', 'xb'] },
  teamNames: { A: 'Shirts', B: 'Skins' }, events, mvpVotes: {}, endedAt: `${date}T20:00:00.000Z`, ...over,
});

test('weekOf gives the Monday', () => {
  assert.equal(weekOf('2026-10-04'), '2026-09-28'); // Sunday
  assert.equal(weekOf('2026-09-28'), '2026-09-28'); // Monday
  assert.equal(weekOf('2026-10-03'), '2026-09-28'); // Saturday
});

test('milestone labels', () => {
  const td = MILESTONES.find((m) => m.key === 'td');
  assert.equal(milestoneLabel(td, 1), 'First TD');
  assert.equal(milestoneLabel(td, 100), '100th TD');
  assert.equal(milestoneLabel(MILESTONES.find((m) => m.key === 'rec'), 22), '22nd catch');
});

test('Player of the Week: best impact across the week, one per week', () => {
  const games = [
    game('g1', '2026-09-29', [ev('pass_td', 'qa', 'wa', 'A'), ev('pass_td', 'qa', 'wa', 'A')]),
    game('g2', '2026-10-01', [ev('rush_td', 'xb', null, 'B')]),
    game('g3', '2026-10-06', [ev('int', 'wb', 'qa', 'B'), ev('pick_six', 'wb', 'qa', 'B')]),
  ];
  const db = { settings: { season: '2026' }, players, games };
  const A = computeAwards(db, E.computeLeague(db));
  assert.equal(A.potw.length, 2);
  assert.equal(A.potw[0].id, 'wa');
  assert.deepEqual(A.potw[0].gameIds, ['g1', 'g2']);
  assert.equal(A.potw[1].id, 'wb');
  assert.ok(A.designs.wa.includes('fire'), 'POTW unlocks Heat Check');
  assert.ok(!A.designs.qb.includes('fire'));
});

test('season awards: leaders now, winners once the season is over, and they unlock designs', () => {
  const games = [
    game('g1', '2026-09-01', [ev('pass_td', 'qa', 'wa', 'A'), ev('drop', 'wb', 'qb', 'B'), ev('drop', 'wb', 'qb', 'B')]),
    game('g2', '2026-09-08', [ev('pass_td', 'qa', 'wa', 'A'), ev('drop', 'xb', 'qb', 'B')]),
  ];
  const now = { settings: { season: '2026' }, players, games };
  const A = computeAwards(now, E.computeLeague(now));
  assert.equal(A.seasons['2026'].done, false);
  assert.equal(A.seasons['2026'].butter.id, 'wb');
  assert.equal(A.seasons['2026'].mvp.id, 'wa');
  assert.ok(A.seasons['2026'].improved, 'someone improved');
  assert.equal(A.byPlayer.wb.awards.length, 0, 'not awarded until the season ends');

  const later = { ...now, settings: { season: '2027' } };
  const B = computeAwards(later, E.computeLeague(later));
  assert.equal(B.seasons['2026'].done, true);
  assert.deepEqual(B.byPlayer.wb.awards.map((a) => a.key), ['butter']);
  assert.ok(B.designs.wb.includes('butter'));
  assert.ok(B.designs.wa.includes('crown'));
});

test('career milestones are stamped with the game they happened in, up to the 100th TD', () => {
  const games = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    games.push(game(`g${i}`, d, [ev('rush_td', 'xa', null, 'A')]));
  }
  const db = { settings: { season: '2026' }, players, games };
  const A = computeAwards(db, E.computeLeague(db));
  const xa = A.byPlayer.xa.milestones.filter((m) => m.key === 'td');
  assert.deepEqual(xa.map((m) => m.label), ['First TD', '10th TD', '25th TD', '50th TD', '100th TD']);
  assert.equal(xa.at(-1).gameId, 'g99');
  assert.ok(A.byPlayer.qa.milestones.some((m) => m.label === '100th game'));
  assert.ok(A.designs.xa.includes('century') && A.designs.xa.includes('foil'));
});

test('cardDesign only honors unlocked picks', () => {
  const awards = { designs: { a: ['', 'fire'] } };
  assert.equal(cardDesign(awards, { id: 'a', cardStyle: 'fire' }), 'fire');
  assert.equal(cardDesign(awards, { id: 'a', cardStyle: 'century' }), '');
  assert.equal(DESIGNS[0].key, '');
});

test('recap: headline, goat, top plays, worst drop and roast; same recap every time', () => {
  const g = game('rc1', '2026-09-29', [
    ev('pass_td', 'qa', 'wa', 'A'), ev('sack', 'xb', 'qa', 'B'), ev('pick_six', 'wb', 'qa', 'B'),
    ev('drop', 'xa', 'qa', 'A'), ev('drop', 'xa', 'qa', 'A'), ev('pass_td', 'qa', 'wa', 'A'), ev('catch', 'qb', 'wb', 'B'),
  ]);
  const db = { settings: { season: '2026' }, players, games: [g] };
  const L = E.computeLeague(db);
  const name = (id) => id.toUpperCase();
  const r1 = buildRecap(g, L.games.rc1, { name });
  const r2 = buildRecap(g, L.games.rc1, { name });
  assert.deepEqual(r1, r2, 'deterministic');
  assert.deepEqual(r1.score, { A: 12, B: 6 });
  assert.ok(r1.headline.includes('Shirts'));
  assert.equal(r1.goat.id, 'wa');
  assert.equal(r1.topPlays[0].type, 'pick_six');
  assert.equal(r1.topPlays.length, 3);
  assert.equal(r1.worstDrop.id, 'xa');
  assert.equal(r1.worstDrop.n, 2);
  assert.ok(r1.roast.text.length > 10);
  const clean = buildRecap(game('rc2', '2026-09-29', [ev('rush_td', 'xa', null, 'A')]), L.games.rc1, { name });
  assert.ok(clean.headline);
});

test('recap uses the crowd MVP as the goat when there are votes', () => {
  const g = game('rc3', '2026-09-29', [ev('pass_td', 'qa', 'wa', 'A')], { mvpVotes: { wb: 'xb', qb: 'xb' } });
  const db = { settings: { season: '2026' }, players, games: [g] };
  const L = E.computeLeague(db);
  const r = buildRecap(g, L.games.rc3, { name: (id) => id });
  assert.equal(r.goat.id, 'xb');
  assert.equal(r.goat.crowd, true);
});
