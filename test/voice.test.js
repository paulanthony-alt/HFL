import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlay, findPlayers } from '../public/voice.js';

const roster = [
  { id: 'kel', names: ['Kellen Smith', 'Kellen', 'K-Train'], team: 'A' },
  { id: 'max', names: ['Max', ''], team: 'A' },
  { id: 'hen', names: ['Henry'], team: 'A' },
  { id: 'dan', names: ['Dane'], team: 'A' },
  { id: 'ben', names: ['Ben'], team: 'B' },
  { id: 'bod', names: ['Boden'], team: 'B' },
  { id: 'luc', names: ['Lucas'], team: 'B' },
  { id: 'don', names: ['Don'], team: 'B' },
  { id: 'rob', names: ['Robert', 'Bobby'], team: 'B' },
];
const P = (text) => parsePlay(text, roster);

test('voice: passes and touchdowns', () => {
  assert.deepEqual(P('Don to Robert, touchdown'), { type: 'pass_td', p1: 'don', p2: 'rob' });
  assert.deepEqual(P('Kellen to Max touchdown!'), { type: 'pass_td', p1: 'kel', p2: 'max' });
  assert.deepEqual(P('K-Train finds Henry for six'), { type: 'pass_td', p1: 'kel', p2: 'hen' });
  assert.deepEqual(P('Max catch from Kellen'), { type: 'catch', p1: 'kel', p2: 'max' });
  assert.deepEqual(P('kellen to max'), { type: 'catch', p1: 'kel', p2: 'max' });
  assert.deepEqual(P('Lucas touchdown run'), { type: 'rush_td', p1: 'luc', p2: null });
  assert.deepEqual(P('Lucus runs it in for a TD'), { type: 'rush_td', p1: 'luc', p2: null }, 'close-enough spelling');
  assert.deepEqual(P('Kellen incomplete to Henry'), { type: 'incomplete', p1: 'kel', p2: 'hen' });
});

test('voice: defense, drops and mistakes', () => {
  assert.deepEqual(P('Boden picks off Kellen'), { type: 'int', p1: 'bod', p2: 'kel' });
  assert.deepEqual(P('Kellen to Max, intercepted by Boden'), { type: 'int', p1: 'bod', p2: 'kel' });
  assert.deepEqual(P('Pick six! Max off Ben'), { type: 'pick_six', p1: 'max', p2: 'ben' });
  assert.deepEqual(P('Ben sacks Kellen'), { type: 'sack', p1: 'ben', p2: 'kel' });
  assert.deepEqual(P('Kellen sacked by Ben'), { type: 'sack', p1: 'ben', p2: 'kel' });
  assert.deepEqual(P('Dane dropped it'), { type: 'drop', p1: 'dan', p2: null });
  assert.deepEqual(P('Kellen to Dane, dropped'), { type: 'drop', p1: 'dan', p2: 'kel' });
  assert.ok(P('Kellen got sacked').error, 'needs the defender');
  assert.ok(P('Kellen to Ben touchdown').error, 'different teams');
  assert.ok(P('touchdown').error, 'needs names');
  assert.ok(P('what a game').error);
});

test('voice: names inside other words are not players', () => {
  assert.deepEqual(findPlayers('to the house', roster).mentions, []);
  assert.equal(findPlayers('bobby to don', roster).mentions.map((m) => m.id).join(), 'rob,don');
});
