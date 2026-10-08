import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardCrop, CARD_PHOTO_RATIO } from '../public/crop.js';

const ratio = (c) => c.w / c.h;
const inside = (c, W, H) => c.x >= 0 && c.y >= 0 && c.x + c.w <= W && c.y + c.h <= H;

test('crop: every shape comes out card-shaped and inside the photo', () => {
  for (const [W, H] of [[408, 549], [3024, 4032], [4032, 3024], [800, 458], [1000, 1000], [300, 2000]]) {
    const c = cardCrop(W, H);
    assert.ok(Math.abs(ratio(c) - CARD_PHOTO_RATIO) < 0.02, `${W}x${H}`);
    assert.ok(inside(c, W, H), `${W}x${H}`);
  }
  const tall = cardCrop(3024, 4032);
  assert.equal(tall.w, 3024);
  assert.ok(tall.y < (4032 - tall.h) / 2, 'tall photos keep the top part, where the head is');
});

test('crop: frames a detected face with headroom and shoulders', () => {
  const face = { x: 1400, y: 900, w: 500, h: 600 };
  const c = cardCrop(3024, 4032, { faces: [face] });
  assert.ok(inside(c, 3024, 4032));
  assert.ok(c.x <= face.x && c.x + c.w >= face.x + face.w, 'whole face across');
  assert.ok(c.y <= face.y && c.y + c.h >= face.y + face.h, 'whole face top to bottom');
  assert.ok(face.y - c.y < c.y + c.h - (face.y + face.h), 'more room below (shoulders) than above');
  // a face at the very edge still gives a valid crop
  assert.ok(inside(cardCrop(1000, 1400, { faces: [{ x: 0, y: 0, w: 300, h: 300 }] }), 1000, 1400));
  // two people: both faces fit
  const two = cardCrop(2000, 1500, { faces: [{ x: 300, y: 200, w: 250, h: 300 }, { x: 1300, y: 250, w: 250, h: 300 }] });
  assert.ok(two.x <= 300 && two.x + two.w >= 1550);
});
