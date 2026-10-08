// AR Scoreboard ("Cast / Film"): a phone on a tripod films the game and burns the live
// scoreboard into the picture. It never logs plays; it only reads the same live game data
// the tracker writes. Videos stay on the phone (they're never uploaded anywhere).
//
// The top half is pure helpers (tested in test/cast.test.js); CastView below drives the
// camera, the canvas, the recorder and the wake lock.
import { EVENT_TYPES } from './engine.js';
import { clockElapsed, formatClock, quarterLabel, isRunning } from './clock.js';

export const TD_TYPES = ['pass_td', 'rush_td', 'pick_six'];
export const isTouchdown = (ev) => TD_TYPES.includes(ev?.type);
export const BANNER_MS = 2000;
export const MAX_RECORDING_MS = 10 * 60 * 1000; // phones hold the whole video in memory
export const TEAM_COLORS = { A: '#ff5a1f', B: '#36c8ff' };

// "TD · Don → Robert"
export function tickerText(ev, name) {
  if (!ev || !EVENT_TYPES[ev.type]) return '';
  const a = ev.p1 ? name(ev.p1) : '';
  const b = ev.p2 ? name(ev.p2) : '';
  const pair = (x, y) => (y ? `${x} → ${y}` : x);
  switch (ev.type) {
    case 'pass_td': return `TD · ${pair(a, b)}`;
    case 'rush_td': return `TD · ${a} run`;
    case 'pick_six': return `PICK SIX · ${a}${b ? ` off ${b}` : ''}`;
    case 'catch': return `Catch · ${pair(a, b)}`;
    case 'incomplete': return `Incomplete · ${pair(a, b)}`;
    case 'drop': return `Drop · ${a}`;
    case 'int': return `INT · ${a}${b ? ` picks off ${b}` : ''}`;
    case 'sack': return `Sack · ${a}${b ? ` gets ${b}` : ''}`;
    default: return `${EVENT_TYPES[ev.type].label} · ${a}`;
  }
}

// TDs among `events` not in `seen`, logged within `maxAgeMs` of now (so a phone that
// reconnects after a long drop doesn't replay a backlog of banners; generous enough that
// two phones' clocks being a little apart never matters). Returns them oldest first plus the updated seen set.
export function freshTouchdowns(seen, events, now, maxAgeMs = 60000) {
  const next = new Set(seen);
  const fresh = [];
  for (const ev of events || []) {
    if (next.has(ev.id)) continue;
    next.add(ev.id);
    const t = Date.parse(ev.ts);
    if (isTouchdown(ev) && (!Number.isFinite(t) || Math.abs(now - t) <= maxAgeMs)) fresh.push(ev);
  }
  return { fresh, seen: next };
}

