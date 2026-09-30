import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { winProbAt, winProbSeries, biggestSwing, clutchPlays, clutchTable, formOf } from '../public/insights.js';

let n = 0;
const ev = (type, p1, p2 = null, team) => ({ id: `e${n++}`, type, p1, p2, team });
const players = ['qa', 'wa', 'xa', 'qb', 'wb', 'xb'].map((id) => ({ id, name: id.toUpperCase(), startOvr: 70 }));
const game = (id, date, events, over = {}) => ({
  id, date, season: '2026', status: 'final', teams: { A: ['qa', 'wa', 'xa'], B: ['qb', 'wb', 'xb'] },
  events, mvpVotes: {}, endedAt: `${date}T20:00:00.000Z`, ...over,
});
const filler = (k) => Array.from({ length: k }, () => ev('incomplete', 'qa', 'wa', 'A'));

test('win probability: starts at the pre-game odds, leads matter more late', () => {
  assert.equal(Math.round(winProbAt(0.6, 0, 0) * 100), 60);
  assert.ok(winProbAt(0.5, 6, 0.9) > winProbAt(0.5, 6, 0.2), 'same lead is worth more late');
  assert.ok(winProbAt(0.5, -12, 0.5) < 0.2);
  assert.ok(winProbAt(0.9, 0, 0.97) < 0.7, 'late tie is close to a coin flip');
});

test('win probability series ends at the result and the biggest swing is found', () => {
  const g = game('g1', '2026-09-01', [...filler(8), ev('pass_td', 'qa', 'wa', 'A'), ...filler(8), ev('pick_six', 'wb', 'qa', 'B'), ev('rush_td', 'xb', null, 'B')]);
  const s = winProbSeries(g, { winProbA: 0.5 });
  assert.equal(s.length, g.events.length + 1);
  assert.equal(s[0].wp, 0.5);
  assert.equal(s[s.length - 1].wp, 0);
  const sw = biggestSwing(s);
  assert.ok(sw.delta < 0, 'swing went to team B');
  assert.ok(['pick_six', 'rush_td'].includes(sw.ev.type));
  // live games leave room for the plays still to come
  const live = winProbSeries({ ...g, status: 'live' }, { winProbA: 0.5 }, { expected: 40 });
  assert.ok(live[live.length - 1].t < 1 && live[live.length - 1].wp > 0);
});

test('clutch: only close and late plays count', () => {
  const early = ev('pass_td', 'qa', 'wa', 'A');
  const lateClose = ev('int', 'wb', 'qa', 'B');
  const g = game('g1', '2026-09-01', [early, ...filler(10), lateClose, ev('rush_td', 'xa', null, 'A')]);
  const plays = clutchPlays(g);
  assert.ok(!plays.some((p) => p.ev === early), 'early TD is not clutch');
  assert.deepEqual(plays.filter((p) => p.ev === lateClose).map((p) => [p.id, p.pts]), [['wb', 3], ['qa', -3]]);
  assert.ok(plays.some((p) => p.id === 'xa' && p.pts === 3), 'late go-ahead TD in a one-score game');
  // a blowout isn't clutch
  const blowout = game('g2', '2026-09-02', [...Array.from({ length: 3 }, () => ev('rush_td', 'xa', null, 'A')), ...filler(8), ev('rush_td', 'xa', null, 'A')]);
  assert.equal(clutchPlays(blowout).length, 0);
  const t = clutchTable({ games: [g, blowout] });
  assert.equal(t.wb.score, 3);
  assert.equal(t.qa.chokes, 1);
});

test('form: 🔥 after TDs in 3 straight games, ❄️ after a cold stretch', () => {
  const games = [
    game('g1', '2026-09-01', [ev('rush_td', 'xa', null, 'A'), ev('drop', 'wb', 'qb', 'B')]),
    game('g2', '2026-09-02', [ev('rush_td', 'xa', null, 'A'), ev('pass_td', 'qa', 'wa', 'A'), ev('int', 'wa', 'qb', 'A'), ev('drop', 'wb', 'qb', 'B')]),
    game('g3', '2026-09-03', [ev('rush_td', 'xa', null, 'A'), ev('pass_td', 'qa', 'wa', 'A'), ev('drop', 'wb', 'qb', 'B')]),
  ];
  const db = { settings: { season: '2026' }, players, games };
  const f = formOf(db, E.computeLeague(db));
  assert.equal(f.xa.hot, 3, 'TD in 3 straight games');
  assert.equal(f.qa.hot, 0, 'only 2 straight');
  assert.equal(f.wb.cold, 3, 'a drop in 3 straight games, no TDs');
  assert.equal(f.qb.cold, 0, "his receiver's drop isn't on him, and his pick was 2 games ago");
  // one TD ends a cold streak
  games.push(game('g4', '2026-09-04', [ev('pass_td', 'qb', 'wb', 'B')]));
  assert.equal(formOf(db, E.computeLeague(db)).wb.cold, 0);
});

test('scouting: picks 2–3 strengths and weaknesses from the ratings', async () => {
  const { teamScouting } = await import('../public/insights.js');
  const base = { spd: 70, acc: 70, cth: 70, rte: 70, rls: 70, thp: 70, tha: 70, str: 70, mcv: 70, tak: 70, sta: 70, bcv: 70, btk: 70, cod: 70, jkm: 70, car: 70 };
  const R = {
    a1: { ...base, spd: 95, acc: 94, cth: 55 }, a2: { ...base, spd: 92, acc: 90, cth: 58, mcv: 90 },
    b1: { ...base, cth: 92, tak: 50, str: 55 }, b2: { ...base, cth: 90, tha: 92, thp: 90, tak: 52 },
  };
  const at = (id) => R[id];
  const A = teamScouting(['a1', 'a2'], ['b1', 'b2'], Object.keys(R), at);
  const B = teamScouting(['b1', 'b2'], ['a1', 'a2'], Object.keys(R), at);
  for (const r of [A, B]) {
    assert.ok(r.strengths.length >= 2 && r.strengths.length <= 3);
    assert.ok(r.weaknesses.length >= 2 && r.weaknesses.length <= 3);
    assert.ok(!r.strengths.some((x) => r.weaknesses.some((y) => y.key === x.key)), 'never both');
  }
  assert.equal(A.strengths[0].key, 'speed');
  assert.ok(A.weaknesses.some((x) => x.key === 'hands'));
  assert.ok(B.strengths.some((x) => x.key === 'hands'));
  assert.ok(B.weaknesses.some((x) => x.key === 'rush'));
});
