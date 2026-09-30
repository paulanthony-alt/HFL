import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickerText, freshTouchdowns, prefersMp4, pickMimeType, fileTypeOf, recordingFileName, canvasSizeFor, coverRect, cameraErrorMessage, formatBytes } from '../public/cast.js';

const name = (id) => ({ don: 'Don', rob: 'Robert', ben: 'Ben' })[id] || id;
const ev = (type, p1, p2 = null, ts = '2026-10-03T18:00:00.000Z', id = Math.random().toString(36)) => ({ id, type, p1, p2, team: 'A', ts });

test('cast: last-play ticker', () => {
  assert.equal(tickerText(ev('pass_td', 'don', 'rob'), name), 'TD · Don → Robert');
  assert.equal(tickerText(ev('rush_td', 'don'), name), 'TD · Don run');
  assert.equal(tickerText(ev('pick_six', 'ben', 'don'), name), 'PICK SIX · Ben off Don');
  assert.equal(tickerText(ev('int', 'ben', 'don'), name), 'INT · Ben picks off Don');
  assert.equal(tickerText(ev('catch', 'don', 'rob'), name), 'Catch · Don → Robert');
  assert.equal(tickerText(ev('drop', 'rob'), name), 'Drop · Robert');
  assert.equal(tickerText(ev('incomplete', 'don'), name), 'Incomplete · Don');
  assert.equal(tickerText(ev('sack', 'ben', 'don'), name), 'Sack · Ben gets Don');
  assert.equal(tickerText({ type: 'safety', p1: 'x' }, name), '', 'old play types are skipped');
  assert.equal(tickerText(undefined, name), '');
});

test('cast: TD banner fires once per new touchdown, never for old ones', () => {
  const now = Date.parse('2026-10-03T18:10:00.000Z');
  const old = ev('pass_td', 'don', 'rob', '2026-10-03T18:00:00.000Z', 'old');
  const fresh = ev('rush_td', 'don', null, '2026-10-03T18:09:55.000Z', 'new');
  const catchEv = ev('catch', 'don', 'rob', '2026-10-03T18:09:58.000Z', 'c');
  let r = freshTouchdowns(new Set(), [old, fresh, catchEv], now);
  assert.deepEqual(r.fresh.map((e) => e.id), ['new'], 'old TD (10 min ago) and non-TDs are skipped');
  r = freshTouchdowns(r.seen, [old, fresh, catchEv], now + 1000);
  assert.equal(r.fresh.length, 0, 'same TD never fires twice');
  // a phone a few seconds off still counts it
  r = freshTouchdowns(r.seen, [ev('pick_six', 'ben', 'don', '2026-10-03T18:10:04.000Z', 'p6')], now);
  assert.equal(r.fresh.length, 1);
});

test('cast: recorder format — mp4 on iPhone, webm elsewhere', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
  const ipadDesktopMode = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
  const pixel = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };
  const iosChrome = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
  assert.ok(prefersMp4(iphone));
  assert.ok(prefersMp4(ipadDesktopMode));
  assert.ok(prefersMp4(iosChrome), 'every iPhone browser is Safari underneath');
  assert.ok(!prefersMp4(pixel));
  const safari = (t) => t.startsWith('video/mp4') || t === 'video/webm'; // Safari 18.4 does both
  const chrome = (t) => t.startsWith('video/webm') || t === 'video/mp4';
  assert.match(pickMimeType(safari, prefersMp4(iphone)), /^video\/mp4/);
  assert.match(pickMimeType(chrome, prefersMp4(pixel)), /^video\/webm;codecs=vp9/);
  assert.equal(pickMimeType(() => false, true), '');
  assert.equal(pickMimeType(() => { throw new Error('x'); }, false), '');
  assert.equal(fileTypeOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'video/mp4');
  assert.equal(fileTypeOf('video/webm;codecs=vp9,opus'), 'video/webm');
  assert.equal(recordingFileName(new Date(2026, 9, 3, 18, 5, 9), 'video/mp4'), 'hfl-2026-10-03-180509.mp4');
  assert.equal(recordingFileName(new Date(2026, 9, 3, 18, 5, 9), 'video/webm;codecs=vp8'), 'hfl-2026-10-03-180509.webm');
});

test('cast: output is always landscape and never stretched', () => {
  assert.deepEqual(canvasSizeFor(1920, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(canvasSizeFor(1080, 1920), { w: 1920, h: 1080 }, 'phone held upright still gives a landscape video');
  assert.deepEqual(canvasSizeFor(1280, 720), { w: 1280, h: 720 });
  assert.deepEqual(canvasSizeFor(640, 480), { w: 1280, h: 720 });
  const r = coverRect(1080, 1920, 1920, 1080); // portrait camera into landscape canvas
  assert.equal(Math.round(r.sw / r.sh * 1000), Math.round(1920 / 1080 * 1000));
  assert.ok(r.sx === 0 && r.sy > 0 && r.sy + r.sh <= 1920);
  const same = coverRect(1920, 1080, 1920, 1080);
  assert.deepEqual(same, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test('cast: every camera failure has a clear message', () => {
  for (const n of ['NotAllowedError', 'SecurityError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError', 'Unsupported', 'Weird']) {
    const m = cameraErrorMessage({ name: n, message: 'x' });
    assert.ok(m.title && m.text, n);
  }
  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }).title, /blocked/i);
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }).title, /no camera/i);
  assert.equal(formatBytes(52_400_000), '52 MB');
  assert.equal(formatBytes(1_500_000_000), '1.5 GB');
});
