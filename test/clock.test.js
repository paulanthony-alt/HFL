import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClock, clockElapsed, formatClock, quarterLabel, isRunning } from '../public/clock.js';
import { buildRoutes, matchRoute, emptyDb } from '../public/league.js';

const T0 = Date.parse('2026-10-03T18:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

test('clock: start, pause, resume keep one shared startedAt', () => {
  let c = applyClock(null, 'start', at(0));
  assert.deepEqual(c, { startedAt: at(0), pausedAt: null, quarter: 1 });
  assert.equal(clockElapsed(c, T0 + 90_000), 90_000);
  assert.ok(isRunning(c));
  c = applyClock(c, 'pause', at(100));
  assert.equal(clockElapsed(c, T0 + 500_000), 100_000, 'frozen while paused, whatever time it is');
  c = applyClock(c, 'resume', at(160)); // paused for 60s
  assert.equal(c.startedAt, at(60));
  assert.equal(c.pausedAt, null);
  assert.equal(clockElapsed(c, T0 + 170_000), 110_000);
});

test('clock: quarters, reset, off, and nonsense moves', () => {
  let c = applyClock(null, 'start', at(0));
  c = applyClock(c, 'next-quarter', at(600));
  assert.equal(c.quarter, 2);
  assert.equal(clockElapsed(c, T0 + 999_000), 0, 'new quarter waits at 0:00');
  assert.ok(!isRunning(c));
  c = applyClock(c, 'resume', at(700));
  assert.equal(clockElapsed(c, T0 + 730_000), 30_000);
  c = applyClock(c, 'reset', at(800));
  assert.equal(c.quarter, 2);
  assert.equal(clockElapsed(c, T0 + 900_000), 0);
  assert.equal(applyClock(c, 'off', at(900)), null);
  assert.throws(() => applyClock(null, 'pause', at(1)));
  assert.throws(() => applyClock(null, 'resume', at(1)));
  assert.throws(() => applyClock(applyClock(null, 'start', at(0)), 'start', at(1)), /already/);
  assert.throws(() => applyClock(applyClock(null, 'start', at(0)), 'resume', at(1)));
  assert.throws(() => applyClock(null, 'dance', at(1)));
});

test('clock: a phone whose clock is behind never shows negative time', () => {
  const c = applyClock(null, 'start', at(10));
  assert.equal(clockElapsed(c, T0), 0);
  assert.equal(clockElapsed(null, T0), 0);
});

test('clock: formatting', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(59_999), '0:59');
  assert.equal(formatClock(754_000), '12:34');
  assert.equal(formatClock(3_723_000), '1:02:03');
  assert.deepEqual([1, 4, 5, 6].map(quarterLabel), ['Q1', 'Q4', 'OT', '2OT']);
});

test('clock route: only live games, only game.clock changes', () => {
  const routes = buildRoutes();
  const call = (db, method, path, body = {}) => { const hit = matchRoute(routes, method, path); return hit.route.handler(db, body, hit.params, { images: [] }); };
  const db = emptyDb();
  db.players.push({ id: 'a', name: 'A', active: true }, { id: 'b', name: 'B', active: true });
  const g = { id: 'g1', date: '2026-10-03', season: '2026', status: 'scheduled', rsvps: {}, teams: { A: ['a'], B: ['b'] }, events: [], mvpVotes: {}, teamNames: { A: 'Shirts', B: 'Skins' } };
  db.games.push(g);
  assert.throws(() => call(db, 'POST', '/api/games/g1/clock', { action: 'start' }), /live game/);
  g.status = 'live';
  g.events.push({ id: 'e1', type: 'rush_td', p1: 'a', p2: null, team: 'A', ts: at(0), by: null });
  const before = JSON.stringify({ ...g, clock: undefined });
  call(db, 'POST', '/api/games/g1/clock', { action: 'start' });
  assert.ok(g.clock.startedAt && g.clock.pausedAt === null && g.clock.quarter === 1);
  assert.equal(JSON.stringify({ ...g, clock: undefined }), before, 'nothing else on the game moved');
  assert.throws(() => call(db, 'POST', '/api/games/g1/clock', { action: 'start' }), /already/);
  assert.throws(() => call(db, 'POST', '/api/games/g1/clock', { action: 'nope' }));
  call(db, 'POST', '/api/games/g1/clock', { action: 'off' });
  assert.equal('clock' in g, false, 'turning it off removes the field entirely');
});
