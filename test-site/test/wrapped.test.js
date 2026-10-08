import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/engine.js';
import { computeAwards } from '../public/awards.js';
import { buildWrapped, wrappedSeasons, seasonOver } from '../public/wrapped.js';

let n = 0;
const ev = (type, p1, p2 = null, team) => ({ id: `e${n++}`, type, p1, p2, team });
const players = ['qa', 'wa', 'xa', 'qb', 'wb', 'xb'].map((id) => ({ id, name: id.toUpperCase(), startOvr: 70 }));
const game = (id, date, events, season = '2026') => ({
  id, date, season, status: 'final', teams: { A: ['qa', 'wa', 'xa'], B: ['qb', 'wb', 'xb'] }, events, mvpVotes: {}, endedAt: `${date}T20:00:00.000Z`,
});

test('Wrapped: catches, favorite QB, nemesis and best play from the season', () => {
  const games = [
    game('g1', '2026-09-07', [ev('pass_td', 'qa', 'wa', 'A'), ev('catch', 'qa', 'wa', 'A'), ev('int', 'wb', 'qa', 'B')]),
    game('g2', '2026-09-14', [ev('catch', 'qa', 'wa', 'A'), ev('int', 'wb', 'qa', 'B'), ev('pick_six', 'wb', 'qa', 'B')]),
    game('g3', '2026-09-21', [ev('pass_td', 'qa', 'wa', 'A'), ev('pass_td', 'qa', 'wa', 'A'), ev('drop', 'wa', 'qa', 'A'), ev('drop', 'wa', 'qa', 'A')]),
    game('g0', '2025-06-01', [ev('rush_td', 'xb', null, 'B')], '2025'),
  ];
  const db = { settings: { season: '2026' }, players, games };
  const league = E.computeLeague(db);
  const awards = computeAwards(db, league);
  const w = buildWrapped(db, league, awards, 'wa', '2026', { name: (id) => id.toUpperCase() });
  const text = JSON.stringify(w.slides);
  assert.match(text, /You caught 5 passes/);
  assert.match(text, /Your favorite QB/);
  assert.equal(w.slides.find((s) => s.kicker === 'Your favorite QB').person, 'qa');
  assert.match(text, /Week \d/);
  assert.match(text, /2 drops/, 'the roast');
  assert.equal(w.slides.at(-1).kind, 'summary');
  assert.equal(w.over, false);

  const q = buildWrapped(db, league, awards, 'qa', '2026', { name: (id) => id.toUpperCase() });
  const nem = q.slides.find((s) => s.kicker === 'Your nemesis');
  assert.equal(nem.person, 'wb');
  assert.match(nem.line, /picked you off 3 times/);
  assert.equal(q.summary.nemesis, 'WB');

  assert.equal(buildWrapped(db, league, awards, 'qa', '2024'), null, 'no games that season');
  assert.deepEqual(wrappedSeasons(db), ['2025', '2026']);
  assert.ok(seasonOver(db, '2025'));
});
