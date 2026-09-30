import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, matchRoute, emptyDb } from '../public/league.js';
import * as E from '../public/engine.js';

const routes = buildRoutes();
const H = (c) => c.repeat(64);
function setup() {
  const db = emptyDb();
  db.players.push(
    { id: 'paul', name: 'Paul', active: true, pinHash: H('a') },
    { id: 'max', name: 'Max', active: true, pinHash: H('b') },
    { id: 'liam', name: 'Liam', active: true, pinHash: H('c') },
  );
  return db;
}
const as = (id, c) => ({ _auth: { as: id, pinHash: H(c) } });
const call = (db, method, path, body = {}) => { const hit = matchRoute(routes, method, path); return hit.route.handler(db, body, hit.params, { images: [] }); };

test('rules: admins add, edit, reorder and delete; everyone else is locked out', () => {
  const db = setup();
  assert.throws(() => call(db, 'POST', '/api/rules', { title: 'No blitzing', ...as('liam', 'c') }), /locked/);
  assert.throws(() => call(db, 'POST', '/api/rules', { title: 'No PIN' }), /locked/);
  const a = call(db, 'POST', '/api/rules', { title: 'Two-hand touch', text: 'Below the waist doesn\'t count.', ...as('paul', 'a') });
  const b = call(db, 'POST', '/api/rules', { title: 'Five-second rush', ...as('max', 'b') });
  assert.deepEqual(db.settings.rules.map((r) => r.title), ['Two-hand touch', 'Five-second rush']);
  assert.throws(() => call(db, 'POST', '/api/rules', { title: '', ...as('paul', 'a') }), /required/);
  call(db, 'PATCH', `/api/rules/${b.id}`, { text: 'Count it out loud: 1 Mississippi...', ...as('paul', 'a') });
  assert.equal(db.settings.rules[1].title, 'Five-second rush', 'editing the text keeps the title');
  assert.match(db.settings.rules[1].text, /Mississippi/);
  call(db, 'POST', `/api/rules/${b.id}/move`, { dir: -1, ...as('paul', 'a') });
  assert.deepEqual(db.settings.rules.map((r) => r.id), [b.id, a.id]);
  call(db, 'POST', `/api/rules/${b.id}/move`, { dir: -1, ...as('paul', 'a') });
  assert.deepEqual(db.settings.rules.map((r) => r.id), [b.id, a.id], 'already first: stays put');
  assert.throws(() => call(db, 'DELETE', `/api/rules/${a.id}`, as('liam', 'c')), /locked/);
  call(db, 'DELETE', `/api/rules/${a.id}`, as('paul', 'a'));
  assert.equal(db.settings.rules.length, 1);
  assert.throws(() => call(db, 'PATCH', '/api/rules/nope', { title: 'x', ...as('paul', 'a') }), /not found/);
});

test('height and weight: admins set them (ratings or profile), players cannot', () => {
  const db = setup();
  call(db, 'POST', '/api/ratings', { ratings: { liam: { heightIn: 73, weightLb: 185 } }, ...as('max', 'b') });
  const liam = db.players.find((p) => p.id === 'liam');
  assert.equal(liam.heightIn, 73);
  assert.equal(liam.weightLb, 185);
  assert.equal(liam.ratingEdits, undefined, 'height/weight alone is not a rating edit');
  assert.throws(() => call(db, 'PATCH', '/api/players/liam', { heightIn: 90, ...as('liam', 'c') }), /locked/);
  call(db, 'PATCH', '/api/players/liam', { heightIn: '', weightLb: 190, ...as('paul', 'a') });
  const after = db.players.find((p) => p.id === 'liam');
  assert.equal(after.heightIn, null, 'empty clears it');
  assert.equal(after.weightLb, 190);
  assert.throws(() => call(db, 'PATCH', '/api/players/liam', { heightIn: 30, ...as('paul', 'a') }), /height/);
  assert.throws(() => call(db, 'POST', '/api/ratings', { ratings: { liam: { weightLb: 900 } }, ...as('paul', 'a') }), /weight/);
});

test('run after catch: a rating that grows with catches and receiving TDs', () => {
  assert.ok(E.ATTR_KEYS.includes('rac'));
  const s = { ...E.blankStats(), rec: 4, recTD: 1, targets: 4 };
  assert.ok(E.progression(s, 0.5, 0.5).rac > 0.5);
  assert.ok(E.keyAttrs('WR', 6).includes('rac'));
});
