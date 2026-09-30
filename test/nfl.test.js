import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nflComps, NFL_COMPS } from '../public/nfl.js';
import { ATTR_KEYS, POSITIONS } from '../public/engine.js';

const base = (o) => ({ ...Object.fromEntries(ATTR_KEYS.map((k) => [k, 70])), ...o });
const top = (a, meta) => nflComps(base(a), meta).comps.map((c) => c.name);

test('NFL comps: every profile is valid', () => {
  for (const c of NFL_COMPS) {
    assert.ok(POSITIONS.includes(c.pos), c.name);
    for (const [k, v] of Object.entries(c.a)) assert.ok(ATTR_KEYS.includes(k) && v >= 20 && v <= 99, `${c.name}.${k}`);
    assert.ok(c.ht >= 60 && c.ht <= 84 && c.wt >= 150 && c.wt <= 350, c.name);
  }
  assert.equal(new Set(NFL_COMPS.map((c) => c.name)).size, NFL_COMPS.length, 'no duplicates');
});

test('NFL comps: matches the style, not the level', () => {
  assert.equal(top({ spd: 90, acc: 88, rac: 86, jkm: 82, str: 55, thp: 50, tha: 50 }, { position: 'WR', heightIn: 69, weightLb: 165 })[0], 'Tyreek Hill');
  assert.ok(['Peyton Manning', 'Drew Brees', 'Tom Brady'].includes(top({ tha: 90, thp: 74, spd: 55, acc: 55, mcv: 50 }, { position: 'QB' })[0]));
  assert.ok(['Michael Vick', 'Lamar Jackson'].includes(top({ spd: 88, acc: 88, jkm: 86, tha: 76, thp: 78, mcv: 50, tak: 50 }, { position: 'QB' })[0]));
  assert.ok(['Marshawn Lynch', 'Derrick Henry'].includes(top({ str: 88, btk: 90, car: 86, spd: 72, cth: 55 }, { position: 'RB' })[0]));
  assert.ok(['Deion Sanders', 'Darrelle Revis', 'Jalen Ramsey'].includes(top({ mcv: 90, spd: 84, cod: 84, tak: 62, thp: 50 }, { position: 'DB' })[0]));
  // a low-rated guy with the same shape gets the same comp
  const low = Object.fromEntries(Object.entries(base({ spd: 90, acc: 88, rac: 86, jkm: 82, str: 55, thp: 50, tha: 50 })).map(([k, v]) => [k, v - 25]));
  assert.equal(nflComps(low, { position: 'WR' }).comps[0].name, 'Tyreek Hill');
});

test('NFL comps: shape, position and build all count', () => {
  const r = nflComps(base({ spd: 90, acc: 88 }), { position: 'WR' });
  assert.equal(r.comps.length, 3);
  for (const c of r.comps) assert.ok(c.match >= 50 && c.match <= 99);
  assert.deepEqual(r.comps[0].shared.sort(), ['acc', 'spd']);
  assert.ok(nflComps(base({}), { position: 'ATH' }).flat, 'all-70 players have no shape yet');
  // same shape, different build: a 6'6" 260 guy leans tight end
  const big = top({ str: 86, cth: 86, btk: 80 }, { position: 'WR', heightIn: 78, weightLb: 262 });
  assert.ok(big.slice(0, 2).includes('Rob Gronkowski'));
});