// iPhone/iPad (and Mac Safari) save mp4 to Photos; everything else records webm.
export function prefersMp4({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const safari = /Safari\//.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/.test(userAgent);
  return ios || safari;
}

const MP4 = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4'];
const WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
// The first container the recorder supports, mp4 first on Apple devices, webm first
// elsewhere. '' means the recorder can't record video at all.
export function pickMimeType(isSupported, mp4First) {
  for (const t of mp4First ? [...MP4, ...WEBM] : [...WEBM, ...MP4]) {
    try { if (isSupported(t)) return t; } catch { /* keep looking */ }
  }
  return '';
}
export const fileTypeOf = (mime) => (mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm');
export function recordingFileName(date, mime) {
  const p = (n) => String(n).padStart(2, '0');
  return `hfl-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${fileTypeOf(mime) === 'video/mp4' ? 'mp4' : 'webm'}`;
}

// Output size: always landscape, 1080p when the camera gives us that much.
export function canvasSizeFor(videoW, videoH) {
  return Math.max(videoW, videoH) >= 1920 && Math.min(videoW, videoH) >= 1080 ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
}
// Crop the camera frame to fill the canvas without stretching.
export function coverRect(sw, sh, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  const w = dw / s, h = dh / s;
  return { sx: (sw - w) / 2, sy: (sh - h) / 2, sw: w, sh: h };
}

// Camera/mic errors → what to tell the person holding the phone.
export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { title: 'Camera is blocked', text: 'Allow camera access for this site: on iPhone, Settings → Safari → Camera → Allow (or tap “aA” in the address bar → Website Settings). On Android, tap the lock icon next to the address → Permissions → Camera. Then tap Try again.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', text: 'This device has no camera the app can use. Open Cast on a phone.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { title: 'Camera is busy', text: 'Another app (or another tab) is using the camera. Close it and tap Try again.' };
    case 'Unsupported':
      return { title: 'Camera not available here', text: 'This browser can’t use the camera. Open the app in Safari on iPhone or Chrome on Android (it has to be the https link).' };
    default:
      return { title: 'Camera didn’t start', text: `${err?.message || 'Something went wrong'}. Tap Try again.` };
  }
}

export const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(n / 1e6))} MB`);

// ---------------------------------------------------------------------------
// Drawing (canvas, in 1920×1080 units scaled to the real canvas)

const DISPLAY = '"Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
const LABEL = '"Barlow Condensed", "Arial Narrow", sans-serif';

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function fitText(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawOverlay(c, W, H, st, now) {
  const k = W / 1920;
  c.save();
  c.scale(k, k);
  const w = 1920, h = 1080, m = 44;
  c.textBaseline = 'middle';

  // --- bottom-left scoreboard
  const bw = 600, rowH = 78, headH = 40;
  const bx = m, by = h - m - headH - rowH * 2;
  c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 24;
  c.fillStyle = 'rgba(8,10,14,0.86)'; rr(c, bx, by, bw, headH + rowH * 2, 14); c.fill();
  c.shadowBlur = 0;
  // header strip
  c.save(); rr(c, bx, by, bw, headH + rowH * 2, 14); c.clip();
  const g = c.createLinearGradient(bx, 0, bx + bw, 0); g.addColorStop(0, '#ff5a1f'); g.addColorStop(1, '#ff8b2b');
  c.fillStyle = g; c.fillRect(bx, by, bw, headH);
  c.fillStyle = '#0b0b0b'; c.font = `900 30px ${DISPLAY}`; c.textAlign = 'left';
  c.fillText('HFL', bx + 18, by + headH / 2 + 1);
  c.font = `700 22px ${LABEL}`; c.textAlign = 'right';
  c.fillText(st.status === 'final' ? 'FINAL' : st.status === 'live' ? '● LIVE' : 'PREGAME', bx + bw - 16, by + headH / 2 + 1);
  for (const [i, side] of ['A', 'B'].entries()) {
    const y = by + headH + rowH * i;
    if (i) { c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(bx, y, bw, 2); }
    c.fillStyle = TEAM_COLORS[side]; c.fillRect(bx, y, 12, rowH);
    const lead = st.status === 'final' && st.score[side] > st.score[side === 'A' ? 'B' : 'A'];
    c.fillStyle = '#f5f2ea'; c.font = `700 44px ${LABEL}`; c.textAlign = 'left';
    c.fillText(fitText(c, String(st.teams[side] || '').toUpperCase(), bw - 200), bx + 34, y + rowH / 2 + 2);
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(bx + bw - 132, y, 132, rowH);
    c.fillStyle = lead ? '#ffc53d' : '#ffffff'; c.font = `900 66px ${DISPLAY}`; c.textAlign = 'center';
    c.fillText(String(st.score[side] ?? 0), bx + bw - 66, y + rowH / 2 + 4);
  }
  c.restore();

  // --- last-play ticker, to the right of the scoreboard
  if (st.ticker) {
    const tx = bx + bw + 20, th = 64, ty = h - m - th, tw = Math.min(w - m - tx, 900);
    c.fillStyle = 'rgba(8,10,14,0.82)'; rr(c, tx, ty, tw, th, 12); c.fill();
    c.fillStyle = '#ffc53d'; rr(c, tx, ty, 150, th, 12); c.fill(); c.fillRect(tx + 138, ty, 12, th);
    c.fillStyle = '#0b0b0b'; c.font = `700 24px ${LABEL}`; c.textAlign = 'center';
    c.fillText('LAST PLAY', tx + 75, ty + th / 2 + 1);
    c.fillStyle = '#f5f2ea'; c.font = `700 36px ${LABEL}`; c.textAlign = 'left';
    c.fillText(fitText(c, st.ticker.toUpperCase(), tw - 190), tx + 172, ty + th / 2 + 2);
  }

  // --- top-right quarter + clock (hidden when there's no clock)
  if (st.clock) {
    const text = formatClock(clockElapsed(st.clock, now));
    const q = quarterLabel(st.clock.quarter || 1);
    const paused = !isRunning(st.clock);
    c.font = `900 76px ${DISPLAY}`;
    const tw = Math.max(170, c.measureText(text).width + 40);
    const cw = 96 + tw, ch = 96, cx = w - m - cw, cy = m;
    c.fillStyle = 'rgba(8,10,14,0.86)'; rr(c, cx, cy, cw, ch, 14); c.fill();
    c.fillStyle = '#ffc53d'; rr(c, cx, cy, 96, ch, 14); c.fill(); c.fillRect(cx + 84, cy, 12, ch);
    c.fillStyle = '#0b0b0b'; c.font = `900 44px ${DISPLAY}`; c.textAlign = 'center';
    c.fillText(q, cx + 48, cy + ch / 2 + 3);
    c.fillStyle = paused ? 'rgba(255,255,255,0.6)' : '#ffffff'; c.font = `900 76px ${DISPLAY}`;
    c.fillText(text, cx + 96 + tw / 2, cy + ch / 2 + 5);
    if (paused) { c.fillStyle = '#ffc53d'; c.font = `700 20px ${LABEL}`; c.fillText('PAUSED', cx + 96 + tw / 2, cy + ch + 18); }
  }

  // --- touchdown banner
  const b = st.banner;
  if (b && now - b.at < BANNER_MS) {
    const t = (now - b.at) / BANNER_MS;
    const inT = Math.min(1, t / 0.12), outT = t > 0.85 ? (1 - t) / 0.15 : 1;
    const ease = 1 - Math.pow(1 - inT, 3);
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, outT));
    c.translate(w / 2, h / 2 - 60);
    c.scale(0.7 + 0.3 * ease, 0.7 + 0.3 * ease);
    c.rotate(-0.05);
    const bandW = 1500 * ease, bandH = 300;
    const grad = c.createLinearGradient(-bandW / 2, 0, bandW / 2, 0);
    grad.addColorStop(0, `${b.color}00`); grad.addColorStop(0.12, b.color); grad.addColorStop(0.88, b.color); grad.addColorStop(1, `${b.color}00`);
    c.fillStyle = grad; c.fillRect(-bandW / 2, -bandH / 2, bandW, bandH);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(-bandW / 2, bandH / 2 - 70, bandW, 70);
    c.rotate(0.05);
    c.textAlign = 'center';
    c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 20;
    c.fillStyle = '#ffffff'; c.font = `900 190px ${DISPLAY}`;
    c.fillText(b.title, 0, -22);
    c.shadowBlur = 0;
    c.font = `700 46px ${LABEL}`; c.fillStyle = '#fff8e6';
    c.fillText(fitText(c, b.sub.toUpperCase(), 1300), 0, 112);
    c.restore();
  }
  c.restore();
}

// ---------------------------------------------------------------------------
// The screen

const html = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export class CastView {
  // getState() → { found, status, teams: {A,B}, score: {A,B}, events, clock, gameId }
  // name(id) → display name. live() → { ok, message }.
  constructor(root, { getState, name, live, exitHref = '#/' }) {
    Object.assign(this, { root, getState, name, live, exitHref });
    this.seen = null;
    this.banners = [];
    this.recorder = null;
    this.chunks = [];
    this.bytes = 0;
    this.stopped = false;
    this.root.innerHTML = `
      <div class="cast" role="application" aria-label="Cast scoreboard camera">
        <video class="cast-video" playsinline muted autoplay></video>
        <canvas class="cast-canvas"></canvas>
        <div class="cast-top">
          <a class="cast-btn cast-exit" href="${html(exitHref)}" aria-label="Close camera">✕</a>
          <div class="cast-pills"></div>
        </div>
        <div class="cast-side">
          <button class="cast-rec" type="button" aria-label="Start recording" disabled><i></i></button>
          <div class="cast-rec-time" aria-live="polite"></div>
        </div>
        <div class="cast-msg" hidden></div>
        <div class="cast-rotate" hidden><div>↻</div><b>Turn your phone sideways</b><span>The camera films in landscape.</span></div>
      </div>`;
    this.el = {
      cast: root.querySelector('.cast'), video: root.querySelector('.cast-video'), canvas: root.querySelector('.cast-canvas'),
      pills: root.querySelector('.cast-pills'), rec: root.querySelector('.cast-rec'), recTime: root.querySelector('.cast-rec-time'),
      msg: root.querySelector('.cast-msg'), rotate: root.querySelector('.cast-rotate'), exit: root.querySelector('.cast-exit'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    this.size = { w: 1280, h: 720 };
    this.el.canvas.width = this.size.w; this.el.canvas.height = this.size.h;
    this.el.rec.addEventListener('click', () => (this.recorder ? this.stopRecording() : this.startRecording()));
    this.el.exit.addEventListener('click', (e) => {
      if (this.recorder && !confirm('Stop recording and leave? You can still save the video.')) e.preventDefault();
    });
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') { this.lockScreen(); if (!this.camOk()) this.startCamera(); }
      else if (this.recorder) this.stopRecording('The app went to the background, so recording stopped. Your video is below.');
    };
    this.onResize = () => this.checkOrientation();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    document.body.classList.add('casting');
    this.checkOrientation();
    this.update();
    this.lockScreen();
    this.startCamera();
    const loop = () => { if (this.stopped) return; this.draw(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    // fonts for the overlay (self-hosted; usually already loaded by the app)
    Promise.all([`900 80px "Big Shoulders Display"`, `700 40px "Barlow Condensed"`].map((f) => document.fonts?.load(f))).catch(() => {});
  }

  camOk() { return this.stream?.getVideoTracks().some((t) => t.readyState === 'live'); }

  async startCamera() {
    this.showMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) { this.cameraFailed({ name: 'Unsupported' }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
      if (this.stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => { if (!this.stopped) this.cameraFailed({ name: 'NotReadableError' }); });
      this.el.video.srcObject = stream;
      await this.el.video.play().catch(() => {});
      const s = track.getSettings?.() || {};
      // Fix the output size once, so a recording never changes size midway.
      if (!this.sized) {
        const vw = s.width || this.el.video.videoWidth || 1280, vh = s.height || this.el.video.videoHeight || 720;
        this.size = canvasSizeFor(vw, vh);
        this.el.canvas.width = this.size.w; this.el.canvas.height = this.size.h;
        this.sized = true;
      }
      this.el.rec.disabled = !window.MediaRecorder || !this.el.canvas.captureStream;
      if (this.el.rec.disabled) this.pill('rec', 'warn', 'This browser can show the scoreboard but can’t record video');
      else this.pill('rec', null);
    } catch (err) {
      this.cameraFailed(err);
    }
  }

  cameraFailed(err) {
    const m = cameraErrorMessage(err);
    this.el.rec.disabled = true;
    if (this.recorder) this.stopRecording('The camera stopped, so recording stopped. Your video is below.');
    this.showMessage(`<b>${html(m.title)}</b><span>${html(m.text)}</span><button type="button" class="cast-btn wide" data-cast="retry">Try again</button>`);
    this.el.msg.querySelector('[data-cast=retry]')?.addEventListener('click', () => this.startCamera());
  }

  showMessage(inner) {
    this.el.msg.hidden = !inner;
    this.el.msg.innerHTML = inner || '';
  }

  pill(key, kind, text) {
    let p = this.el.pills.querySelector(`[data-pill="${key}"]`);
    if (!kind) { p?.remove(); return; }
    if (!p) { p = document.createElement('div'); p.dataset.pill = key; this.el.pills.append(p); }
    p.className = `cast-pill ${kind}`;
    p.textContent = text;
  }

  checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    this.el.rotate.hidden = !portrait || !!this.recorder;
  }

  async lockScreen() {
    if (!('wakeLock' in navigator)) { this.pill('wake', 'warn', 'Screen may lock: turn off Auto-Lock while filming'); return; }
    if (this.wake && !this.wake.released) return;
    try {
      this.wake = await navigator.wakeLock.request('screen');
      this.pill('wake', null);
      this.wake.addEventListener('release', () => { if (!this.stopped && document.visibilityState === 'visible') this.pill('wake', 'warn', 'Screen may lock: turn off Auto-Lock while filming'); });
    } catch {
      this.pill('wake', 'warn', 'Screen may lock: turn off Auto-Lock while filming');
    }
  }

  // New data from the live game (called whenever the league changes).
  update() {
    const st = this.getState();
    this.state = st;
    const conn = this.live();
    this.pill('conn', conn.ok ? null : 'bad', conn.message || 'Connection lost. The score may be behind');
    if (!st.found) this.pill('game', 'warn', 'No live game yet. Start one on the logger phone');
    else if (st.status === 'scheduled') this.pill('game', 'warn', 'Waiting for kickoff');
    else this.pill('game', null);
    const events = st.events || [];
    if (!this.seen || this.seenGame !== st.gameId) {
      this.seen = new Set(events.map((e) => e.id)); // don't replay what happened before we opened
      this.seenGame = st.gameId;
    } else {
      const { fresh, seen } = freshTouchdowns(this.seen, events, Date.now());
      this.seen = seen;
      for (const ev of fresh) {
        const side = ev.team || 'A';
        this.banners.push({
          title: ev.type === 'pick_six' ? 'PICK SIX' : 'TOUCHDOWN', color: TEAM_COLORS[side],
          sub: `${ev.type === 'pass_td' ? `${this.name(ev.p1)} → ${this.name(ev.p2)}` : this.name(ev.p1)} · ${st.teams.A} ${st.score.A} – ${st.score.B} ${st.teams.B}`,
        });
      }
    }
  }

  draw() {
    const { w, h } = this.size;
    const c = this.ctx;
    const v = this.el.video;
    const now = Date.now();
    if (v.readyState >= 2 && v.videoWidth) {
      const r = coverRect(v.videoWidth, v.videoHeight, w, h);
      c.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    } else {
      c.fillStyle = '#07090c'; c.fillRect(0, 0, w, h);
    }
    // one banner at a time; start the next when the current one ends
    if (this.banners.length && (!this.banner || now - this.banner.at >= BANNER_MS)) this.banner = { ...this.banners.shift(), at: now };
    const st = this.state || {};
    if (st.found) {
      const last = (st.events || []).at(-1);
      drawOverlay(c, w, h, {
        status: st.status, teams: st.teams, score: st.score, clock: st.status === 'live' ? st.clock : null,
        ticker: last ? tickerText(last, this.name) : '', banner: this.banner,
      }, now);
    }
    if (this.recorder) {
      const ms = now - this.recStart;
      this.el.recTime.textContent = `${formatClock(ms)} · ${formatBytes(this.bytes)}`;
      if (ms >= MAX_RECORDING_MS) this.stopRecording(`Recordings stop at ${MAX_RECORDING_MS / 60000} minutes so the phone doesn’t run out of memory. Your video is below; tap REC to keep filming.`);
    }
  }

  async startRecording() {
    if (this.recorder || !this.camOk()) return;
    const mime = pickMimeType((t) => MediaRecorder.isTypeSupported(t), prefersMp4(navigator));
    if (!mime) { this.pill('rec', 'warn', 'This browser can’t record video'); return; }
    this.el.rec.disabled = true;
    // Microphone only while recording. If it's blocked, record without sound.
    let mic = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false });
      this.pill('mic', null);
    } catch {
      this.pill('mic', 'warn', 'Microphone blocked: recording without sound');
    }
    if (!this.camOk()) await this.startCamera(); // some phones drop the camera when the mic starts
    const out = this.el.canvas.captureStream(30);
    for (const t of mic?.getAudioTracks() || []) out.addTrack(t);
    let rec;
    try {
      rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: this.size.w >= 1920 ? 6_000_000 : 3_500_000, audioBitsPerSecond: 128_000 });
    } catch {
      try { rec = new MediaRecorder(out, { mimeType: mime }); } catch (e) {
        mic?.getTracks().forEach((t) => t.stop());
        this.el.rec.disabled = false;
        this.pill('rec', 'warn', `Recording didn’t start: ${e.message}`);
        return;
      }
    }
    this.chunks = []; this.bytes = 0; this.mime = rec.mimeType || mime; this.mic = mic; this.out = out;
    rec.ondataavailable = (e) => { if (e.data?.size) { this.chunks.push(e.data); this.bytes += e.data.size; } };
    rec.onerror = (e) => this.stopRecording(`Recording hit a problem (${e.error?.name || 'error'}). Whatever was recorded is below.`);
    rec.onstop = () => this.finishRecording();
    rec.start(1000);
    this.recorder = rec;
    this.recStart = Date.now();
    this.el.cast.classList.add('recording');
    this.el.rec.disabled = false;
    this.el.rec.setAttribute('aria-label', 'Stop recording');
    this.checkOrientation();
  }

  stopRecording(note = '') {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    this.stopNote = note;
    this.el.cast.classList.remove('recording');
    this.el.rec.setAttribute('aria-label', 'Start recording');
    this.el.recTime.textContent = '';
    try { rec.state !== 'inactive' ? rec.stop() : this.finishRecording(); } catch { this.finishRecording(); }
    this.checkOrientation();
  }

  finishRecording() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.out?.getVideoTracks().forEach((t) => t.stop());
    this.mic = null; this.out = null;
    const chunks = this.chunks;
    this.chunks = [];
    if (!chunks.length) { this.pill('rec', 'warn', 'Nothing was recorded'); return; }
    const type = fileTypeOf(this.mime || '');
    const blob = new Blob(chunks, { type });
    const file = new File([blob], recordingFileName(new Date(), type), { type });
    showClipSheet(file, this.stopNote);
  }

  destroy() {
    if (this.stopped) return;
    if (this.recorder) this.stopRecording('You left the camera, so recording stopped. Your video is below.');
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.wake?.release?.().catch?.(() => {});
    this.wake = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    document.body.classList.remove('casting');
  }
}

// After a recording: preview + Save/Share (Web Share with the file) + download fallback.
// Lives on <body> so it survives leaving the camera screen. Nothing is uploaded.
export function showClipSheet(file, note = '') {
  const url = URL.createObjectURL(file);
  const canShare = !!navigator.canShare?.({ files: [file] });
  const sheet = document.createElement('div');
  sheet.className = 'clip-sheet';
  sheet.innerHTML = `
    <div class="clip-card" role="dialog" aria-label="Your video">
      <div class="clip-head"><b>Your video</b><span>${html(formatBytes(file.size))} · stays on this phone</span></div>
      ${note ? `<p class="clip-note">${html(note)}</p>` : ''}
      <video class="clip-video" src="${url}" controls playsinline></video>
      ${canShare ? '<button type="button" class="btn hot block" data-clip="share">📤 Save / Share</button>' : ''}
      <a class="btn ${canShare ? 'ghost' : 'hot'} block" data-clip="download" href="${url}" download="${html(file.name)}">⬇ Download video</a>
      <button type="button" class="btn ghost block" data-clip="close">Done</button>
      <p class="clip-fine">Closing this deletes the video from the app, so save it first.</p>
    </div>`;
  document.body.append(sheet);
  const close = () => {
    if (!sheet.dataset.saved && !confirm('Close without saving? The video will be gone.')) return;
    sheet.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  sheet.querySelector('[data-clip=share]')?.addEventListener('click', async () => {
    try {
      await navigator.share({ files: [file], title: 'HFL' });
      sheet.dataset.saved = '1';
    } catch (e) {
      if (e?.name !== 'AbortError') alert(`Couldn’t share: ${e?.message || e}. Try Download instead.`);
    }
  });
  sheet.querySelector('[data-clip=download]').addEventListener('click', () => { sheet.dataset.saved = '1'; });
  sheet.querySelector('[data-clip=close]').addEventListener('click', close);
  return sheet;
}
