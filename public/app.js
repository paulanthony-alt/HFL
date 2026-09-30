import * as E from './engine.js';
import { ROSTER_VERSION, rsvpOpen, commissionerIds, localToday, teamCaptain, cleanPlay } from './league.js';
import { TEAM_PIN, makeLock, openLock, secretsMatch, encryptJSON, decryptJSON } from './teamlock.js';
import { PlayEditor, playSVG, newPlay, playToPngBlob } from './playbook.js';
import { computeAwards, DESIGNS, cardDesign } from './awards.js';
import { buildRecap, recapToPngBlob } from './recap.js';
import { parsePlay, VOICE_EXAMPLES } from './voice.js';
import { cardCrop } from './crop.js';
import { nflComps } from './nfl.js';
import { buildWrapped, wrappedSeasons, seasonOver, wrappedToPngBlob } from './wrapped.js';
import { CastView } from './cast.js';
import { clockElapsed, formatClock, quarterLabel, isRunning } from './clock.js';
import { typicalPlays, winProbSeries, biggestSwing, clutchTable, formOf, teamScouting } from './insights.js';

// ---------------------------------------------------------------------------
// State + helpers

const $ = (s, r = document) => r.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } };

const S = {
  db: null, league: null, auth: null, es: null, backend: null, fbConfig: null,
  me: lsGet('hfl.me'), pass: lsGet('hfl.pass'),
  season: null, statTab: 'mvp', fameTab: 'best',
  log: null, editor: null, scores: {}, editorHash: null, after: null, pending: false, lastPath: null,
  // live-data connection (shown on the Cast screen when it drops)
  live: { ok: true, message: '' }, cast: null, castHash: null,
};
function setLive(ok, message = '') {
  if (S.live.ok === ok && S.live.message === message) return;
  S.live = { ok, message };
  S.cast?.update();
}

const REACTIONS = ['🔥', '😂', '💀', '🧂', '🗑️'];
const FAME = {
  best: { label: 'Best Plays', emoji: '🏆' },
  dumb: { label: 'Dumbest Moments', emoji: '🤡' },
  drop: { label: 'Worst Drops', emoji: '🧈' },
};
const TARGET_PLAYERS = 10;

const allPlayers = () => S.db.players;
const activePlayers = () => S.db.players.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const P = (id) => S.db.players.find((p) => p.id === id) || { id, name: 'Unknown', nickname: '', emoji: '❔', color: '#555555', position: 'ATH' };
const nick = (id) => { const p = P(id); return p.nickname || p.name.split(' ')[0]; };
const ovr = (id) => S.league.ovr[id] ?? E.eloToOvr(E.ovrToElo(P(id).startOvr));
// ---- identity + PINs -----------------------------------------------------
// A player's PIN is stored (and checked) as sha256("hfl|<id>|<PIN>"). This phone remembers
// the hash per player once it's been typed, so nobody has to re-enter it.
const storedPin = (id) => lsGet(`hfl.pin.${id}`);
const hasPin = (id) => !!S.db.players.find((p) => p.id === id)?.pinHash;
const pinOk = (id) => { const p = S.db.players.find((x) => x.id === id); return !!p?.pinHash && storedPin(id) === p.pinHash; };
// "Me" = the player picked on this phone, as long as it's unlocked with his PIN (or he hasn't set one yet).
const me = () => (S.me && S.db.players.some((p) => p.id === S.me) && (!hasPin(S.me) || pinOk(S.me)) ? S.me : null);
const isAdmin = (id) => !!id && commissionerIds(S.db).includes(id);
const iAmCommish = () => isAdmin(me()) && pinOk(me());
const canEditProfile = (id) => iAmCommish() || (me() === id && pinOk(id));
async function hashPin(id, pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hfl|${id}|${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const authPayload = () => (S.me && storedPin(S.me) ? { as: S.me, pinHash: storedPin(S.me) } : undefined);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
// Card photos: uploaded ones (p.photo), else a built-in one shipped with the app.
const DEFAULT_PHOTOS = { ben: '/photos/ben.jpg', kellen: '/photos/kellen.jpg', henry: '/photos/henry.jpg', liam: '/photos/liam.jpg', paul: '/photos/paul.jpg', dane: '/photos/dane.jpg', lucas: '/photos/lucas.jpg' };
const photoOf = (p) => p?.photo || DEFAULT_PHOTOS[String(p?.name || '').trim().toLowerCase()] || null;
// Style + attributes that paint a photo as an element's background. Photos kept in
// Firestore ("fsimg:") are filled in after render by hydrateImages().
function photoBg(url) {
  if (!url) return { style: '', attr: '' };
  if (url.startsWith('fsimg:')) return { style: '', attr: ` data-fsbg="${h(url.slice(6))}"` };
  return { style: `;background-image:url('${h(url)}')`, attr: '' };
}
const avatar = (id, cls = '') => {
  const p = P(id);
  const ph = photoOf(p);
  const bg = photoBg(ph);
  return `<span class="av ${cls} ${ph ? 'has-photo' : ''}" style="--c:${h(p.color || '#ff6b1a')}${bg.style}"${bg.attr}>${h(p.emoji || initials(p.name))}</span>`;
};
// 73 → 6'1"
const fmtHeight = (inches) => (inches ? `${Math.floor(inches / 12)}'${inches % 12}"` : '');
const bioLine = (p) => [fmtHeight(p?.heightIn), p?.weightLb ? `${p.weightLb} lbs` : ''].filter(Boolean).join(' · ');
const tier = (o) => (o >= 90 ? 'legend' : o >= 80 ? 'gold' : o >= 70 ? 'silver' : 'bronze');
const attrsOf = (id) => S.league.attrs[id] || E.baseAttrs(P(id));
// Madden-style rating colors: 90+ elite, 80s great, 70s good, 60s meh, below that rough.
const grade = (v) => (v >= 90 ? 'elite' : v >= 80 ? 'great' : v >= 70 ? 'good' : v >= 60 ? 'meh' : 'rough');
const attrMeta = Object.fromEntries(E.ATTRS.map((a) => [a.key, a]));
const ATTR_INFO = {
  spd: ['Top speed: how fast he is once he gets going, running routes, chasing the ball, closing on a QB.', 'Up with rushing TDs, pick sixes and sacks.'],
  acc: ['How fast he gets up to top speed: the first step off the line and the burst out of a cut.', 'Up with rushing TDs, pick sixes and sacks.'],
  rls: ["Getting off the line clean when someone's pressed up on him at the snap.", 'Up with catches and receiving TDs.'],
  cth: ['Hands. When the ball gets to him, does it stick?', 'Up with every catch, down with every drop.'],
  rte: ['Getting open: sharp cuts, timing, shaking the guy covering him.', 'Up with catches and receiving TDs.'],
  thp: ['Arm strength: how far and how hard he can throw it.', 'Up with TD passes.'],
  tha: ['Putting the ball exactly where only his guy can get it.', "Up with completions, down with incompletions and picks. Receivers' drops don't count against him."],
  str: ['Winning the physical stuff: fighting for position, breaking through, not getting pushed around.', 'Up with rushing TDs and sacks.'],
  mcv: ['Sticking to a receiver one-on-one and taking the ball away.', 'Up with interceptions.'],
  tak: ['Finishing the play: getting the tag or the flag when it counts.', 'Up with sacks.'],
  sta: ['Still fast and sharp in the last game of the day.', 'Up a little every game he plays.'],
  bcv: ['Seeing the lane before it opens and taking the right path to the end zone.', 'Up with rushing TDs, receiving TDs and pick sixes.'],
  btk: ["Slipping the tag or the flag grab when a defender's got him lined up.", 'Up with rushing TDs, pick sixes and receiving TDs.'],
  cod: ['Cutting on a dime without losing speed, with or without the ball.', 'Up with rushing TDs, receiving TDs and picks.'],
  jkm: ['The one move that leaves a defender grabbing air.', 'Up with rushing TDs, pick sixes and receiving TDs.'],
  car: ['Ball security: keeping it locked up after the catch or on the run.', 'Up with every catch, rushing TD and pick.'],
  rac: ['What happens after the ball is caught: turning upfield and turning a short one into a long one.', 'Up with catches, and a lot with receiving TDs.'],
};
const GRADES = [['elite', '90–99', 'Elite'], ['great', '80–89', 'Great'], ['good', '70–79', 'Good'], ['meh', '60–69', 'Average'], ['rough', '20–59', 'Needs work']];
const keyLink = (label = 'Ratings key') => `<a class="sec-link" href="#/key">${label} ›</a>`;
function attrBar(key, value, delta = null, { label = false } = {}) {
  const d = delta === null || Math.abs(delta) < 0.05 ? '' : `<span class="ab-d ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}</span>`;
  return `<div class="ab" title="${h(attrMeta[key].label)}">
    <span class="ab-k">${attrMeta[key].short}</span>${label ? `<span class="ab-l">${h(attrMeta[key].label)}</span>` : ''}
    <span class="ab-bar"><i class="g-${grade(value)}" style="width:${value}%"></i></span>
    <b class="ab-v g-${grade(value)}">${value}</b>${d}</div>`;
}
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
};
const fmtTime = (t) => {
  if (!t) return '';
  const [H, M] = t.split(':').map(Number);
  return new Date(2000, 0, 1, H, M).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const pct = (x) => `${Math.round(x * 100)}%`;
// Elo change → OVR points, e.g. 18 → "▲1.8"
const deltaTag = (d) => `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'}${(Math.abs(d) / 10).toFixed(1)}</span>`;
const gamesSorted = () => E.sortGames(S.db.games);
const teamName = (g, side) => g.teamNames?.[side] || (side === 'A' ? 'Team A' : 'Team B');
const gameInfo = (g) => S.league.games[g.id] || { summary: E.summarizeGame(g) };

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${isError ? 'err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), 2600);
}

// ---------------------------------------------------------------------------
// Server sync

async function api(method, url, body) {
  // Every change says who's asking, so the league rules can check PIN-protected edits.
  if (method !== 'GET' && authPayload()) body = { ...(body || {}), _auth: authPayload() };
  if (S.backend) { // Firebase: run the change right here against Firestore
    const { result, db } = await S.backend.request(method, url, body);
    setDb(db);
    return result;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-hfl-pass': S.pass },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      const p = prompt('Crew passcode?');
      if (p === null) throw new Error('Crew passcode needed');
      S.pass = p.trim();
      lsSet('hfl.pass', S.pass);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    if (data.db) setDb(data.db);
    return data.result;
  }
  throw new Error('Wrong crew passcode');
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}

function setDb(db, { remote = false } = {}) {
  if (S.db && db.version < S.db.version) return;
  S.db = db;
  S.league = E.computeLeague(db);
  S.awards = computeAwards(db, S.league);
  S.form = formOf(db, S.league);
  S.clutch = { career: clutchTable(db), season: clutchTable(db, db.settings.season) };
  if (!S.season) S.season = db.settings.season;
  remote ? requestRender() : render();
}

async function loadState(remote = false) {
  const res = await fetch('/api/state', { headers: { 'x-hfl-pass': S.pass } });
  if (res.status === 401 && S.db) return boot(); // passcode changed under us → ask for the new one
  if (!res.ok) throw new Error('Could not load the league');
  const { db } = await res.json();
  if (!S.db || db.version !== S.db.version) setDb(db, { remote });
}

function connectStream() {
  S.es?.close();
  const es = (S.es = new EventSource(`/api/stream?pass=${encodeURIComponent(S.pass)}`));
  es.addEventListener('change', (e) => {
    const { version } = JSON.parse(e.data);
    if (!S.db || version !== S.db.version) loadState(true).catch(() => {});
  });
  es.addEventListener('auth', () => loadState(true).catch(() => {}));
  es.onopen = () => { $('#live-dot').classList.add('on'); setLive(true); };
  es.onerror = () => {
    $('#live-dot').classList.remove('on');
    setLive(false, 'Connection lost. Reconnecting… the score may be behind');
    // A rejected passcode closes the stream for good; retry with whatever code we have now.
    if (es.readyState === EventSource.CLOSED && S.es === es) setTimeout(() => S.es === es && connectStream(), 3000);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.db) loadState(true).catch(() => {});
});

const isTyping = () => {
  const a = document.activeElement;
  return a && $('#view').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button';
};
function requestRender() {
  if (isTyping()) { S.pending = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (S.pending && !isTyping()) { S.pending = false; render(); }
}, 80));

// ---------------------------------------------------------------------------
// Router

const ROUTES = [
  [/^#\/?$/, viewHome, 'game'],
  [/^#\/g\/([\w-]+)$/, viewGame, 'game'],
  [/^#\/new-game$/, viewNewGame, 'game'],
  [/^#\/stats$/, viewStats, 'stats'],
  [/^#\/cards$/, viewCards, 'cards'],
  [/^#\/new-player$/, () => viewEditPlayer(null), 'cards'],
  [/^#\/p\/([\w-]+)\/edit$/, viewEditPlayer, 'cards'],
  [/^#\/p\/([\w-]+)$/, viewCard, 'cards'],
  [/^#\/plays$/, viewPlays, 'plays'],
  [/^#\/play\/([\w-]+)$/, viewPlay, 'plays'],
  [/^#\/team\/([\w-]+)\/([AB])$/, viewTeamBook, 'plays'],
  [/^#\/team\/([\w-]+)\/([AB])\/p\/([\w-]+)$/, viewTeamPlay, 'plays'],
  [/^#\/wall$/, viewWall, 'wall'],
  [/^#\/fame$/, viewFame, 'fame'],
  [/^#\/fame\/new$/, viewFameNew, 'fame'],
  [/^#\/me$/, viewMe, ''],
  [/^#\/unlock\/([\w-]+)$/, viewUnlock, ''],
  [/^#\/nickname$/, viewNickname, ''],
  [/^#\/ratings$/, viewRatings, ''],
  [/^#\/key$/, viewKey, 'cards'],
  [/^#\/awards$/, viewAwards, 'stats'],
  [/^#\/wrapped$/, viewWrappedPicker, 'stats'],
  [/^#\/wrapped\/([\w-]+)$/, viewWrapped, ''],
  [/^#\/settings$/, viewSettings, ''],
  [/^#\/cast$/, viewCast, ''],
  [/^#\/rules$/, viewRules, 'rules'],
];

function render() {
  if (!S.db) return;
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  // The camera screen stays mounted across live updates (re-rendering would restart the
  // camera and cut the recording); it just reads the new data.
  if (S.cast) {
    if (S.castHash === hash) { S.cast.update(); return; }
    S.cast.destroy();
    S.cast = null;
    S.castConn?.();
    S.castConn = null;
  }
  if (S.editor) {
    if (S.editorHash === hash) return renderChrome('plays');
    S.editor.destroy();
    S.editor = null;
  }
  let match = null;
  for (const [re, fn, tab] of ROUTES) {
    const m = re.exec(path);
    if (m) { match = { fn, tab, args: m.slice(1) }; break; }
  }
  match ||= { fn: viewHome, tab: 'game', args: [] };
  S.after = null;
  $('#view').dataset.tab = match.tab || 'other';
  $('#view').innerHTML = match.fn(...match.args, new URLSearchParams(qs || ''));
  S.after?.();
  // left the game (or it ended): stop listening
  if (V.on && !document.querySelector('.voice-live')) voiceStop();
  hydrateImages();
  renderChrome(match.tab);
  if (S.lastPath !== path) {
    window.scrollTo(0, 0);
    const v = $('#view');
    v.classList.remove('enter');
    void v.offsetWidth; // restart the entrance animation
    v.classList.add('enter');
    // Only animate on navigation, not on every live re-render of the same page.
    clearTimeout(S.enterTimer);
    S.enterTimer = setTimeout(() => v.classList.remove('enter'), 750);
  }
  S.lastPath = path;
}

// Firebase keeps Hall of Fame photos in Firestore; fill them in after the page renders.
function hydrateImages() {
  if (!S.backend) return;
  document.querySelectorAll('img[data-fsimg]').forEach((img) => {
    S.backend.getImage(img.dataset.fsimg).then((src) => { if (src) img.src = src; }).catch(() => {});
  });
  document.querySelectorAll('[data-fsbg]').forEach((el) => {
    S.backend.getImage(el.dataset.fsbg).then((src) => { if (src) el.style.backgroundImage = `url("${src}")`; }).catch(() => {});
  });
}

// One-time: make the league the HFL crew (see HFL_ROSTER in league.js).
// Games started before game day (from before that was blocked) go back to scheduled so RSVPs reopen.
function undoEarlyStarts() {
  const early = S.db.games.filter((g) => g.status === 'live' && !g.events.length && localToday() < g.date);
  for (const g of early) api('POST', `/api/games/${g.id}/unstart`).catch(() => {});
}

function ensureRoster() {
  if ((S.db.settings.rosterVersion || 0) >= ROSTER_VERSION || ensureRoster.running) return;
  ensureRoster.running = true;
  api('POST', '/api/setup-roster')
    .then((r) => {
      if (!r?.changed) return;
      const n = r.names || [];
      toast(n.length ? `🏈 ${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]} joined the HFL` : '🏈 The HFL roster is set. Tap “Who are you?” to pick yourself');
    })
    .catch(() => {})
    .finally(() => { ensureRoster.running = false; });
}

// Tell a player (once per phone) when he unlocks a new card design.
function announceUnlocks(id) {
  const k = `hfl.seenDesigns.${id}`;
  const unlocked = S.awards.designs[id] || [''];
  const raw = lsGet(k);
  const seen = raw ? raw.split(',') : null;
  lsSet(k, unlocked.join(','));
  if (!seen) return; // first visit: nothing to announce yet
  const fresh = DESIGNS.filter((d) => d.key && unlocked.includes(d.key) && !seen.includes(d.key));
  if (fresh.length) setTimeout(() => toast(`🔓 New card design unlocked: ${fresh[0].emoji} ${fresh[0].name}. Tap your card to wear it.`), 400);
}

function renderChrome(tab) {
  $('#crew-name').textContent = S.db.settings.crewName === 'HFL' ? '' : S.db.settings.crewName;
  document.title = S.db.settings.crewName === 'HFL' ? 'HFL' : `HFL · ${S.db.settings.crewName}`;
  const m = me();
  $('#me-pill').innerHTML = m ? `${avatar(m, 'xs')} ${h(nick(m))}` : 'Who are you?';
  if (m) { hydrateImages(); announceUnlocks(m); }
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}

const needMe = () => {
  if (me()) return true;
  toast('Pick who you are first');
  location.hash = '#/me';
  return false;
};

// ---------------------------------------------------------------------------
// Shared bits

function scoreboard(g) {
  const { summary } = gameInfo(g);
  const w = summary.winner;
  // Flash a score when it changes between renders (someone just scored).
  const prev = S.scores[g.id];
  S.scores[g.id] = { ...summary.score };
  const bump = (side) => (prev && prev[side] !== summary.score[side] ? 'bump' : '');
  const status = g.status === 'live' ? '<span class="chip live">Live</span>' : g.status === 'final' ? '<span class="chip">Final</span>' : '';
  return `
    <div class="scoreboard">
      <div class="sb-team sb-A ${w === 'A' ? 'win' : ''} ${w && w !== 'A' ? 'lose' : ''}"><div class="sb-name">${h(teamName(g, 'A'))}</div><div class="sb-score ${bump('A')}">${summary.score.A}</div></div>
      <div class="sb-mid">${status}<div class="sb-date">${h(fmtDate(g.date))}</div></div>
      <div class="sb-team sb-B ${w === 'B' ? 'win' : ''} ${w && w !== 'B' ? 'lose' : ''}"><div class="sb-name">${h(teamName(g, 'B'))}</div><div class="sb-score ${bump('B')}">${summary.score.B}</div></div>
    </div>`;
}

function describeEvent(ev) {
  const t = E.EVENT_TYPES[ev.type];
  if (!t) return `<span class="ev-emoji">·</span> <b>Old play</b> <span class="ev-text">(no longer tracked)</span>`;
  const a = h(nick(ev.p1));
  const b = ev.p2 ? h(nick(ev.p2)) : '';
  const text = {
    pass_td: `${a} → ${b}`,
    catch: `${a} → ${b}`,
    incomplete: b ? `${a}, intended for ${b}` : a,
    drop: b ? `${a} (from ${b})` : a,
    int: b ? `${a} picks off ${b}` : a,
    pick_six: b ? `${a} takes ${b} to the house` : a,
    sack: b ? `${a} gets ${b}` : a,
    rush_td: a,
  }[ev.type] || a;
  return `<span class="ev-emoji">${t.emoji}</span> <b>${h(t.label)}</b> <span class="ev-text">${text}</span>`;
}

function statLine(s) {
  if (!s) return '—';
  const parts = [];
  if (s.att) parts.push(`${s.comp}/${s.att}${s.passTD ? `, ${s.passTD} TD` : ''}${s.intThrown ? `, ${s.intThrown} INT` : ''}`);
  if (s.rec || s.recTD) parts.push(`${s.rec} rec${s.recTD ? `, ${s.recTD} TD` : ''}`);
  if (s.rushTD) parts.push(`${s.rushTD} rush TD`);
  if (s.defInt) parts.push(`${s.defInt} INT${s.defTD ? ` (${s.defTD} pick-6)` : ''}`);
  if (s.sacks) parts.push(`${s.sacks} sack${s.sacks > 1 ? 's' : ''}`);
  if (s.drops) parts.push(`${s.drops} drop${s.drops > 1 ? 's' : ''} 🧈`);
  if (s.sacked) parts.push(`sacked ${s.sacked}×`);
  return parts.join(' · ') || '—';
}

function sparkline(history, { w = 280, hgt = 56, cls = '' } = {}) {
  const vals = history.map((x) => E.eloToOvr(x.elo));
  if (vals.length < 2) return `<div class="spark-empty">Rating history shows up after his first game.</div>`;
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * (w - 8) + 4, hgt - 4 - ((v - lo) / (hi - lo)) * (hgt - 8)]);
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" role="img" aria-label="Rating from ${vals[0]} to ${vals[vals.length - 1]}">
    <polyline points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${up ? 'var(--good)' : 'var(--bad)'}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${up ? 'var(--good)' : 'var(--bad)'}"/>`).join('')}
  </svg>`;
}

function seasons() {
  const set = new Set([S.db.settings.season, ...S.db.games.map((g) => g.season)]);
  return [...set].filter(Boolean).sort().reverse();
}

// Line-art illustrations for empty states. Stroke is currentColor; `.acc` parts pick up the accent.
const ART = {
  field: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M8 86h104"/><path d="M60 86V54M34 54h52M34 54V8M86 54V8"/><path class="acc" d="M12 78C22 44 40 26 55 22" stroke-dasharray="2 6"/><g class="acc" transform="rotate(-28 64 22)"><ellipse cx="64" cy="22" rx="11" ry="6.5"/><path d="M58.5 22h11M61 20v4M64 20v4M67 20v4"/></g></svg>`,
  chalk: `<svg viewBox="0 0 120 90" aria-hidden="true"><circle cx="24" cy="66" r="8"/><circle cx="56" cy="70" r="8"/><path d="M84 58l12 12M96 58L84 70M84 16l12 12M96 16L84 28"/><path class="acc" d="M24 56C26 30 44 18 70 20"/><path class="acc" d="M64 14l7 6-7 6"/><path class="acc" d="M56 60c2-12 8-18 16-22" stroke-dasharray="2 5"/></svg>`,
  mic: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M22 36h14l38-20v52L36 50H22z"/><path d="M36 50l7 24H33l-7-24"/><path class="acc" d="M86 32c6 7 6 17 0 24M96 24c11 12 11 30 0 42"/></svg>`,
  trophy: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M44 10h32v22a16 16 0 0 1-32 0z"/><path d="M44 16H33a10 10 0 0 0 12 18M76 16h11a10 10 0 0 1-12 18M60 48v12M48 84h24M51 60h18v24H51z"/><path class="acc" d="M20 20v8M16 24h8M100 44v8M96 48h8M92 10v6M89 13h6"/></svg>`,
  chart: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M14 80h92"/><rect x="24" y="52" width="14" height="28" rx="2"/><rect x="46" y="36" width="14" height="44" rx="2"/><rect class="acc" x="68" y="18" width="14" height="62" rx="2"/><rect x="90" y="44" width="10" height="36" rx="2" opacity=".5"/></svg>`,
  cards: `<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="30" y="14" width="40" height="58" rx="5" transform="rotate(-10 50 43)"/><rect class="acc" x="52" y="12" width="40" height="58" rx="5" transform="rotate(8 72 41)"/><path class="acc" d="M66 50l6-14 6 14"/></svg>`,
  whistle: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M30 40h44a18 18 0 1 1-18 18H38a8 8 0 0 1-8-8z"/><circle cx="74" cy="58" r="6"/><path d="M30 40l-8-8"/><path class="acc" d="M86 22l8-8M96 32h10M78 16V6"/></svg>`,
};
const empty = ({ art = 'field', title, text = '', cta = '' }) =>
  `<div class="empty"><div class="empty-art">${ART[art]}</div><h3>${title}</h3>${text ? `<p>${text}</p>` : ''}${cta}</div>`;
const sec = (title, extra = '') => `<div class="sec"><h3>${title}</h3>${extra}</div>`;
const pageHead = (kicker, title, right = '') =>
  `<header class="page-head"><div><div class="kicker">${kicker}</div><h1 class="page-title">${title}</h1></div>${right}</header>`;
const rankBadge = (i) => `<span class="rk rk-${Math.min(i + 1, 4)}">${i + 1}</span>`;
const PIN = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const ticket = (iso, cls = '') => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `<div class="ticket ${cls}"><span>${h(dt.toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${d}</b><span>${h(dt.toLocaleDateString(undefined, { month: 'short' }))}</span></div>`;
};

// ---------------------------------------------------------------------------
// Game views

function viewHome() {
  if (!S.db.players.length) return viewOnboarding();
  const games = gamesSorted();
  const live = games.filter((g) => g.status === 'live');
  const upcoming = games.filter((g) => g.status === 'scheduled');
  const finals = games.filter((g) => g.status === 'final').reverse();
  // Right after the final whistle, keep the result (and MVP vote) up top until the next game is scheduled.
  const current = live[0] || upcoming[0] || finals[0];
  const table = E.seasonTable(S.db, S.league, S.db.settings.season);
  const leaders = Object.entries(table).sort((a, b) => E.mvpScore(b[1]) - E.mvpScore(a[1])).slice(0, 3);

  const others = [...live.slice(1), ...upcoming.filter((g) => g !== current)];
  const main = `
    ${me() && !hasPin(me()) ? `<a class="banner" href="#/unlock/${me()}"><span class="banner-dot"></span><span><b>Lock your profile.</b> Create a PIN so nobody else can change your nickname, photo or card.</span><span class="banner-go">›</span></a>` : ''}
    ${me() ? '' : `<a class="banner" href="#/me"><span class="banner-dot"></span><span><b>Who's holding this phone?</b> Pick yourself so your RSVPs, votes and posts count.</span><span class="banner-go">›</span></a>`}
    ${(() => {
      const ws = wrappedBannerSeason();
      const cur = S.db.games.filter((g) => g.status === 'final' && g.season === S.db.settings.season).length;
      if (!ws || cur >= 4) return '';
      const mine = me() && buildWrapped(S.db, S.league, S.awards, me(), ws, { name: nick });
      return `<a class="banner wr-banner" href="${mine ? `#/wrapped/${me()}?s=${encodeURIComponent(ws)}` : `#/wrapped?s=${encodeURIComponent(ws)}`}"><span class="banner-dot"></span><span><b>🎁 Your Season ${h(ws)} Wrapped is here.</b> Your numbers, your nemesis, your best play.</span><span class="banner-go">›</span></a>`;
    })()}
    ${current ? gamePanel(current) : `
      <section class="card">${empty({ art: 'field', title: 'No game on the schedule', text: 'Set one up and the crew can start tapping in.', cta: '<a class="btn hot" href="#/new-game">Schedule a game</a>' })}</section>`}
    ${others.length ? sec('Also on the schedule') + others.map((g) => `
      <a class="row-card" href="#/g/${g.id}">
        ${ticket(g.date, 'sm')}
        <span class="grow"><b>${g.status === 'live' ? '<span class="chip live">Live</span> ' : ''}${h(fmtDate(g.date, { weekday: 'long' }))}${g.time ? ` · ${h(fmtTime(g.time))}` : ''}</b><span class="muted small">${h(g.location || 'Location TBD')}</span></span>
        <span class="row-meta"><b>${Object.values(g.rsvps).filter((x) => x === 'in').length}</b> in</span>
      </a>`).join('') : ''}
    ${current ? `<a class="btn ${current.status === 'final' ? 'hot' : 'ghost'} block" href="#/new-game">+ Schedule ${current.status === 'final' ? 'the next' : 'another'} game</a>` : ''}`;

  const rest = finals.filter((g) => g !== current);
  const potw = S.awards.potw.at(-1);
  const side = `
    ${potw ? `
      ${sec('Player of the Week', '<a class="sec-link" href="#/awards">Awards ›</a>')}
      <a class="potw" href="#/p/${potw.id}">
        ${avatar(potw.id, 'lg')}
        <span class="grow"><b>${h(nick(potw.id))}</b><span class="muted small">Week of ${h(fmtDate(potw.week, { month: 'short', day: 'numeric' }))} · ${statLine(potw.stats)}</span></span>
        <span class="potw-flame">🔥</span>
      </a>` : ''}
    ${leaders.length ? `
      ${sec('MVP race', `<a class="sec-link" href="#/stats">Season ${h(S.db.settings.season)} ›</a>`)}
      <div class="podium">${leaders.map(([id, st], i) => `
        <a href="#/p/${id}" class="pod pod-${i + 1}">
          <span class="pod-rank">${i + 1}</span>
          ${avatar(id, 'lg')}
          <div class="pod-name">${h(nick(id))}</div>
          <div class="pod-score"><b>${Math.round(E.mvpScore(st))}</b> pts</div>
        </a>`).join('')}
      </div>` : ''}
    ${rest.length ? sec('Recent results') + rest.slice(0, 6).map(resultRow).join('') : ''}`;

  return `<div class="home-grid"><div class="home-main">${main}</div>${side.trim() ? `<aside class="home-side">${side}</aside>` : ''}</div>`;
}

function resultRow(g) {
  const { summary, mvp } = gameInfo(g);
  const w = summary.winner;
  return `
    <a class="result" href="#/g/${g.id}">
      ${ticket(g.date, 'sm')}
      <div class="res-teams">
        <div class="${w === 'A' ? 'win' : ''}">${h(teamName(g, 'A'))} <b>${summary.score.A}</b></div>
        <div class="${w === 'B' ? 'win' : ''}">${h(teamName(g, 'B'))} <b>${summary.score.B}</b></div>
      </div>
      <div class="res-mvp">${mvp?.winner ? `<span class="muted small">MVP</span>${h(nick(mvp.winner))}` : ''}</div>
    </a>`;
}

function viewOnboarding() {
  return `
    <section class="hero">
      <div class="hero-kicker">Pickup football · Est. ${new Date().getFullYear()}</div>
      <div class="hero-logo">HFL</div>
      <p class="hero-tag">Your pickup league. Real stats. Zero mercy.</p>
    </section>
    <section class="card onboard">
      <h2>Start the league</h2>
      <p class="muted">Add your crew, schedule a game, and let everyone tap in. Teams balance themselves and ratings update after every game.</p>
      <a class="btn hot block" href="#/new-player">+ Add the first player</a>
      <button class="btn ghost block" data-a="seed-demo">Load a demo crew to try it out</button>
      <p class="muted small">Demo data can be wiped later by restoring an empty backup, or just start a fresh server.</p>
    </section>`;
}

function viewGame(id) {
  const g = S.db.games.find((x) => x.id === id);
  if (!g) return `<p class="muted">That game doesn't exist anymore. <a href="#/">Back</a></p>`;
  return `<a class="back" href="#/">‹ Games</a>${gamePanel(g)}${gameAdmin(g)}`;
}

function gamePanel(g) {
  const head = `
    <div class="game-head">
      ${ticket(g.date)}
      <div class="gh-main">
        <div class="kicker">${g.status === 'scheduled' ? 'Next game' : g.status === 'live' ? 'Game on' : 'Final'}</div>
        <h2 class="gh-title">${h(fmtDate(g.date, { weekday: 'long' }))}${g.time ? ` <span class="gh-time">${h(fmtTime(g.time))}</span>` : ''}</h2>
        <div class="gh-loc">${PIN}${h(g.location || 'Location TBD')}</div>
      </div>
      <a class="icon-btn" href="#/g/${g.id}" aria-label="Game details">›</a>
    </div>`;
  const body = g.status === 'scheduled' ? rsvpSection(g) + teamsSection(g) : g.status === 'live' ? liveSection(g) : finalSection(g);
  return `<section class="card game-card is-${g.status}">${head}${body}</section>`;
}

function rsvpSection(g) {
  const act = activePlayers();
  const status = (id) => g.rsvps[id] || '';
  const ins = act.filter((p) => status(p.id) === 'in');
  const outs = act.filter((p) => status(p.id) === 'out');
  const none = act.filter((p) => !status(p.id));
  const m = me();
  const mine = m ? status(m) : '';
  const open = rsvpOpen(g);
  const chip = (p) => (open
    ? `<button class="pchip ${status(p.id)}" data-a="rsvp-cycle" data-g="${g.id}" data-p="${p.id}">${avatar(p.id, 'xs')} ${h(nick(p.id))}</button>`
    : `<span class="pchip ${status(p.id)}">${avatar(p.id, 'xs')} ${h(nick(p.id))}</span>`);
  const [y, mo, d] = g.date.split('-').map(Number);
  const deadline = new Date(y, mo - 1, d - 1).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!open) {
    return `
    <div class="rsvp">
      <div class="rsvp-closed">🔒 <span><b>RSVPs are closed.</b> It's game day. Anyone who shows up can still be added to a team below.</span></div>
      ${ins.length ? `<div class="chips-label">RSVP'd in (${ins.length})</div><div class="chips">${ins.map(chip).join('')}</div>` : ''}
    </div>`;
  }
  return `
    <div class="rsvp">
      ${!open ? `<div class="rsvp-closed">🔒 <span><b>RSVPs are closed.</b> It's game day. Anyone who shows up can still be added to a team below.</span></div>` : m ? `
        <div class="rsvp-me">
          <button class="btn big rsvp-btn ${mine === 'in' ? 'in' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="in">I'm in</button>
          <button class="btn big rsvp-btn ${mine === 'out' ? 'out' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="out">I'm out</button>
        </div>` : `<a class="btn ghost block" href="#/me">Pick who you are to RSVP</a>`}
      <div class="count"><b>${ins.length}</b><span>in</span><em>${ins.length >= TARGET_PLAYERS ? 'We got a game' : `Need ${TARGET_PLAYERS - ins.length} more for 5v5`}</em></div>
      <div class="bar ${ins.length >= TARGET_PLAYERS ? 'full' : ''}">${Array.from({ length: TARGET_PLAYERS }, (_, i) => `<i class="${i < ins.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="chips-label">In</div><div class="chips">${ins.map(chip).join('') || '<span class="muted small">Nobody yet</span>'}</div>
      ${none.length ? `<div class="chips-label">No reply</div><div class="chips">${none.map(chip).join('')}</div>` : ''}
      ${outs.length ? `<div class="chips-label">Out</div><div class="chips">${outs.map(chip).join('')}</div>` : ''}
      ${open ? `<p class="muted small">Tap anyone's name to mark them in / out / no reply. RSVPs close at midnight at the end of ${h(deadline)}.</p>` : ''}
    </div>`;
}

function teamColumns(g, { editable = false, info = null } = {}) {
  const i = info || gameInfo(g);
  const col = (side) => {
    const ids = g.teams[side];
    const avg = ids.length ? Math.round(ids.reduce((a, id) => a + ovr(id), 0) / ids.length) : 0;
    return `
      <div class="team team-${side}">
        <button class="team-name" ${editable ? `data-a="rename-team" data-g="${g.id}" data-side="${side}"` : 'disabled'}>${h(teamName(g, side))}${editable ? ' ✎' : ''}</button>
        <div class="muted small">avg OVR ${avg}</div>
        ${ids.map((id) => `
          <${editable ? `button data-a="swap" data-g="${g.id}" data-p="${id}"` : 'div'} class="tp">
            ${avatar(id, 'xs')}<span class="tp-name">${h(nick(id))}${S.form[id]?.hot ? ' 🔥' : S.form[id]?.cold ? ' ❄️' : ''}</span><span class="tp-ovr">${ovr(id)}</span>
          </${editable ? 'button' : 'div'}>`).join('')}
      </div>`;
  };
  const wp = i.winProbA ?? 0.5;
  return `
    <div class="teams">${col('A')}${col('B')}</div>
    <div class="wp"><span style="width:${pct(wp)}"></span></div>
    <div class="wp-labels"><span>${pct(wp)}</span><span class="muted small">win odds</span><span>${pct(1 - wp)}</span></div>
    ${scoutingReport(g)}`;
}

// Strengths & weaknesses for each side, from everyone's ratings.
function scoutingReport(g) {
  const A = g.teams?.A || [], B = g.teams?.B || [];
  if (!A.length || !B.length) return '';
  const league = activePlayers().map((p) => p.id);
  const side = (k, mine, theirs) => {
    const r = teamScouting(mine, theirs, league, attrsOf);
    const item = (x, good) => `<li class="${good ? 'up' : 'down'}"><span>${x.emoji}</span><b>${h(x.label)}</b></li>`;
    return `
      <div class="scout-team t-${k}">
        <div class="scout-name">${h(teamName(g, k))}</div>
        <div class="chips-label">Strengths</div>
        <ul class="scout-list">${r.strengths.map((x) => item(x, true)).join('') || '<li class="none">Nothing stands out</li>'}</ul>
        <div class="chips-label">Weaknesses</div>
        <ul class="scout-list">${r.weaknesses.map((x) => item(x, false)).join('') || '<li class="none">No holes</li>'}</ul>
      </div>`;
  };
  return `<div class="scout"><div class="scout-grid">${side('A', A, B)}${side('B', B, A)}</div></div>`;
}

function teamsSection(g) {
  const ins = activePlayers().filter((p) => g.rsvps[p.id] === 'in');
  const hasTeams = g.teams.A.length && g.teams.B.length;
  const onTeam = new Set([...g.teams.A, ...g.teams.B]);
  const bench = ins.filter((p) => !onTeam.has(p.id));
  const walkOns = activePlayers().filter((p) => g.rsvps[p.id] !== 'in' && !onTeam.has(p.id));
  const pool = new Set([...ins.map((p) => p.id), ...onTeam]).size;
  const walkOnChips = !rsvpOpen(g) && walkOns.length ? `<div class="chips-label">Walk-ons (didn't RSVP but showed up)</div><div class="chips">${walkOns.map((p) => `<button class="pchip" data-a="bench-add" data-g="${g.id}" data-p="${p.id}">+ ${h(nick(p.id))}</button>`).join('')}</div>` : '';
  return `
    <div class="divider"></div>
    ${sec('Teams', hasTeams ? '<span class="sec-link muted">Tap a player to swap sides</span>' : '')}
    ${hasTeams ? `
      ${teamColumns(g, { editable: true })}
      ${bench.length ? `<div class="chips-label">In but not on a team</div><div class="chips">${bench.map((p) => `<button class="pchip" data-a="bench-add" data-g="${g.id}" data-p="${p.id}">+ ${h(nick(p.id))}</button>`).join('')}</div>` : ''}
      ${walkOnChips}
      <div class="btn-row">
        <button class="btn ghost" data-a="auto-teams" data-g="${g.id}">Reshuffle</button>
        ${g.prevTeams ? `<button class="btn ghost" data-a="undo-teams" data-g="${g.id}">↶ Undo shuffle</button>` : ''}
        ${localToday() >= g.date
          ? `<button class="btn hot grow" data-a="start" data-g="${g.id}">▶ Start game</button>`
          : `<span class="start-later grow">▶ You can start the game on game day (${h(fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' }))})</span>`}
      </div>` : `
      <p class="muted">Once guys are in, the app splits them into the fairest teams it can find from everyone's rating.</p>
      ${onTeam.size ? `<p class="muted small">Added so far: ${[...onTeam].map((pid) => h(nick(pid))).join(', ')}</p>` : ''}
      ${walkOnChips}
      <button class="btn hot block" data-a="auto-teams" data-g="${g.id}" ${pool < 2 ? 'disabled' : ''}>Make balanced teams · ${pool} ${pool === 1 ? 'player' : 'players'}</button>`}`;
}

// ESPN-style win probability: team A's chance from 100% (top) to 0% (bottom).
function momentumData(g) {
  const info = gameInfo(g);
  const series = winProbSeries(g, info, { expected: typicalPlays(S.db) });
  return { series, swing: biggestSwing(series) };
}

function swingText(g, swing) {
  if (!swing) return '';
  const side = swing.delta > 0 ? 'A' : 'B';
  const pts = Math.round(Math.abs(swing.delta) * 100);
  return `${describeEvent(swing.ev)} <span class="swing-to t-${side}">${pts}% swing to ${h(teamName(g, side))}</span>`;
}

function teamColumnsOdds(g) {
  const wp = gameInfo(g).winProbA ?? 0.5;
  return `<div class="wp"><span style="width:${pct(wp)}"></span></div>
    <div class="wp-labels"><span>${pct(wp)}</span><span class="muted small">win odds</span><span>${pct(1 - wp)}</span></div>`;
}

function momentumChart(g) {
  if (!g.events.length) return `<section class="card momentum"><h3>Win probability</h3>${teamColumnsOdds(g)}${scoutingReport(g)}</section>`;
  const { series, swing } = momentumData(g);
  const W = 600, H = 150, pad = 6;
  const last = series[series.length - 1];
  // Live games fill in left to right, like the real thing; the empty space is what's left.
  const x = (t) => pad + t * (W - pad * 2);
  const y = (wp) => pad + (1 - wp) * (H - pad * 2);
  const pts = series.map((p) => `${x(p.t).toFixed(1)},${y(p.wp).toFixed(1)}`).join(' ');
  const mid = y(0.5);
  const area = `M${x(0).toFixed(1)},${mid} L${pts.split(' ').join(' L')} L${x(last.t).toFixed(1)},${mid} Z`;
  const scores = series.filter((p) => p.ev && E.EVENT_TYPES[p.ev.type]?.points);
  const cur = last.wp;
  const lead = cur >= 0.5 ? 'A' : 'B';
  const leadPct = Math.round((lead === 'A' ? cur : 1 - cur) * 100);
  return `
    <section class="card momentum">
      <div class="row-between"><h3>Win probability</h3><span class="wp-now t-${lead}">${g.status === 'final' ? (cur === 0.5 ? 'Tie' : `${h(teamName(g, lead))} won`) : `${h(teamName(g, lead))} ${leadPct}%`}</span></div>
      <div class="wp-wrap">
        <span class="wp-lab wp-lab-a t-A">${h(teamName(g, 'A'))}</span>
        <span class="wp-lab wp-lab-b t-B">${h(teamName(g, 'B'))}</span>
        <svg class="wp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Win probability chart">
          <defs>
            <clipPath id="wpA-${g.id}"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath>
            <clipPath id="wpB-${g.id}"><rect x="0" y="${mid}" width="${W}" height="${H - mid}"/></clipPath>
          </defs>
          <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="wp-mid"/>
          <path d="${area}" class="wp-fill-a" clip-path="url(#wpA-${g.id})"/>
          <path d="${area}" class="wp-fill-b" clip-path="url(#wpB-${g.id})"/>
          <polyline points="${pts}" class="wp-line" vector-effect="non-scaling-stroke"/>
          ${swing ? `<line x1="${x(swing.t).toFixed(1)}" x2="${x(swing.t).toFixed(1)}" y1="0" y2="${H}" class="wp-swing" vector-effect="non-scaling-stroke"/>` : ''}
        </svg>
        ${scores.map((p) => `<i class="wp-dot t-${p.ev.team}" style="left:${(x(p.t) / W * 100).toFixed(2)}%;top:${(y(p.wp) / H * 100).toFixed(2)}%" title="${h(E.EVENT_TYPES[p.ev.type].label)}"></i>`).join('')}
      </div>
      ${swing ? `<div class="swing"><span class="kicker gold">Biggest momentum swing</span><div class="swing-body">${swingText(g, swing)}</div></div>` : ''}
      ${scoutingReport(g)}
    </section>`;
}

// ---------------------------------------------------------------------------
// Game clock (optional; see clock.js) + the Cast / Film camera screen

function clockBar(g) {
  const c = g.clock;
  const cast = `<a class="btn sm ghost" href="#/cast?g=${g.id}">📹 Cast / Film</a>`;
  if (!c) {
    return `<div class="clock-bar"><button class="btn sm ghost" data-a="clock" data-g="${g.id}" data-c="start">⏱ Start game clock</button>${cast}</div>`;
  }
  const running = isRunning(c);
  const atZero = clockElapsed(c, Date.now()) === 0;
  return `
    <div class="clock-bar on">
      <span class="clock-q">${quarterLabel(c.quarter || 1)}</span>
      <b class="clock-time ${running ? '' : 'paused'}" data-clock-for="${g.id}">${formatClock(clockElapsed(c, Date.now()))}</b>
      ${running
        ? `<button class="btn sm" data-a="clock" data-g="${g.id}" data-c="pause">⏸ Pause</button>`
        : `<button class="btn sm hot" data-a="clock" data-g="${g.id}" data-c="resume">▶ ${atZero ? 'Start' : 'Resume'}</button>`}
      <details class="clock-more"><summary aria-label="More clock options">⋯</summary>
        <div>
          <button class="btn sm ghost" data-a="clock" data-g="${g.id}" data-c="next-quarter">Next quarter</button>
          <button class="btn sm ghost" data-a="clock" data-g="${g.id}" data-c="reset">Reset to 0:00</button>
          <button class="btn sm ghost" data-a="clock" data-g="${g.id}" data-c="off">Turn clock off</button>
        </div>
      </details>
      ${cast}
    </div>`;
}

// Tick every clock on screen without re-rendering the page.
setInterval(() => {
  if (!S.db) return;
  document.querySelectorAll('[data-clock-for]').forEach((el) => {
    const g = S.db.games.find((x) => x.id === el.dataset.clockFor);
    if (g?.clock) el.textContent = formatClock(clockElapsed(g.clock, Date.now()));
  });
}, 500);

const castGame = (q) => {
  const id = q?.get?.('g');
  const games = S.db.games;
  return (id && games.find((g) => g.id === id)) || gamesSorted().find((g) => g.status === 'live') || null;
};

function viewCast(q) {
  const wanted = q?.get?.('g') || null;
  S.after = () => {
    S.castHash = location.hash || '#/';
    const g0 = castGame(q);
    S.cast = new CastView($('#cast-root'), {
      exitHref: g0 ? `#/g/${g0.id}` : '#/',
      name: nick,
      live: () => S.live,
      getState: () => {
        const g = wanted ? S.db.games.find((x) => x.id === wanted) : castGame(null);
        if (!g) return { found: false };
        return {
          found: true, gameId: g.id, status: g.status, clock: g.clock || null,
          teams: { A: teamName(g, 'A'), B: teamName(g, 'B') },
          score: { ...gameInfo(g).summary.score }, events: g.events,
        };
      },
    });
    // Firebase: watch for a dropped connection while filming (one tiny listener). The first
    // answer always comes from the phone's cache, so only trust "offline" once the server
    // has answered at least once, or after a few seconds without hearing from it.
    if (!S.backend?.watchConnection) return; // local server: the live stream reports drops itself
    let heard = false;
    const lost = () => { if (!S.live.dead) setLive(false, 'Connection lost. Reconnecting… the score may be behind'); };
    const grace = setTimeout(() => { if (!heard) lost(); }, 5000);
    const unwatch = S.backend.watchConnection((ok) => {
      if (ok) { heard = true; if (!S.live.dead) setLive(navigator.onLine, navigator.onLine ? '' : 'No signal. The score may be behind'); } else if (heard) lost();
    });
    S.castConn = () => { clearTimeout(grace); unwatch(); };
  };
  return '<div id="cast-root"></div>';
}

function liveSection(g) {
  const info = gameInfo(g);
  const events = [...g.events].reverse();
  return `
    ${scoreboard(g)}
    ${clockBar(g)}
    ${momentumChart(g)}
    <div class="muted small center">📝 Everyone keeps score: log any play you see, including your own.</div>
    ${logger(g)}
    ${sec('Play by play', `<span class="sec-link muted">${events.length} logged</span>`)}
    ${events.length ? `<ul class="feed">${events.map((ev) => eventRow(g, ev, true)).join('')}</ul>` : `<div class="empty-inline">${ART.whistle}<span>No plays logged yet. Pick a play type above to start.</span></div>`}
    <details class="card-lite"><summary>Rosters & live box score</summary>${boxScore(g, info)}</details>
    <button class="btn block danger-outline" data-a="final" data-g="${g.id}">Final whistle</button>`;
}

// ---------------------------------------------------------------------------
// Voice logging: tap the mic once, then just say plays ("Kellen to Max, touchdown").
// It keeps listening until you tap stop, so the logger never has to look at the phone.

const SpeechRec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const V = { rec: null, on: false, gameId: null, heard: '', status: '', last: null, error: '' };

function voiceRoster(g) {
  return ['A', 'B'].flatMap((side) => g.teams[side].map((id) => {
    const p = P(id);
    return { id, team: side, names: [p.name, p.name.split(' ')[0], p.nickname].filter(Boolean) };
  }));
}

function voiceBar(g) {
  if (!SpeechRec) return '';
  const live = V.on && V.gameId === g.id;
  if (!live) {
    return `<button class="btn block voice-btn" data-a="voice-start" data-g="${g.id}">🎤 Log by voice <small>hands-free</small></button>`;
  }
  const last = V.last;
  return `
    <div class="voice-live" role="status" aria-live="polite">
      <div class="row-between">
        <span class="voice-dot"></span><b class="grow">Listening…</b>
        <button class="btn sm ghost" data-a="voice-stop">Stop</button>
      </div>
      <div class="voice-heard">${V.heard ? `“${h(V.heard)}”` : `<span class="muted">Try “${h(VOICE_EXAMPLES[Math.floor(Date.now() / 8000) % VOICE_EXAMPLES.length])}”</span>`}</div>
      ${V.error ? `<div class="voice-err">${h(V.error)}</div>` : ''}
      ${last ? `<div class="voice-last"><span class="grow">✅ ${describeEvent(last.ev)}</span><button class="btn sm ghost" data-a="voice-undo">↶ Undo</button></div>` : ''}
    </div>`;
}

function voiceStart(gameId) {
  if (!SpeechRec) return toast("This phone's browser can't do voice. Try Chrome or Safari", true);
  voiceStop();
  Object.assign(V, { on: true, gameId, heard: '', error: '', last: null });
  const rec = new SpeechRec();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) { V.heard = r[0].transcript; voiceRefresh(); continue; }
      // try each alternative the recognizer offers until one parses
      const g = S.db.games.find((x) => x.id === V.gameId);
      if (!g) return voiceStop();
      let parsed = null;
      for (let k = 0; k < r.length && !parsed?.p1; k++) { const x = parsePlay(r[k].transcript, voiceRoster(g)); if (!parsed || x.p1) parsed = x; }
      V.heard = r[0].transcript;
      if (parsed.error) { V.error = parsed.error; navigator.vibrate?.([60, 60, 60]); voiceRefresh(); continue; }
      V.error = '';
      voiceLog(g, parsed);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { V.error = 'Microphone is blocked. Allow it in your browser settings.'; V.on = false; }
    else if (e.error !== 'no-speech' && e.error !== 'aborted') V.error = `Voice hiccup (${e.error}). Still listening.`;
    voiceRefresh();
  };
  // Phones stop listening after a pause; keep going until they tap Stop.
  rec.onend = () => { if (V.on && V.rec === rec) { try { rec.start(); } catch { /* already restarting */ } } };
  V.rec = rec;
  try { rec.start(); } catch (err) { V.error = err.message; }
  render();
}

function voiceStop() {
  const rec = V.rec;
  V.on = false; V.rec = null;
  try { rec?.abort(); } catch { /* not running */ }
}

async function voiceLog(g, { type, p1, p2 }) {
  const t = E.EVENT_TYPES[type];
  try {
    const ev = await api('POST', `/api/games/${g.id}/events`, { type, p1, p2, by: me() });
    V.last = { ev: ev || { type, p1, p2 }, gameId: g.id };
    V.heard = '';
    navigator.vibrate?.(t.points ? [80, 40, 160] : 60);
    const game = S.db.games.find((x) => x.id === g.id);
    const sc = gameInfo(game).summary.score;
    toast(`🎤 ${t.emoji} ${t.label}: ${nick(p1)}${p2 ? ` / ${nick(p2)}` : ''}${t.points ? ` · ${sc.A}–${sc.B}` : ''}`);
  } catch (e) {
    V.error = e.message;
  }
  voiceRefresh();
}

// Update just the voice panel so the play-by-play doesn't jump around while talking.
function voiceRefresh() {
  const el = document.querySelector('.voice-live');
  const g = S.db.games.find((x) => x.id === V.gameId);
  if (!el || !g) { render(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = voiceBar(g);
  if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild); else render();
}

function logger(g) {
  const L = S.log?.gameId === g.id ? S.log : null;
  if (!L?.type) {
    return `
      ${voiceBar(g)}
      <div class="log-grid">
        ${Object.entries(E.EVENT_TYPES).map(([k, t]) => `<button class="log-btn ${t.points ? 'score' : ''} t-${k}" data-a="log-type" data-g="${g.id}" data-t="${k}"><span>${t.emoji}</span>${h(t.label)}</button>`).join('')}
      </div>`;
  }
  const t = E.EVENT_TYPES[L.type];
  const step = L.p1 ? 1 : 0;
  let sides = ['A', 'B'];
  if (step === 1) {
    const t1 = E.teamOf(g, L.p1);
    sides = [t.side === 'same' ? t1 : t1 === 'A' ? 'B' : 'A'];
  }
  return `
    <div class="log-step">
      <div class="log-q"><span>${t.emoji} ${h(t.label)}</span> — ${h(t.prompts[step])}?</div>
      <div class="log-cols ${sides.length === 1 ? 'one' : ''}">
        ${sides.map((side) => `
          <div>
            <div class="chips-label">${h(teamName(g, side))}</div>
            ${g.teams[side].filter((id) => id !== L.p1).sort((a, b) => (b === me()) - (a === me())).map((id) => `<button class="log-player ${id === me() ? 'is-me' : ''}" data-a="log-pick" data-p="${id}">${avatar(id, 'xs')} ${h(nick(id))}${id === me() ? ' <small>(you)</small>' : ''}</button>`).join('')}
          </div>`).join('')}
      </div>
      <div class="btn-row">
        <button class="btn ghost" data-a="log-cancel">Cancel</button>
        ${step === 1 && !t.required ? `<button class="btn ghost grow" data-a="log-skip">Skip — not sure</button>` : ''}
      </div>
    </div>`;
}

function eventRow(g, ev, editable) {
  const side = ev.team || E.teamOf(g, ev.p1);
  return `
    <li class="ev ev-${side}">
      <span class="ev-team">${h(teamName(g, side).slice(0, 3).toUpperCase())}</span>
      <span class="ev-body">${describeEvent(ev)}${ev.by ? `<span class="ev-by">logged by ${h(ev.by === me() ? 'you' : nick(ev.by))}</span>` : ''}</span>
      <a class="ev-act" href="#/fame/new?g=${g.id}&e=${ev.id}" title="Save to the Hall of Fame">🏛️</a>
      ${editable ? `<button class="ev-act" data-a="undo-event" data-g="${g.id}" data-e="${ev.id}" title="Delete this play">✕</button>` : ''}
    </li>`;
}

function boxScore(g, info) {
  const { summary, ratingChanges } = info;
  return `<div class="box">${['A', 'B'].map((side) => `
    <div class="box-team">
      <div class="box-head ${summary.winner === side ? 'win' : ''}">${h(teamName(g, side))} <b>${summary.score[side]}</b></div>
      ${g.teams[side].map((id) => {
        const d = ratingChanges?.[id];
        return `<a class="box-row" href="#/p/${id}">${avatar(id, 'xs')}<span class="box-name">${h(nick(id))}</span>
          <span class="box-line">${statLine(summary.stats[id])}</span>
          ${d !== undefined ? deltaTag(d) : ''}</a>`;
      }).join('')}
    </div>`).join('')}</div>`;
}

function finalSection(g) {
  const info = gameInfo(g);
  return `
    ${scoreboard(g)}
    ${momentumChart(g)}
    ${recapCard(g)}
    ${mvpBlock(g)}
    ${sec('Box score')}
    ${boxScore(g, info)}
    <p class="muted small">▲▼ = OVR change from this game (result vs. the odds, plus how much he balled out).</p>
    <details class="card-lite"><summary>Play by play (${g.events.length})</summary>
      <ul class="feed">${[...g.events].reverse().map((ev) => eventRow(g, ev, !!me() && ev.by === me())).join('')}</ul>
    </details>
    <details class="card-lite" ${S.log?.gameId === g.id ? 'open' : ''}><summary>Add a play that didn't get logged</summary>
      <p class="muted small">Forgot to log something? Add it here. Stats, ratings and awards update automatically.</p>
      ${logger(g)}
    </details>
    <a class="btn block" href="#/wall">Talk trash about this one ›</a>`;
}

function mvpBlock(g) {
  const info = gameInfo(g);
  const tally = info.mvp || E.tallyMvp(g, info.summary);
  const m = me();
  const played = m && E.teamOf(g, m);
  const myVote = m ? g.mvpVotes[m] : null;
  const max = Math.max(1, ...tally.ranked.map((r) => r.votes));
  return `
    <div class="mvp">
      <div class="mvp-head">
        <div><div class="kicker gold">MVP of the day</div><h3 class="mvp-name">${tally.winner ? h(nick(tally.winner)) : 'Voting open'}</h3></div>
        ${tally.winner ? `<span class="crown">${avatar(tally.winner, 'lg')}</span>` : ''}
      </div>
      ${tally.ranked.length ? tally.ranked.slice(0, 5).map((r) => `
        <div class="vote-row">${avatar(r.id, 'xs')}<span class="vr-name">${h(nick(r.id))}</span>
          <span class="vr-bar"><span style="width:${(r.votes / max) * 100}%"></span></span><b>${r.votes}</b></div>`).join('') : '<p class="muted small">No votes yet.</p>'}
      ${played ? `
        <div class="chips-label">${myVote ? 'Your vote (tap to change)' : 'Cast your vote'}</div>
        <div class="chips">${[...g.teams.A, ...g.teams.B].filter((id) => id !== m).map((id) => `
          <button class="pchip ${myVote === id ? 'in' : ''}" data-a="mvp" data-g="${g.id}" data-p="${id}">${avatar(id, 'xs')} ${h(nick(id))}</button>`).join('')}
        </div>` : `<p class="muted small">${m ? 'Only guys who played can vote.' : 'Pick who you are to vote.'}</p>`}
      <div class="muted small">${tally.total} vote${tally.total === 1 ? '' : 's'} in</div>
    </div>`;
}

function gameAdmin(g) {
  return `
    <details class="card-lite admin">
      <summary>⚙️ Edit game</summary>
      <form data-f="game-edit" data-g="${g.id}" class="form">
        <div class="form-row">
          <label>Date <input type="date" name="date" value="${h(g.date)}" required></label>
          <label>Time <input type="time" name="time" value="${h(g.time)}"></label>
        </div>
        <label>Location <input name="location" maxlength="80" value="${h(g.location)}"></label>
        <div class="form-row">
          <label>Team 1 <input name="teamA" maxlength="24" value="${h(teamName(g, 'A'))}"></label>
          <label>Team 2 <input name="teamB" maxlength="24" value="${h(teamName(g, 'B'))}"></label>
        </div>
        <label>Season <input name="season" maxlength="20" value="${h(g.season)}"></label>
        <button class="btn">Save changes</button>
      </form>
      ${g.status === 'final' ? `<button class="btn ghost block" data-a="reopen" data-g="${g.id}">↩ Reopen game to fix stats</button>` : ''}
      <button class="btn ghost block danger" data-a="delete-game" data-g="${g.id}">🗑 Delete game</button>
    </details>`;
}

function viewNewGame() {
  const last = gamesSorted().reverse()[0];
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); // next Saturday
  const sat = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `
    <a class="back" href="#/">‹ Games</a>
    <section class="card">
      <h2>Schedule a game</h2>
      <form data-f="game" class="form">
        <div class="form-row">
          <label>Date <input type="date" name="date" value="${sat}" required></label>
          <label>Time <input type="time" name="time" value="${h(last?.time || '18:00')}"></label>
        </div>
        <label>Location <input name="location" maxlength="80" placeholder="The usual field" value="${h(last?.location || '')}"></label>
        <div class="form-row">
          <label>Team 1 <input name="teamA" maxlength="24" value="Shirts"></label>
          <label>Team 2 <input name="teamB" maxlength="24" value="Skins"></label>
        </div>
        <button class="btn hot block">Put it on the schedule</button>
      </form>
    </section>`;
}

// ---------------------------------------------------------------------------
// Stats

const STAT_TABS = {
  mvp: '👑 MVP Race', tds: '🏈 TDs', qb: '🎯 QB Rating', record: '📈 Record', rec: '🙌 Receiving', def: '🦅 Defense', clutch: '🧊 Clutch', ovr: '⭐ Ratings',
};

function viewStats() {
  const season = S.season === 'career' ? null : S.season;
  const table = E.seasonTable(S.db, S.league, season);
  const rows = Object.entries(table).map(([id, s]) => ({ id, s }));
  const tab = S.statTab;
  const medal = rankBadge;
  let cols = [], list = [], note = '';
  const record = (s) => `${s.w}-${s.l}${s.t ? `-${s.t}` : ''}`;
  if (tab === 'mvp') {
    list = rows.filter((r) => r.s.gp).sort((a, b) => E.mvpScore(b.s) - E.mvpScore(a.s));
    cols = [['Pts', (s) => Math.round(E.mvpScore(s))], ['👑', (s) => s.mvps], ['Rec', record], ['TD', E.totalTDs]];
    note = 'MVP points = stat impact + 10 per crowd MVP + 2 per win.';
  } else if (tab === 'tds') {
    list = rows.filter((r) => E.totalTDs(r.s) || r.s.passTD).sort((a, b) => E.totalTDs(b.s) - E.totalTDs(a.s) || b.s.passTD - a.s.passTD);
    cols = [['TD', E.totalTDs], ['Rec', (s) => s.recTD], ['Rush', (s) => s.rushTD], ['Def', (s) => s.defTD], ['Pass', (s) => s.passTD]];
    note = 'TD = touchdowns scored. Pass = TD passes thrown.';
  } else if (tab === 'qb') {
    list = rows.filter((r) => r.s.att >= 5).sort((a, b) => E.qbRating(b.s) - E.qbRating(a.s));
    cols = [['Rtg', (s) => E.qbRating(s).toFixed(1)], ['C/A', (s) => `${s.comp}/${s.att}`], ['TD', (s) => s.passTD], ['INT', (s) => s.intThrown], ['Sk', (s) => s.sacked]];
    note = 'Passer rating without yards (max 158.3). Min 5 attempts.';
  } else if (tab === 'record') {
    list = rows.filter((r) => r.s.gp).sort((a, b) => (b.s.w + b.s.t / 2) / b.s.gp - (a.s.w + a.s.t / 2) / a.s.gp || b.s.w - a.s.w);
    cols = [['W-L', record], ['Win%', (s) => pct((s.w + s.t / 2) / s.gp)], ['GP', (s) => s.gp]];
  } else if (tab === 'rec') {
    list = rows.filter((r) => r.s.targets).sort((a, b) => b.s.rec - a.s.rec || b.s.recTD - a.s.recTD);
    cols = [['Rec', (s) => s.rec], ['Tgt', (s) => s.targets], ['Ctch%', (s) => pct(s.rec / s.targets)], ['TD', (s) => s.recTD], ['🧈', (s) => s.drops]];
    note = '🧈 = drops. Everybody can see them. Forever.';
  } else if (tab === 'def') {
    list = rows.filter((r) => r.s.defInt || r.s.sacks).sort((a, b) => (b.s.defInt * 5 + b.s.sacks * 3 + b.s.defTD * 6) - (a.s.defInt * 5 + a.s.sacks * 3 + a.s.defTD * 6));
    cols = [['INT', (s) => s.defInt], ['Pick6', (s) => s.defTD], ['Sacks', (s) => s.sacks]];
  } else if (tab === 'clutch') {
    const ct = season ? clutchTable(S.db, season) : S.clutch.career;
    list = Object.entries(ct).filter(([id]) => P(id)).map(([id, c]) => ({ id, s: table[id] || E.blankStats(), c })).sort((a, b) => b.c.score - a.c.score || b.c.big - a.c.big);
    cols = [['Clutch', (s, id, r) => `<b>${r.c.score > 0 ? '+' : ''}${r.c.score}</b>`], ['Big', (s, id, r) => r.c.big], ['Chokes', (s, id, r) => r.c.chokes], ['Games', (s, id, r) => r.c.games]];
    note = 'Clutch plays happen in a one-score game (7 or less) in the last 40% of the plays. TD catch +3, TD run +3, TD pass +2, pick-six +4, INT +3, sack +2. Throwing a pick −3, dropping one −2.';
  } else if (tab === 'ovr') {
    list = activePlayers().map((p) => ({ id: p.id, s: table[p.id] || E.blankStats() })).sort((a, b) => ovr(b.id) - ovr(a.id));
    cols = [
      ['OVR', (s, id) => `<b class="g-${grade(ovr(id))}">${ovr(id)}</b>`],
      ['Pos', (s, id) => h(P(id).position || 'ATH')],
      ['+/-', (s, id) => {
        const hist = S.league.history[id] || [];
        const last = hist[hist.length - 1];
        return last?.delta ? deltaTag(last.delta) : '—';
      }],
      ...E.ATTRS.map((at) => [at.short, (s, id) => `<span class="g-${grade(attrsOf(id)[at.key])}">${attrsOf(id)[at.key]}</span>`]),
    ];
    note = 'OVR comes from the seventeen ratings, weighted by position. <a href="#/key">Ratings key ›</a> · <a href="#/ratings">Rate players ›</a>';
  }
  return `
    ${pageHead(S.season === 'career' ? 'All-time' : `Season ${h(S.season)}`, 'Leaderboards', `
      <a class="btn sm ghost" href="#/awards">🏅 Awards</a>
      <a class="btn sm ghost" href="#/wrapped">🎁 Wrapped</a>
      <select class="pill-select" data-ch="season" aria-label="Season">
        ${seasons().map((s) => `<option value="${h(s)}" ${S.season === s ? 'selected' : ''}>Season ${h(s)}</option>`).join('')}
        <option value="career" ${S.season === 'career' ? 'selected' : ''}>Career</option>
      </select>`)}
    <div class="tabs-scroll">${Object.entries(STAT_TABS).map(([k, l]) => `<button class="tab-chip ${tab === k ? 'on' : ''}" data-a="stat-tab" data-t="${k}">${l}</button>`).join('')}</div>
    ${list.length ? `
      <div class="lb-wrap"><table class="lb">
        <thead><tr><th></th><th class="l">Player</th>${cols.map(([c]) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${list.map((r, i) => `
          <tr class="${r.id === me() ? 'me' : ''} ${i < 3 ? `lb-podium lb-${i + 1}` : ''}">
            <td class="medal">${medal(i)}</td>
            <td class="l"><a href="#/p/${r.id}">${avatar(r.id, 'xs')} ${h(nick(r.id))}</a></td>
            ${cols.map(([, f]) => `<td>${f(r.s, r.id, r)}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<section class="card">${empty({ art: 'chart', title: 'No stats yet', text: 'Finish a game with a few plays logged and the leaderboards fill themselves in.' })}</section>`}
    ${note ? `<p class="muted small">${note}</p>` : ''}`;
}

// ---------------------------------------------------------------------------
// Player cards

function careerOf(id) {
  return E.seasonTable(S.db, S.league, null)[id] || E.blankStats();
}

function gameLog(id) {
  return gamesSorted().filter((g) => g.status === 'final' && E.teamOf(g, id)).reverse().map((g) => {
    const info = gameInfo(g);
    const side = E.teamOf(g, id);
    const res = info.summary.winner === 'tie' ? 'T' : info.summary.winner === side ? 'W' : 'L';
    return { g, info, side, res, stats: info.summary.stats[id], delta: info.ratingChanges?.[id] ?? 0, mvp: info.mvp?.winner === id };
  });
}

function clutchLeader() {
  const best = Object.entries(S.clutch.season).filter(([id, c]) => P(id) && c.score > 0 && c.big >= 2).sort((a, b) => b[1].score - a[1].score)[0];
  return best?.[0] || null;
}

function formIcon(id) {
  const f = S.form[id];
  if (f?.hot) return `<span class="form-ic hot" title="TDs in ${f.hot} straight games">🔥${f.hot > 3 ? `<small>${f.hot}</small>` : ''}</span>`;
  if (f?.cold) return `<span class="form-ic cold" title="${f.cold} straight games with a drop or pick">❄️</span>`;
  return '';
}

function badges(id) {
  const c = careerOf(id);
  const log = gameLog(id);
  let streak = 0;
  for (const x of log) { if (x.res === 'W') streak++; else break; }
  const out = [];
  if (c.mvps) out.push(`👑 ${c.mvps}× MVP`);
  if (S.db.fame.some((f) => f.category === 'best' && f.playerIds.includes(id))) out.push('🏛️ Hall of Famer');
  if (streak >= 3) out.push(`🏆 ${streak}-game win streak`);
  const cl = S.clutch.career[id];
  if (cl && cl.score >= 15) out.push('🧊 Mr. Clutch');
  if (clutchLeader() === id) out.push(`🧊 Season ${S.db.settings.season} Clutch leader`);
  if (c.defInt >= 3) out.push('🦅 Ball Hawk');
  if (c.sacks >= 4) out.push('💥 QB Hunter');
  if (E.totalTDs(c) >= 5) out.push('🏈 End Zone Regular');
  if (c.drops >= 3) out.push('🧈 Butter Hands');
  if (S.db.fame.some((f) => f.category !== 'best' && f.playerIds.includes(id))) out.push('🤡 Hall of Shame');
  const a = S.awards.byPlayer[id];
  if (a) {
    const aw = { mvp: '👑 {s} MVP', improved: '📈 {s} Most Improved', butter: '🧈 {s} Butterfingers' };
    for (const x of a.awards) out.unshift(aw[x.key].replace('{s}', x.season));
    if (a.potw.length) out.unshift(`🔥 ${a.potw.length > 1 ? `${a.potw.length}× ` : ''}Player of the Week`);
    // the biggest milestone reached in each category
    const top = {};
    for (const m of a.milestones) if (!top[m.key] || m.n > top[m.key].n) top[m.key] = m;
    for (const m of Object.values(top)) if (m.n >= 10) out.push(`${m.emoji} ${m.label}`);
  }
  const f = S.form[id];
  if (f?.hot) out.unshift(`🔥 On fire: TDs in ${f.hot} straight games`);
  if (f?.cold) out.unshift(`❄️ Ice cold: ${f.cold} straight games with a drop or pick`);
  return out;
}

function tradingCard(id, { mini = false } = {}) {
  const p = P(id);
  const o = ovr(id);
  const a = attrsOf(id);
  const s = E.seasonTable(S.db, S.league, S.db.settings.season)[id] || E.blankStats();
  const front = `
    <div class="tc-face tc-front">
      ${S.form[id]?.hot || S.form[id]?.cold ? '<i class="form-fx" aria-hidden="true"></i>' : ''}
      <div class="tc-top">
        <div class="tc-ovr">${o}<small>OVR</small></div>
        ${formIcon(id)}
        <div class="tc-pos">${h(p.position || 'ATH')}${p.number !== '' && p.number !== undefined ? `<small>#${h(p.number)}</small>` : ''}</div>
      </div>
      ${(() => {
        const ph = photoOf(p);
        const bg = photoBg(ph);
        return ph
          ? `<div class="tc-art has-photo" style="--c:${h(p.color || '#ff6b1a')}${bg.style}"${bg.attr}></div>`
          : `<div class="tc-art" style="--c:${h(p.color || '#ff6b1a')}">${p.number !== '' && p.number !== undefined ? `<i class="tc-num">${h(p.number)}</i>` : ''}<span>${h(p.emoji || initials(p.name))}</span></div>`;
      })()}
      <div class="tc-name">${h(p.name)}</div>
      ${p.nickname ? `<div class="tc-nick">“${h(p.nickname)}”</div>` : '<div class="tc-nick">&nbsp;</div>'}
      ${bioLine(p) ? `<div class="tc-bio">${h(bioLine(p))}</div>` : ''}
      <div class="tc-stats">
        ${E.keyAttrs(p.position).map((k) => `<div><b class="g-${grade(a[k])}">${a[k]}</b><small>${attrMeta[k].short}</small><em>${h(attrMeta[k].label)}</em></div>`).join('')}
      </div>
      <div class="tc-foot">HFL · ${h(S.db.settings.season)}</div>
    </div>`;
  const design = cardDesign(S.awards, p);
  const f = S.form[id];
  const cls = `tier-${tier(o)}${design ? ` design-${design}` : ''}${f?.hot ? ' form-hot' : f?.cold ? ' form-cold' : ''}`;
  if (mini) return `<a href="#/p/${id}" class="tcard mini ${cls}">${front}</a>`;
  const back = `
    <div class="tc-face tc-back">
      <div class="tc-back-title">${h(p.nickname || p.name)}</div>
      <div class="tc-sub">Key ratings · ${h(p.position || 'ATH')}</div>
      <div class="tc-attrs">${E.keyAttrs(p.position, 6).map((k) => attrBar(k, a[k], null, { label: true })).join('')}</div>
      <div class="tc-sub">Season ${h(S.db.settings.season)}</div>
      <div class="tc-season">
        <div><b>${s.gp}</b><small>GP</small></div>
        <div><b>${s.w}-${s.l}${s.t ? `-${s.t}` : ''}</b><small>W-L</small></div>
        <div><b>${E.totalTDs(s)}</b><small>TD</small></div>
        <div><b>${s.mvps}</b><small>MVP</small></div>
        ${(p.position === 'QB' || s.att > s.targets
          ? [[`${s.comp}/${s.att}`, 'C/A'], [s.passTD, 'Pass TD'], [s.intThrown, 'INT thr'], [s.att >= 5 ? E.qbRating(s).toFixed(0) : '—', 'QB Rtg']]
          : [[s.rec, 'Rec'], [s.drops, 'Drops'], [s.defInt, 'INT'], [s.sacks, 'Sacks']]
        ).map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('')}
      </div>
      ${(() => {
        const acc = badges(id).slice(0, 3);
        return acc.length ? `<div class="tc-sub">Accolades</div><div class="tc-acc">${acc.map((x) => `<span>${h(x)}</span>`).join('')}</div>` : '';
      })()}
      <div class="tc-foot">tap to flip</div>
    </div>`;
  return `<div class="tcard big ${cls}" data-a="flip"><div class="tc-inner">${front}${back}</div></div>`;
}

function viewCards() {
  const list = activePlayers().sort((a, b) => ovr(b.id) - ovr(a.id));
  return `
    ${pageHead(`${list.length} on the roster`, 'Player cards', '<div class="btn-row tight"><a class="btn sm ghost" href="#/key">Ratings key</a><a class="btn sm" href="#/new-player">+ Player</a></div>')}
    ${list.length ? `<div class="card-grid">${list.map((p) => tradingCard(p.id, { mini: true })).join('')}</div>` : `<section class="card">${empty({ art: 'cards', title: 'No cards printed yet', text: 'Add your crew and everyone gets a card that levels up with every game.', cta: '<a class="btn hot" href="#/new-player">Add a player</a>' })}</section>`}`;
}

function ratingsSection(id, log) {
  const p = P(id);
  const a = attrsOf(id);
  const last = log.find((x) => x.info.attrChanges?.[id]);
  const changes = last?.info.attrChanges[id] || {};
  const byPos = E.positionOveralls(a);
  const best = Object.entries(byPos).sort((x, y) => y[1] - x[1])[0][0];
  const order = [...E.keyAttrs(p.position, 9), ...E.ATTR_KEYS.filter((k) => !E.keyAttrs(p.position, 9).includes(k))];
  return `
    <section class="card">
      <div class="row-between"><h3>Ratings</h3>${keyLink('What these mean')}</div>
      ${bioLine(p) ? `<div class="bio-row">${p.heightIn ? `<span><small>Height</small><b>${h(fmtHeight(p.heightIn))}</b></span>` : ''}${p.weightLb ? `<span><small>Weight</small><b>${p.weightLb} <em>lbs</em></b></span>` : ''}</div>` : ''}
      ${last ? `<p class="muted small">+/− = change from his last game (${h(fmtDate(last.g.date, { month: 'short', day: 'numeric' }))})</p>` : ''}
      <div class="attr-list">${order.map((k) => attrBar(k, a[k], last ? changes[k] : null, { label: true })).join('')}</div>
      <div class="chips-label">OVR at every position</div>
      <div class="pos-ovrs">${Object.entries(byPos).map(([pos, o]) => `
        <span class="pos-ovr ${pos === (p.position || 'ATH') ? 'cur' : ''} ${pos === best ? 'best' : ''}"><small>${pos}</small><b class="g-${grade(o)}">${o}</b></span>`).join('')}
      </div>
      <p class="muted small">Plays ${h(p.position || 'ATH')}${best !== (p.position || 'ATH') ? `, but his ratings fit <b>${best}</b> best` : ''}. Ratings move after every game: catches build CTH, drops cost it, picks build MCV, sacks build TAK, and beating the odds lifts everyone a little.</p>
    </section>`;
}

// "Who would he be in the NFL?" (see nfl.js)
function nflSection(id) {
  const p = P(id);
  const { flat, comps } = nflComps(attrsOf(id), { position: p.position, heightIn: p.heightIn, weightLb: p.weightLb });
  if (flat) {
    return `
      <section class="card nfl">
        <h3>NFL comp</h3>
        <p class="muted small">His ratings are all about the same, so there's no style to match yet. It shows up once he's rated in Rate players or has a few games in.</p>
      </section>`;
  }
  const [best, ...rest] = comps;
  const why = (c) => c.shared.map((k) => attrMeta[k].label.toLowerCase()).join(' and ');
  return `
    <section class="card nfl">
      <div class="row-between"><h3>NFL comp</h3><span class="muted small">if he were in the league</span></div>
      <div class="nfl-best">
        <span class="nfl-match"><b>${best.match}%</b><small>match</small></span>
        <div class="grow"><div class="kicker gold">Plays like</div><div class="nfl-name">${h(best.name)}</div><div class="muted small">${h(best.pos)} · ${h(best.style)}</div></div>
      </div>
      ${why(best) ? `<p class="small nfl-why">Why: his ${h(why(best))} ${best.shared.length > 1 ? 'stand' : 'stands'} out, same as ${h(best.name.split(' ').at(-1))}'s.</p>` : ''}
      <div class="chips-label">Also reminds us of</div>
      <div class="chips">${rest.map((c) => `<span class="pchip">${h(c.name)} <b>${c.match}%</b></span>`).join('')}</div>
      <p class="muted small">Based on what he's best at compared with the rest of his game${p.heightIn || p.weightLb ? ', plus his height and weight' : ''}, not how high his ratings are. Changes as his ratings do.</p>
    </section>`;
}

function careerSection(id) {
  const c = careerOf(id);
  if (!c.gp) return '';
  const qbr = E.qbRating(c);
  return `
    <section class="card">
      <h3>Career</h3>
      <table class="tc-table career">
        <tr><td>Games</td><td>${c.gp}</td><td>Record</td><td>${c.w}-${c.l}${c.t ? `-${c.t}` : ''}</td></tr>
        <tr><td>TDs</td><td>${E.totalTDs(c)}</td><td>MVPs</td><td>${c.mvps}</td></tr>
        <tr><td>Pass</td><td>${c.comp}/${c.att}</td><td>QB Rtg</td><td>${qbr === null ? '—' : qbr.toFixed(1)}</td></tr>
        <tr><td>Pass TD</td><td>${c.passTD}</td><td>INT thr</td><td>${c.intThrown}</td></tr>
        <tr><td>Catches</td><td>${c.rec}</td><td>Drops</td><td>${c.drops}</td></tr>
        <tr><td>INTs</td><td>${c.defInt}</td><td>Sacks</td><td>${c.sacks}</td></tr>
        ${(() => { const cl = S.clutch.career[id]; return cl ? `<tr><td>🧊 Clutch</td><td>${cl.score > 0 ? '+' : ''}${cl.score}</td><td>Big / chokes</td><td>${cl.big} / ${cl.chokes}</td></tr>` : ''; })()}
      </table>
    </section>`;
}

function progressionSection(id) {
  const season = S.db.settings.season;
  const games = gamesSorted().filter((g) => g.status === 'final' && g.season === season && S.league.games[g.id]?.attrChanges?.[id]);
  if (!games.length) return '';
  const sum = Object.fromEntries(E.ATTR_KEYS.map((k) => [k, 0]));
  for (const g of games) for (const k of E.ATTR_KEYS) sum[k] += S.league.games[g.id].attrChanges[id][k] || 0;
  const ovrGain = games.reduce((t, g) => t + (S.league.games[g.id].ratingChanges?.[id] || 0) / 10, 0);
  const moves = E.ATTR_KEYS.map((k) => [k, sum[k]]).filter(([, v]) => Math.abs(v) >= 0.05).sort((a, b) => b[1] - a[1]);
  const up = moves.filter(([, v]) => v > 0).slice(0, 3);
  const down = moves.filter(([, v]) => v < 0).slice(-2).reverse();
  const chip = ([k, v]) => `<span class="prog-chip ${v > 0 ? 'up' : 'down'}"><b>${attrMeta[k].short}</b> ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}</span>`;
  return `
    <section class="card">
      <div class="row-between"><h3>Progression</h3><span class="muted small">Season ${h(season)} · ${games.length} game${games.length > 1 ? 's' : ''}</span></div>
      <div class="prog-ovr">${deltaTag(ovrGain * 10)} <span class="muted">OVR from games this season</span></div>
      ${up.length ? `<div class="chips-label">Biggest gains</div><div class="chips">${up.map(chip).join('')}</div>` : ''}
      ${down.length ? `<div class="chips-label">Slipping</div><div class="chips">${down.map(chip).join('')}</div>` : ''}
    </section>`;
}

function awardsSection(id) {
  const a = S.awards.byPlayer[id];
  if (!a || (!a.potw.length && !a.awards.length && !a.milestones.length)) return '';
  const aw = { mvp: ['👑', 'Season MVP'], improved: ['📈', 'Most Improved'], butter: ['🧈', 'Butterfingers'] };
  const rows = [
    ...a.awards.map((x) => ({ icon: aw[x.key][0], title: `${x.season} ${aw[x.key][1]}`, sub: x.note, date: `${x.season}-12-31` })),
    ...a.potw.map((x) => ({ icon: '🔥', title: 'Player of the Week', sub: `Week of ${fmtDate(x.week, { month: 'short', day: 'numeric' })} · ${statLine(x.stats)}`, date: x.week })),
    ...a.milestones.map((m) => ({ icon: m.emoji, title: m.label, sub: fmtDate(m.date, { month: 'short', day: 'numeric', year: 'numeric' }), date: m.date, href: `#/g/${m.gameId}` })),
  ].sort((x, y) => (y.date > x.date ? 1 : -1));
  return `
    <section class="card">
      <div class="row-between"><h3>Awards & milestones</h3><a class="sec-link" href="#/awards">All awards ›</a></div>
      <div class="trophy-list">${rows.slice(0, 12).map((x) => `
        <${x.href ? `a href="${x.href}"` : 'div'} class="trophy"><span class="trophy-ic">${x.icon}</span><span class="grow"><b>${h(x.title)}</b><span class="muted small">${h(x.sub)}</span></span></${x.href ? 'a' : 'div'}>`).join('')}
      </div>
    </section>`;
}

function designSection(id) {
  const p = P(id);
  const unlocked = S.awards.designs[id] || [''];
  const cur = cardDesign(S.awards, p);
  const mine = canEditProfile(id);
  return `
    <section class="card">
      <div class="row-between"><h3>Card designs</h3><span class="muted small">${unlocked.length} of ${DESIGNS.length} unlocked</span></div>
      <div class="design-grid">${DESIGNS.map((d) => {
        const open = unlocked.includes(d.key);
        return `<button class="design-opt design-${d.key || 'classic'} ${open ? '' : 'locked'} ${cur === d.key ? 'on' : ''}" ${open && mine ? `data-a="set-design" data-p="${id}" data-d="${d.key}"` : 'disabled'} title="${h(d.how)}">
          <span class="design-swatch tcard ${open ? `tier-${tier(ovr(id))} ${d.key ? `design-${d.key}` : ''}` : ''}"><i></i></span>
          <b>${open ? '' : '🔒 '}${d.emoji} ${h(d.name)}</b><small>${open ? (cur === d.key ? 'Wearing it' : mine ? 'Tap to wear' : 'Unlocked') : h(d.how)}</small>
        </button>`;
      }).join('')}</div>
    </section>`;
}

function recapFor(g) {
  const info = gameInfo(g);
  return buildRecap(g, info, { name: nick, statLine, milestones: S.awards.milestones });
}

function recapCard(g, { compact = false } = {}) {
  const r = recapFor(g);
  const w = r.winner;
  return `
    <article class="recap">
      <div class="recap-top"><span class="recap-brand">HFL CENTER</span><span class="muted small">${h(fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</span></div>
      ${compact ? `<a class="recap-score" href="#/g/${g.id}"><span class="${w === 'A' ? 'win' : ''}">${h(r.teams.A)} <b>${r.score.A}</b></span><span class="${w === 'B' ? 'win' : ''}"><b>${r.score.B}</b> ${h(r.teams.B)}</span></a>` : ''}
      <h3 class="recap-head">${h(r.headline)}</h3>
      ${r.goat ? `<div class="recap-goat">${avatar(r.goat.id, 'lg')}<div><div class="kicker gold">Goat of the day</div><b>${h(nick(r.goat.id))}</b><span class="muted small">${h(r.goat.line)}</span></div></div>` : ''}
      ${r.topPlays.length ? `<div class="chips-label">Top plays</div><ol class="recap-plays">${r.topPlays.map((p) => `<li><span>${p.emoji}</span>${h(p.text)}</li>`).join('')}</ol>` : ''}
      ${(() => { const sw = g.events.length ? momentumData(g).swing : null; return sw ? `<div class="chips-label">Biggest momentum swing 📈</div><p class="recap-line">${swingText(g, sw)}</p>` : ''; })()}
      ${r.worstDrop ? `<div class="chips-label">Worst drop 🧈</div><p class="recap-line">${h(r.worstDrop.text)}</p>` : ''}
      ${r.milestones.length ? `<div class="chips-label">Milestones${r.milestones.length > 4 ? ` <span class="muted">(+${r.milestones.length - 4} more)</span>` : ''}</div><div class="chips">${[...r.milestones].sort((a, b) => b.n - a.n).slice(0, 4).map((m) => `<span class="pchip">${avatar(m.id, 'xs')} ${m.emoji} ${h(nick(m.id))}: ${h(m.label)}</span>`).join('')}</div>` : ''}
      ${r.roast ? `<blockquote class="recap-roast">“${h(r.roast.text)}”</blockquote>` : ''}
      <button class="btn hot block" data-a="share-recap" data-g="${g.id}">📤 Share recap</button>
    </article>`;
}

async function shareRecap(g) {
  const r = recapFor(g);
  try {
    let goatPhoto = r.goat ? photoOf(P(r.goat.id)) : null;
    if (goatPhoto?.startsWith('fsimg:')) goatPhoto = await S.backend?.getImage(goatPhoto.slice(6));
    const gp = r.goat ? P(r.goat.id) : null;
    const blob = await recapToPngBlob(r, { name: nick, goatPhoto, goatColor: gp?.color, goatInitial: gp ? initials(gp.name) : '', crew: S.db.settings.crewName, dateLabel: fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' }) });
    const file = new File([blob], `hfl-recap-${g.date}.png`, { type: 'image/png' });
    const text = `${r.headline} (${r.teams.A} ${r.score.A}–${r.score.B} ${r.teams.B})`;
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'HFL Center', text }); return; }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Recap image downloaded. Drop it in the group chat');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not share: ' + e.message, true);
  }
}

// ---------------------------------------------------------------------------
// HFL Wrapped: a season story per player

const wrappedSeason = (q) => q?.get?.('s') || (S.season !== 'career' && wrappedSeasons(S.db).includes(S.season) ? S.season : wrappedSeasons(S.db).at(-1));

// The latest season that's over and has games: that's when Wrapped gets its banner.
function wrappedBannerSeason() {
  const done = wrappedSeasons(S.db).filter((x) => seasonOver(S.db, x));
  return done.at(-1) || null;
}

function viewWrappedPicker(q) {
  const seasonsList = wrappedSeasons(S.db);
  const season = wrappedSeason(q);
  if (!season) return `<a class="back" href="#/stats">‹ Stats</a><section class="card">${empty({ art: 'chart', title: 'Nothing to wrap yet', text: 'Wrapped shows up once a season has some finished games.' })}</section>`;
  const table = E.seasonTable(S.db, S.league, season);
  const list = Object.entries(table).filter(([id, x]) => x.gp && S.db.players.some((p) => p.id === id)).sort((a, b) => (b[0] === me()) - (a[0] === me()) || E.mvpScore(b[1]) - E.mvpScore(a[1]));
  return `
    <a class="back" href="#/stats">‹ Stats</a>
    ${pageHead(`Season ${h(season)}${seasonOver(S.db, season) ? '' : ' · so far'}`, 'HFL Wrapped', seasonsList.length > 1 ? `
      <select class="pill-select" data-ch="wrapped-season" aria-label="Season">${seasonsList.map((x) => `<option value="${h(x)}" ${x === season ? 'selected' : ''}>Season ${h(x)}</option>`).join('')}</select>` : '')}
    <p class="muted">Everyone's season as a story: your numbers, your favorite target, your nemesis, your best play. Share yours to the group chat.</p>
    <div class="wr-pick">${list.map(([id, x]) => `
      <a class="wr-pick-row ${id === me() ? 'me' : ''}" href="#/wrapped/${id}?s=${encodeURIComponent(season)}">${avatar(id, 'lg')}<span class="grow"><b>${h(nick(id))}${id === me() ? ' <small>(you)</small>' : ''}</b><span class="muted small">${x.gp} games · ${x.w}-${x.l} · ${E.totalTDs(x)} TD</span></span><span class="wr-go">▶</span></a>`).join('')}
    </div>`;
}

const WR_BG = ['wr-bg-0', 'wr-bg-1', 'wr-bg-2', 'wr-bg-3', 'wr-bg-4', 'wr-bg-5'];

function viewWrapped(id, q) {
  const season = wrappedSeason(q);
  const w = season && buildWrapped(S.db, S.league, S.awards, id, season, { name: nick });
  if (!w) return `<a class="back" href="#/wrapped">‹ Wrapped</a><section class="card">${empty({ art: 'chart', title: 'No season to wrap', text: `${h(nick(id))} didn't play a finished game in season ${h(season || '')}.` })}</section>`;
  const key = `${id}|${season}`;
  if (S.wr?.key !== key) S.wr = { key, i: 0 };
  const i = Math.min(S.wr.i, w.slides.length - 1);
  const sl = w.slides[i];
  const body = (() => {
    if (sl.kind === 'summary') {
      const x = sl.summary;
      return `
        <div class="wr-sum">
          <div class="wr-sum-head">${avatar(id, 'lg')}<div><div class="wr-kicker">${h(sl.kicker)}</div><div class="wr-sum-name">${h(x.name)}</div></div></div>
          <div class="wr-grid">${[['Record', x.record], ['TDs', x.tds], ['Catches', x.rec], ['TD passes', x.passTD], ['INTs', x.ints], ['Clutch', `${x.clutch > 0 ? '+' : ''}${x.clutch}`]].map(([l, v]) => `<div><b>${h(v)}</b><small>${l}</small></div>`).join('')}</div>
          ${x.buddy ? `<div class="wr-sum-row"><small class="t-good">Ride-or-die</small><b>${h(x.buddy)}</b></div>` : ''}
          ${x.nemesis ? `<div class="wr-sum-row"><small class="t-bad">Nemesis</small><b>${h(x.nemesis)}</b></div>` : ''}
          ${x.bestPlay ? `<div class="wr-sum-row"><small class="t-B">Best play</small><b>${h(x.bestPlay)}</b></div>` : ''}
          <button class="btn hot block" data-a="share-wrapped" data-p="${id}" data-s="${h(season)}">📤 Share my Wrapped</button>
          <a class="btn ghost block" href="#/wrapped?s=${encodeURIComponent(season)}">See the rest of the crew</a>
        </div>`;
    }
    return `
      <div class="wr-kicker">${h(sl.kicker)}</div>
      ${sl.person ? `<div class="wr-person ${sl.tone === 'bad' ? 'bad' : ''}">${avatar(sl.person, 'lg')}</div>` : ''}
      ${sl.emoji ? `<div class="wr-emoji">${sl.emoji}</div>` : ''}
      <div class="wr-big">${h(sl.big)}${sl.unit ? `<small>${h(sl.unit)}</small>` : ''}</div>
      ${sl.line ? `<p class="wr-line">${h(sl.line)}</p>` : ''}
      ${sl.items ? `<ul class="wr-items">${sl.items.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : ''}
      ${sl.gameId ? `<a class="wr-link" href="#/g/${sl.gameId}">See the game ›</a>` : ''}`;
  })();
  S.after = () => {
    clearTimeout(S.wrTimer);
    if (sl.kind !== 'summary') S.wrTimer = setTimeout(() => { if (S.wr?.key === key && location.hash.startsWith(`#/wrapped/${id}`)) { S.wr.i = i + 1; render(); } }, 6500);
  };
  return `
    <div class="wrapped ${sl.tone === 'bad' ? 'wr-bad' : WR_BG[i % WR_BG.length]}">
      <div class="wr-bars">${w.slides.map((_, k) => `<span class="${k < i ? 'done' : k === i ? 'on' : ''}"><i></i></span>`).join('')}</div>
      <div class="wr-top"><span class="wr-brand">HFL WRAPPED ${h(season)}${w.over ? '' : ' · SO FAR'}</span><a class="wr-close" href="#/p/${id}" aria-label="Close">✕</a></div>
      ${sl.kind !== 'summary' ? `<button class="wr-tap wr-prev" data-a="wr-go" data-d="-1" aria-label="Back"></button><button class="wr-tap wr-next" data-a="wr-go" data-d="1" aria-label="Next"></button>` : `<button class="wr-tap wr-prev" data-a="wr-go" data-d="-1" aria-label="Back"></button>`}
      <div class="wr-body wr-kind-${sl.kind}" key="${i}">${body}</div>
    </div>`;
}

async function shareWrapped(id, season) {
  const w = buildWrapped(S.db, S.league, S.awards, id, season, { name: nick });
  if (!w) return;
  try {
    const p = P(id);
    let photo = photoOf(p);
    if (photo?.startsWith('fsimg:')) photo = await S.backend?.getImage(photo.slice(6));
    const blob = await wrappedToPngBlob(w.summary, { photo, color: p.color, initial: initials(p.name) });
    const file = new File([blob], `hfl-wrapped-${season}-${nick(id)}.png`, { type: 'image/png' });
    const text = `My HFL ${season} Wrapped: ${w.summary.headline}${w.summary.nemesis ? `. Nemesis: ${w.summary.nemesis}` : ''}`;
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'HFL Wrapped', text }); return; }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Wrapped image downloaded. Drop it in the group chat');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not share: ' + e.message, true);
  }
}

function viewAwards() {
  const season = S.season === 'career' ? S.db.settings.season : S.season;
  const s = S.awards.seasons[season];
  const potw = [...S.awards.potw].reverse();
  const recent = [...S.awards.milestones].reverse().filter((m) => m.n > 1).slice(0, 12);
  const firsts = [...S.awards.milestones].reverse().filter((m) => m.n === 1).slice(0, 16);
  const award = (x, icon, title, blurb) => `
    <div class="award ${x ? '' : 'empty-award'}">
      <div class="award-ic">${icon}</div>
      <div class="grow"><div class="kicker ${x ? 'gold' : ''}">${title}${x ? (s.done ? ' · Winner' : ' · Leader so far') : ''}</div>
        ${x ? `<a href="#/p/${x.id}" class="award-who">${avatar(x.id, 'xs')} <b>${h(nick(x.id))}</b></a><span class="muted small">${h(x.note)}</span>` : `<span class="muted small">${blurb}</span>`}
      </div>
    </div>`;
  return `
    ${pageHead(`Season ${h(season)}`, 'Awards', `
      <select class="pill-select" data-ch="season" aria-label="Season">
        ${seasons().map((x) => `<option value="${h(x)}" ${season === x ? 'selected' : ''}>Season ${h(x)}</option>`).join('')}
      </select>`)}
    <section class="card">
      <h3>Season awards</h3>
      <p class="muted small">${s?.done ? 'Final. These are locked in.' : 'Handed out when the season ends (change the season name in Settings to start a new one). Here\'s who\'s leading.'}</p>
      ${award(s?.mvp, '👑', 'MVP', 'Most MVP points: stats, crowd MVPs and wins.')}
      ${award(s?.improved, '📈', 'Most Improved', 'Biggest OVR gain from games this season (2+ games).')}
      ${award(s?.butter, '🧈', 'Butterfingers', 'Most drops. Nobody wants this one.')}
    </section>
    <section class="card">
      <h3>Player of the Week</h3>
      <p class="muted small">Biggest stat impact across each week's games (weeks start Monday).</p>
      ${potw.length ? potw.slice(0, 10).map((x, i) => `
        <a class="potw ${i === 0 ? 'latest' : ''}" href="#/p/${x.id}">
          ${avatar(x.id, i === 0 ? 'lg' : '')}
          <span class="grow"><b>${h(nick(x.id))}</b><span class="muted small">Week of ${h(fmtDate(x.week, { month: 'short', day: 'numeric' }))} · ${statLine(x.stats)}</span></span>
          ${i === 0 ? '<span class="potw-flame">🔥</span>' : ''}
        </a>`).join('') : `<div class="empty-inline">${ART.trophy}<span>Finish a game and the first Player of the Week gets crowned.</span></div>`}
    </section>
    <section class="card">
      <h3>Milestone tracker</h3>
      ${recent.length ? `<div class="trophy-list">${recent.map((m) => `
        <a class="trophy" href="#/g/${m.gameId}"><span class="trophy-ic">${m.emoji}</span><span class="grow"><b>${h(nick(m.id))}: ${h(m.label)}</b><span class="muted small">${h(fmtDate(m.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</span></span></a>`).join('')}</div>`
        : `<p class="muted small">10th catch, 25th TD, 100th TD… the big ones show up here.</p>`}
      ${firsts.length ? `<div class="chips-label">Recent firsts</div><div class="chips">${firsts.map((m) => `<a class="pchip" href="#/g/${m.gameId}">${avatar(m.id, 'xs')} ${m.emoji} ${h(nick(m.id))}: ${h(m.label.replace('First ', 'first '))}</a>`).join('')}</div>` : ''}
    </section>
    <section class="card">
      <h3>Card designs</h3>
      <p class="muted small">Unlock these with awards and milestones, then wear them from your player page.</p>
      <div class="trophy-list">${DESIGNS.filter((d) => d.key).map((d) => {
        const who = Object.entries(S.awards.designs).filter(([, list]) => list.includes(d.key)).map(([id]) => id).filter((id) => S.db.players.some((p) => p.id === id));
        return `<div class="trophy"><span class="design-swatch tcard tier-gold design-${d.key}"><i></i></span><span class="grow"><b>${d.emoji} ${h(d.name)}</b><span class="muted small">${h(d.how)}</span>${who.length ? `<span class="chips">${who.map((id) => `<a class="pchip" href="#/p/${id}">${avatar(id, 'xs')} ${h(nick(id))}</a>`).join('')}</span>` : ''}</span></div>`;
      }).join('')}</div>
    </section>`;
}

function viewCard(id) {
  const p = S.db.players.find((x) => x.id === id);
  if (!p) return `<p class="muted">Player not found. <a href="#/cards">Back</a></p>`;
  const hist = S.league.history[id] || [];
  const first = hist[0] ? E.eloToOvr(hist[0].elo) : ovr(id);
  const log = gameLog(id);
  const fame = S.db.fame.filter((f) => f.playerIds.includes(id));
  return `
    <a class="back" href="#/cards">‹ Cards</a>
    <div class="card-stage">${tradingCard(id)}</div>
    <p class="muted small center">Tap the card to flip it.</p>
    <div class="badges">${badges(id).map((b) => `<span class="badge">${h(b)}</span>`).join('')}</div>
    ${(() => {
      const ss = wrappedSeasons(S.db).filter((x) => S.db.games.some((g) => g.status === 'final' && g.season === x && E.teamOf(g, id)));
      const x = ss.at(-1);
      return x ? `<a class="btn block wr-open" href="#/wrapped/${id}?s=${encodeURIComponent(x)}">🎁 ${id === me() ? 'My' : `${h(nick(id))}'s`} Season ${h(x)} Wrapped${seasonOver(S.db, x) ? '' : ' (so far)'}</a>` : '';
    })()}

    ${ratingsSection(id, log)}
    ${nflSection(id)}
    ${progressionSection(id)}
    ${awardsSection(id)}
    ${designSection(id)}
    <section class="card">
      <div class="row-between"><h3>OVR over time</h3><span class="muted small">started at ${first} → now <b>${ovr(id)}</b></span></div>
      ${sparkline(hist, { w: 600, hgt: 90, cls: 'wide' })}
    </section>

    <section class="card">
      <h3>Game log</h3>
      ${log.length ? log.map((x) => `
        <a class="glog" href="#/g/${x.g.id}">
          <span class="res res-${x.res}">${x.res}</span>
          <span class="glog-main"><b>${x.info.summary.score[x.side]}–${x.info.summary.score[x.side === 'A' ? 'B' : 'A']}</b> ${h(fmtDate(x.g.date, { month: 'short', day: 'numeric' }))}${x.mvp ? ' 👑' : ''}<br><span class="muted small">${statLine(x.stats)}</span></span>
          ${deltaTag(x.delta)}
        </a>`).join('') : `<div class="empty-inline">${ART.whistle}<span>No games yet. His log starts after his first final whistle.</span></div>`}
    </section>

    ${careerSection(id)}
    ${fame.length ? `<section class="card"><h3>In the Hall</h3>${fame.map((f) => `<div class="mini-fame">${FAME[f.category].emoji} <b>${h(f.title)}</b></div>`).join('')}</section>` : ''}
    ${id === me() && pinOk(id) ? `<a class="btn hot block" href="#/me">${p.nickname ? 'Change your nickname' : 'Add your nickname'}</a>
      <a class="btn ghost block" href="#/p/${id}/edit">📸 ${photoOf(p) ? 'Change' : 'Add'} your card photo</a>` : ''}
    ${canEditProfile(id) ? `<a class="btn ghost block" href="#/p/${id}/edit">✎ Edit ${id === me() ? 'my profile' : 'player'}</a>` : `<p class="muted small center">🔒 Only ${h(p.name)} can edit this profile.</p>`}`;
}

function viewEditPlayer(id) {
  const p = id ? S.db.players.find((x) => x.id === id) : null;
  if (id && !p) return `<p class="muted">Player not found.</p>`;
  const v = p || { name: '', nickname: '', number: '', position: 'ATH', startOvr: 70, emoji: '', color: '#ff6b1a', active: true };
  const boss = iAmCommish();
  if (p && !canEditProfile(p.id)) {
    return `<a class="back" href="#/p/${p.id}">‹ Back</a>
      <section class="card">${empty({ art: 'cards', title: 'Locked', text: `Only ${h(p.name)} can edit his own profile. ${me() === p.id ? 'Enter your PIN first.' : ''}`, cta: me() === p.id || !me() ? `<a class="btn hot" href="#/unlock/${p.id}">${p.pinHash ? 'Enter PIN' : 'Create PIN'}</a>` : '' })}</section>`;
  }
  const lockNote = (what) => `<span class="lock-note">🔒 ${what}</span>`;
  return `
    <a class="back" href="${p ? `#/p/${p.id}` : '#/cards'}">‹ Back</a>
    <section class="card">
      <h2>${p ? 'Edit player' : 'New player'}</h2>
      <form data-f="player" data-id="${p ? p.id : ''}" class="form">
        ${!p || boss ? `<label>Name <input name="name" required maxlength="40" value="${h(v.name)}" placeholder="Marcus Hill"></label>` : ''}
        <label>Nickname <input name="nickname" maxlength="40" value="${h(v.nickname)}" placeholder="Slingshot"></label>
        <div class="form-row">
          ${boss ? `<label>Position <select name="position">${E.POSITIONS.map((x) => `<option ${v.position === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>` : `<label>Position ${lockNote(`${h(v.position || 'ATH')} · locked`)}</label>`}
          <label>Jersey # <input name="number" type="number" min="0" max="99" inputmode="numeric" value="${h(v.number)}"></label>
        </div>
        <div class="form-row">
          <label>Card emoji <input name="emoji" maxlength="8" value="${h(v.emoji)}" placeholder="⚡"></label>
          <label>Card color <input name="color" type="color" value="${h(v.color || '#ff6b1a')}"></label>
        </div>
        ${boss ? `<div class="form-row">
          <label>Height ${heightPicker(v.heightIn, 'height')}</label>
          <label>Weight (lbs) <input name="weightLb" type="number" min="60" max="400" inputmode="numeric" value="${h(v.weightLb ?? '')}" placeholder="180"></label>
        </div>` : bioLine(v) ? `<label>Height & weight ${lockNote(`${h(bioLine(v))} · set by the league`)}</label>` : ''}
        ${p || !boss ? '' : `<label>Starting level: <b data-out="startOvr">${v.startOvr ?? 70}</b>
          <input name="startOvr" type="range" min="40" max="99" value="${v.startOvr ?? 70}" data-ch="range-out">
        </label>`}
        <p class="muted small">${!boss ? '🔒 Ratings and position are locked. The app updates them after every game.' : p ? 'His seventeen Madden-style ratings (speed, catching, throwing and the rest) are set in <a href="#/ratings">Rate players</a>.' : 'Sets all of his ratings to start with; fine-tune them later in Rate players. After that they move with every game he plays. 70 is an average dude.'}</p>
        ${p || boss ? `<div class="photo-field">
          ${p ? avatar(p.id, 'lg') : '<span class="av lg" style="--c:#555">?</span>'}
          <label class="grow">Card photo <input type="file" name="photo" accept="image/*" data-ch="photo-preview"></label>
        </div>
        <div class="crop-preview" hidden><div class="crop-box"></div><span class="muted small">Auto-cropped to fit the card</span></div>
        <p class="muted small">Any photo works: it gets cropped to the card automatically, centered on the face. It shows on the card and next to the name everywhere.${p?.photo ? ' <button type="button" class="linkish" data-a="remove-photo" data-p="' + p.id + '">Remove current photo</button>' : ''}</p>` : ''}
        ${p && boss ? `<label class="check"><input type="checkbox" name="retired" ${p.active === false ? 'checked' : ''}> Retired (hide from RSVPs and cards, keep his stats)</label>` : ''}
        <button class="btn hot block">${p ? 'Save' : '+ Add to the league'}</button>
      </form>
    </section>`;
}

function nicknameForm(id, { welcome = false } = {}) {
  const p = P(id);
  return `
    <form data-f="my-nickname" data-id="${id}" class="form">
      <label>Your nickname <span class="muted small" style="text-transform:none;letter-spacing:0">(optional)</span>
        <input name="nickname" maxlength="24" value="${h(p.nickname || '')}" placeholder="e.g. Slingshot, Glue Hands, The Wall" autocomplete="off">
      </label>
      <p class="muted small">Shows on your player card, the scoreboard and the leaderboards. Leave it blank to go by ${h(p.name)}.</p>
      <div class="btn-row">
        ${welcome ? '<a class="btn ghost" href="#/">Skip</a>' : ''}
        <button class="btn hot grow">Save nickname</button>
      </div>
    </form>`;
}

function viewNickname() {
  const m = me();
  if (!m) return viewMe();
  return `
    <section class="card">
      <div class="kicker">Welcome to the HFL</div>
      <h2>What's up, ${h(P(m).name)}</h2>
      <p class="muted">Got a nickname? Totally optional. You can change it any time by tapping your name at the top.</p>
      ${nicknameForm(m, { welcome: true })}
    </section>`;
}

function viewUnlock(id) {
  const p = S.db.players.find((x) => x.id === id);
  if (!p) return `<p class="muted">Player not found. <a href="#/me">Back</a></p>`;
  const claimed = !!p.pinHash;
  return `
    <a class="back" href="#/me">‹ Who are you?</a>
    <section class="card unlock">
      <div class="unlock-av">${avatar(id, 'lg')}</div>
      <h2>${claimed ? `Hey ${h(nick(id))}` : `Claim ${h(p.name)}`}</h2>
      <p class="muted">${claimed
        ? 'Enter your PIN. This phone will remember it.'
        : `Create a 4-digit PIN. After this, only you can change ${h(p.name)}'s nickname, photo and card.`}</p>
      <form data-f="unlock" data-id="${id}" data-claimed="${claimed ? 1 : ''}" class="form">
        <label>${claimed ? 'PIN' : 'New PIN'} <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" minlength="4" required autocomplete="off" class="pin-input" autofocus></label>
        ${claimed ? '' : '<label>Type it again <input name="pin2" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" minlength="4" required autocomplete="off" class="pin-input"></label>'}
        <button class="btn hot block">${claimed ? 'Unlock' : 'Create PIN & claim'}</button>
      </form>
      <p class="muted small">${claimed ? 'Forgot it? Say so in the group chat and it can be reset.' : "Pick something you'll remember. Don't use someone else's name!"}</p>
    </section>`;
}

function viewMe() {
  const list = activePlayers();
  const m = me();
  return `
    ${m ? `
      <section class="card">
        <div class="kicker">Signed in as ${h(P(m).name)}</div>
        ${pinOk(m) ? `${nicknameForm(m)}<button class="btn ghost block" data-a="lock-phone">Sign out on this phone</button>` : `<p class="muted">Create a PIN to lock your profile, then you can set your nickname and photo.</p><a class="btn hot block" href="#/unlock/${m}">Create my PIN</a>`}
      </section>` : ''}
    <section class="card">
      <h2>${m ? 'Not you?' : 'Who are you?'}</h2>
      <p class="muted small">🔒 = claimed with a PIN.</p>
      <p class="muted">This phone will RSVP, vote and post as this player.</p>
      <div class="me-grid">${list.map((p) => `
        <button class="me-opt ${m === p.id ? 'on' : ''}" data-a="set-me" data-p="${p.id}">${avatar(p.id, 'lg')}<span>${p.pinHash ? '🔒 ' : ''}${h(p.name)}</span>${p.nickname ? `<small>“${h(p.nickname)}”</small>` : ''}</button>`).join('')}
      </div>
      <a class="btn ghost block" href="#/new-player">Not on the list? Add yourself</a>
    </section>`;
}

// ---------------------------------------------------------------------------
// Playbook

function viewPlays() {
  const plays = S.db.plays.filter((p) => !p.gameId).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return `
    ${pageHead('5v5', 'Playbook')}
    ${teamPlaybooksSection()}
    ${sec('League playbook', '<a class="btn sm hot" href="#/play/new">+ New play</a>')}
    <p class="muted small">${plays.length} play${plays.length === 1 ? '' : 's'} · everyone can see these</p>
    ${plays.length ? `<div class="play-grid">${plays.map((pl) => `
      <a class="play-tile" href="#/play/${pl.id}">
        ${playSVG(pl, { cls: 'thumb' })}
        <div class="pt-name">${h(pl.name)}</div>
        <div class="muted small">${pl.authorId ? `by ${h(nick(pl.authorId))} · ` : ''}${h(ago(pl.updatedAt || pl.createdAt))}</div>
      </a>`).join('')}</div>` : `
      <section class="card">${empty({ art: 'chalk', title: 'The chalkboard is clean', text: 'Draw routes with your finger, run the animation, and share it to the group chat before the game.', cta: '<a class="btn hot" href="#/play/new">Draw the first play</a>' })}</section>`}`;
}

function viewPlay(id) {
  const existing = id === 'new' ? null : S.db.plays.find((p) => p.id === id);
  if (id !== 'new' && !existing) return `<p class="muted">That play was deleted. <a href="#/plays">Back</a></p>`;
  if (existing?.gameId) return `<p class="muted">That's a team play. <a href="#/team/${existing.gameId}/${existing.side}">Open the team playbook ›</a></p>`;
  S.after = () => {
    S.editorHash = location.hash;
    S.editor = new PlayEditor($('#pb-root'), existing || newPlay(), {
      onSave: (play, ed) => run(async () => {
        const body = { ...play, authorId: play.authorId || me() };
        if (!body.name.trim()) throw new Error('Give the play a name first');
        if (existing) {
          await api('PUT', `/api/plays/${existing.id}`, body);
          ed.dirty = false;
          toast('Saved 💾');
        } else {
          const saved = await api('POST', '/api/plays', body);
          S.editor?.destroy();
          S.editor = null;
          location.hash = `#/play/${saved.id}`;
          toast('Added to the playbook 📋');
        }
      }),
      onShare: (play) => sharePlay({ ...play, id: existing.id }),
      onDelete: () => {
        if (!confirm('Delete this play?')) return;
        run(async () => {
          S.editor?.destroy();
          S.editor = null;
          location.hash = '#/plays';
          await api('DELETE', `/api/plays/${existing.id}`);
        }, 'Play deleted');
      },
    });
  };
  return `
    <a class="back" href="#/plays">‹ Playbook</a>
    ${existing?.authorId ? `<div class="muted small">Drawn up by ${h(nick(existing.authorId))}</div>` : ''}
    <div id="pb-root" class="pb"></div>`;
}

// ---------------------------------------------------------------------------
// Team playbooks: private per game side, unlocked with the team PIN (see teamlock.js)

const teamKeyName = (gid, side) => `hfl.team.${gid}.${side}`;
function teamSecrets(g, side) {
  try {
    const s = JSON.parse(lsGet(teamKeyName(g.id, side)) || 'null');
    return secretsMatch(g.teamLocks?.[side], s) ? s : null;
  } catch { return null; }
}
const captainOf = (g, side) => teamCaptain(S.db, g, side, S.league);
const canManageTeam = (g, side) => { const m = me(); return !!m && pinOk(m) && (isAdmin(m) || m === captainOf(g, side)); };
const teamPlayDocs = (g, side) => S.db.plays.filter((p) => p.gameId === g.id && p.side === side);

// The game whose teams get playbooks right now: the live one, else the next one with teams.
function playbookGame() {
  const withTeams = gamesSorted().filter((g) => g.teams?.A?.length && g.teams?.B?.length);
  return withTeams.find((g) => g.status === 'live') || withTeams.find((g) => g.status === 'scheduled') || withTeams.filter((g) => g.status === 'final').at(-1) || null;
}

// Decrypted team plays, cached; decrypting is async, so the first call starts it and re-renders.
S.tcache = {};
function teamPlays(g, side) {
  const sec = teamSecrets(g, side);
  if (!sec) return null;
  const docs = teamPlayDocs(g, side);
  const k = `${g.id}|${side}`;
  const sig = `${sec.proof.slice(0, 8)}|${docs.map((p) => `${p.id}@${p.updatedAt}`).join(',')}`;
  const c = S.tcache[k];
  if (c?.sig === sig) return c.plays;
  if (c?.pending !== sig) {
    S.tcache[k] = { ...c, pending: sig };
    Promise.all(docs.map(async (p) => {
      try { return { ...(await decryptJSON(sec.key, p.enc)), id: p.id, authorId: p.authorId, updatedAt: p.updatedAt }; } catch { return { id: p.id, broken: true, name: '🔒 Locked with an old PIN' }; }
    })).then((plays) => { S.tcache[k] = { sig, plays }; render(); });
  }
  return c?.plays ?? null; // last good list while the new one decrypts
}

function teamTile(g, side) {
  const cap = captainOf(g, side);
  const lock = g.teamLocks?.[side];
  const open = !!teamSecrets(g, side);
  const n = teamPlayDocs(g, side).length;
  const status = open ? 'Unlocked on this phone ›' : lock ? '🔒 Enter team PIN ›' : canManageTeam(g, side) ? 'Set the team PIN ›' : `Waiting for ${h(nick(cap))} to set a PIN`;
  return `
    <a class="team-book team-${side} ${open ? 'open' : ''}" href="#/team/${g.id}/${side}">
      <div class="tb-name">${h(teamName(g, side))}</div>
      <div class="tb-cap">${avatar(cap, 'xs')} <span>${h(nick(cap))}</span> <small>Captain</small></div>
      <div class="tb-count"><b>${n}</b> play${n === 1 ? '' : 's'}</div>
      <div class="tb-status">${status}</div>
    </a>`;
}

function teamPlaybooksSection() {
  const g = playbookGame();
  const past = gamesSorted().filter((x) => x !== g && ['A', 'B'].some((s) => teamSecrets(x, s))).reverse().slice(0, 6);
  if (!g && !past.length) return '';
  return `
    ${g ? `
      ${sec(`Team playbooks <span class="muted small">· ${h(fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>`)}
      <div class="team-books">${teamTile(g, 'A')}${teamTile(g, 'B')}</div>
      <p class="muted small">Private to each team: only guys with the team PIN can see or change them. Captains (the highest-rated player on each team) or league admins set the PIN.</p>` : ''}
    ${past.length ? `<details class="card-lite"><summary>Your older team playbooks (${past.length})</summary>${past.map((x) => ['A', 'B'].filter((s) => teamSecrets(x, s)).map((s) => `
      <a class="row-link" href="#/team/${x.id}/${s}">${h(teamName(x, s))} · ${h(fmtDate(x.date, { month: 'short', day: 'numeric' }))} <span class="muted small">${teamPlayDocs(x, s).length} plays</span></a>`).join('')).join('')}</details>` : ''}`;
}

function viewTeamBook(gid, side) {
  const g = S.db.games.find((x) => x.id === gid);
  if (!g) return `<p class="muted">That game is gone. <a href="#/plays">Back</a></p>`;
  const lock = g.teamLocks?.[side];
  const cap = captainOf(g, side);
  const manage = canManageTeam(g, side);
  const head = `
    <a class="back" href="#/plays">‹ Playbook</a>
    ${pageHead(`${h(fmtDate(g.date, { weekday: 'short', month: 'short', day: 'numeric' }))} · Captain ${h(nick(cap))}`, `${h(teamName(g, side))} playbook`)}`;
  const pinFields = (label) => `
    <label>${label} <input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" autocomplete="off" required placeholder="6 digits"></label>
    <label>Type it again <input name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="8" autocomplete="off" required></label>`;
  if (!lock) {
    if (!manage) {
      const lockedAdmin = isAdmin(S.me) || S.me === cap;
      return `${head}<section class="card">${empty({ art: 'chalk', title: 'No team PIN yet', text: `${h(nick(cap))} (the captain) or a league admin sets the PIN. Then the team can draw plays the other side can't see.`, cta: lockedAdmin ? `<a class="btn hot" href="#/unlock/${S.me}">Enter your PIN to set it</a>` : '' })}</section>`;
    }
    return `${head}
      <section class="card">
        <h3>Set the team PIN</h3>
        <p class="muted small">Pick 6 digits and tell your teammates in person (not in the group chat, the other team is in there). The other team can't open this playbook without it.</p>
        <form class="form" data-f="team-setpin" data-g="${g.id}" data-side="${side}">${pinFields('Team PIN')}<button class="btn hot block">🔒 Lock the playbook</button></form>
      </section>`;
  }
  const keys = teamSecrets(g, side);
  if (!keys) {
    return `${head}
      <section class="card">
        <h3>🔒 Enter the team PIN</h3>
        <p class="muted small">Ask ${h(nick(cap))}, the captain. This phone remembers it until you lock it again.</p>
        <form class="form" data-f="team-unlock" data-g="${g.id}" data-side="${side}">
          <label>Team PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required autofocus></label>
          <button class="btn hot block">Unlock</button>
        </form>
      </section>
      ${manage ? `<details class="card-lite"><summary>Forgot the team PIN?</summary><p class="muted small">Resetting deletes this team's ${teamPlayDocs(g, side).length} plays for good (nobody can open them without the old PIN), then you set a new one.</p><button class="btn block danger-outline" data-a="team-reset" data-g="${g.id}" data-side="${side}">Reset the team PIN</button></details>` : ''}`;
  }
  const plays = teamPlays(g, side);
  const league = S.db.plays.filter((p) => !p.gameId);
  return `${head}
    <div class="row-between"><span class="chip">🔓 Unlocked on this phone</span><a class="btn sm hot" href="#/team/${g.id}/${side}/p/new">+ New play</a></div>
    ${plays === null ? `<p class="muted center">Unlocking…</p>` : plays.length ? `<div class="play-grid">${plays.map((pl) => `
      <a class="play-tile" href="#/team/${g.id}/${side}/p/${pl.id}">
        ${pl.broken ? '<div class="thumb"></div>' : playSVG(pl, { cls: 'thumb' })}
        <div class="pt-name">${h(pl.name)}</div>
        <div class="muted small">${pl.authorId ? `by ${h(nick(pl.authorId))} · ` : ''}${h(ago(pl.updatedAt))}</div>
      </a>`).join('')}</div>` : `<section class="card">${empty({ art: 'chalk', title: 'Empty playbook', text: 'Draw a play, or copy one in from the league playbook.' })}</section>`}
    ${league.length ? `<details class="card-lite"><summary>Copy a play from the league playbook</summary>${league.map((p) => `
      <div class="row-between copy-row"><span>${h(p.name)}</span><button class="btn sm ghost" data-a="team-copy" data-g="${g.id}" data-side="${side}" data-p="${p.id}">Copy in</button></div>`).join('')}</details>` : ''}
    <details class="card-lite"><summary>Team PIN</summary>
      <button class="btn block ghost" data-a="team-forget" data-g="${g.id}" data-side="${side}">🔒 Lock it on this phone</button>
      ${manage ? `
        <form class="form" data-f="team-changepin" data-g="${g.id}" data-side="${side}">${pinFields('New team PIN')}<button class="btn block">Change the team PIN</button></form>
        <button class="btn block danger-outline" data-a="team-reset" data-g="${g.id}" data-side="${side}">Reset (deletes this team's plays)</button>` : ''}
    </details>`;
}

function viewTeamPlay(gid, side, pid) {
  const g = S.db.games.find((x) => x.id === gid);
  const keys = g && teamSecrets(g, side);
  if (!keys) return `<a class="back" href="#/team/${gid}/${side}">‹ Team playbook</a><p class="muted">Unlock the team playbook first.</p>`;
  const plays = teamPlays(g, side);
  if (plays === null) return `<a class="back" href="#/team/${gid}/${side}">‹ Team playbook</a><p class="muted center">Unlocking…</p>`;
  const existing = pid === 'new' ? null : plays.find((p) => p.id === pid);
  if (pid !== 'new' && (!existing || existing.broken)) return `<a class="back" href="#/team/${gid}/${side}">‹ Team playbook</a><p class="muted">That play is gone.</p>`;
  const back = `#/team/${gid}/${side}`;
  S.after = () => {
    S.editorHash = location.hash;
    S.editor = new PlayEditor($('#pb-root'), existing ? structuredClone(existing) : newPlay(), {
      onSave: (play, ed) => run(async () => {
        if (!play.name.trim()) throw new Error('Give the play a name first');
        const clean = cleanPlay(play); // same checks as league plays, before it's locked up
        const box = await encryptJSON(keys.key, clean);
        if (existing) {
          await api('PUT', `/api/plays/${existing.id}`, { enc: box, _team: keys.proof });
          ed.dirty = false;
          toast('Saved 🔒');
        } else {
          const saved = await api('POST', '/api/plays', { gameId: gid, side, enc: box, authorId: me(), _team: keys.proof });
          S.editor?.destroy();
          S.editor = null;
          location.hash = `${back}/p/${saved.id}`;
          toast(`Added to the ${teamName(g, side)} playbook 🔒`);
        }
      }),
      onShare: (play) => sharePlay(play, { link: false }),
      onDelete: () => {
        if (!confirm('Delete this play?')) return;
        run(async () => {
          S.editor?.destroy();
          S.editor = null;
          location.hash = back;
          await api('DELETE', `/api/plays/${existing.id}`, { _team: keys.proof });
        }, 'Play deleted');
      },
    });
  };
  return `
    <a class="back" href="${back}">‹ ${h(teamName(g, side))} playbook</a>
    <div class="muted small">🔒 Private to ${h(teamName(g, side))}${existing?.authorId ? ` · drawn up by ${h(nick(existing.authorId))}` : ''}</div>
    <div id="pb-root" class="pb"></div>`;
}

async function sharePlay(play, { link = true } = {}) {
  const url = link ? `${location.origin}${location.pathname}#/play/${play.id}` : '';
  try {
    const blob = await playToPngBlob(play);
    const file = new File([blob], `${(play.name || 'play').replace(/[^\w-]+/g, '-')}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: play.name, text: url ? `${play.name} — ${url}` : play.name });
      return;
    }
    if (navigator.share && url) { await navigator.share({ title: play.name, text: play.name, url }); return; }
    if (url) await navigator.clipboard?.writeText(url).catch(() => {});
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(url ? 'Link copied + image downloaded' : 'Image downloaded');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not share: ' + e.message, true);
  }
}

// ---------------------------------------------------------------------------
// Wall

function viewWall() {
  const finals = gamesSorted().filter((g) => g.status === 'final').reverse();
  const latest = finals[0];
  const posts = [...S.db.posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const m = me();
  return `
    ${pageHead('Post-game', 'Trash talk')}
    ${latest ? `
      <section class="card">
        <div class="kicker">Last game · ${h(fmtDate(latest.date))}</div>
        <div class="mini-score">${h(teamName(latest, 'A'))} <b>${gameInfo(latest).summary.score.A}</b> – <b>${gameInfo(latest).summary.score.B}</b> ${h(teamName(latest, 'B'))}</div>
        ${mvpBlock(latest)}
      </section>` : ''}
    <section class="card composer-card">
      ${m ? `
        <form data-f="post" class="form composer">
          <div class="composer-row">${avatar(m)}<textarea name="text" maxlength="500" rows="3" required placeholder="Say it with your chest…"></textarea></div>
          <div class="btn-row">
            <select name="gameId" aria-label="About which game">
              <option value="">No game tag</option>
              ${finals.slice(0, 8).map((g) => `<option value="${g.id}" ${g === latest ? 'selected' : ''}>${h(fmtDate(g.date, { month: 'short', day: 'numeric' }))}</option>`).join('')}
            </select>
            <button type="button" class="btn ghost" data-a="roast" title="Generate a roast from real stats">🎲 Roast me a line</button>
            <button class="btn hot grow">Post</button>
          </div>
        </form>` : `<a class="btn ghost block" href="#/me">Pick who you are to post</a>`}
    </section>
    ${[...posts.map((post) => ({ t: post.createdAt, post })), ...finals.slice(0, 10).map((g) => ({ t: g.endedAt || `${g.date}T23:00:00.000Z`, g }))]
      .sort((a, b) => (b.t > a.t ? 1 : -1))
      .map((x) => (x.g ? recapCard(x.g, { compact: true }) : postCard(x.post, m))).join('') || `<section class="card">${empty({ art: 'mic', title: 'Quiet in here. Too quiet.', text: 'Somebody has to start it. Hit Roast if you need help.' })}</section>`}`;
}

function postCard(post, m) {
  return `
      <article class="post">
        <div class="post-head">${avatar(post.authorId)}<div><b>${h(nick(post.authorId))}</b><div class="muted small">${h(ago(post.createdAt))}${post.gameId ? ` · re: ${h(fmtDate(S.db.games.find((g) => g.id === post.gameId)?.date, { month: 'short', day: 'numeric' }))}` : ''}</div></div>
          ${post.authorId === m ? `<button class="icon-btn sm" data-a="del-post" data-id="${post.id}" aria-label="Delete post">🗑</button>` : ''}</div>
        <p class="post-text">${h(post.text)}</p>
        <div class="reacts">${REACTIONS.map((e) => {
          const who = post.reactions?.[e] || [];
          return `<button class="react ${m && who.includes(m) ? 'on' : ''}" data-a="react" data-id="${post.id}" data-e="${e}">${e}${who.length ? ` ${who.length}` : ''}</button>`;
        }).join('')}</div>
      </article>`;
}

function roast() {
  const m = me();
  const table = E.seasonTable(S.db, S.league, S.db.settings.season);
  const targets = activePlayers().filter((p) => p.id !== m);
  if (!targets.length) return 'Nobody to roast. Recruit some victims.';
  const p = targets[Math.floor(Math.random() * targets.length)];
  const n = p.nickname || p.name.split(' ')[0];
  const s = table[p.id] || E.blankStats();
  const lines = [
    `${n}'s OVR is ${ovr(p.id)}. That's his rating, not his age… probably.`,
    `${n} runs routes like he's following GPS through a tunnel.`,
    `If ${n} were any slower we'd have to list him as a defensive formation.`,
    `${n} calls it "ball-hawking." We call it standing near the ball.`,
    `Scouts say ${n} has a high motor. The motor is from a riding lawnmower.`,
  ];
  if (s.drops) lines.push(`${n} has ${s.drops} drop${s.drops > 1 ? 's' : ''} this season. Somebody check his hands for butter. 🧈`);
  if (s.intThrown) lines.push(`${n} has thrown ${s.intThrown} pick${s.intThrown > 1 ? 's' : ''}. Throwing to the other team is not a strategy, bro.`);
  if (s.sacked) lines.push(`${n} got sacked ${s.sacked} time${s.sacked > 1 ? 's' : ''}. Pocket presence of a folding chair.`);
  if (s.l > s.w) lines.push(`${n} is ${s.w}-${s.l} this season. We see you. We see all ${s.l} of those L's.`);
  if (s.gp && !E.totalTDs(s)) lines.push(`${n} has played ${s.gp} game${s.gp > 1 ? 's' : ''} and scored zero TDs. The end zone has a restraining order.`);
  const specific = lines.slice(5);
  const pool = specific.length && Math.random() < 0.7 ? specific : lines;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Hall of Fame

function viewFame() {
  const tab = S.fameTab;
  const list = S.db.fame.filter((f) => f.category === tab).sort((a, b) => b.votes.length - a.votes.length || b.createdAt.localeCompare(a.createdAt));
  const m = me();
  return `
    ${pageHead('Saved forever', 'Hall of Fame', '<a class="btn sm hot" href="#/fame/new">+ Enshrine</a>')}
    <div class="tabs-scroll">${Object.entries(FAME).map(([k, c]) => `<button class="tab-chip ${tab === k ? 'on' : ''}" data-a="fame-tab" data-t="${k}">${c.emoji} ${c.label} <span class="muted">${S.db.fame.filter((f) => f.category === k).length}</span></button>`).join('')}</div>
    ${list.map((f, i) => {
      const g = f.gameId && S.db.games.find((x) => x.id === f.gameId);
      return `
      <article class="fame ${i === 0 ? 'top' : ''}">
        ${f.image ? (f.image.startsWith('fsimg:') ? `<img data-fsimg="${h(f.image.slice(6))}" alt="">` : `<img src="${h(f.image)}" alt="" loading="lazy">`) : ''}
        <div class="fame-body">
          <div class="fame-title">${i === 0 ? '🥇 ' : ''}${h(f.title)}</div>
          ${f.description ? `<p>${h(f.description)}</p>` : ''}
          <div class="chips">${f.playerIds.map((id) => `<a class="pchip" href="#/p/${id}">${avatar(id, 'xs')} ${h(nick(id))}</a>`).join('')}</div>
          <div class="fame-foot">
            <span class="muted small">${g ? `<a href="#/g/${g.id}">${h(fmtDate(g.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</a>` : h(ago(f.createdAt))}</span>
            <span>
              ${f.authorId === m ? `<button class="icon-btn sm" data-a="del-fame" data-id="${f.id}" aria-label="Remove">🗑</button>` : ''}
              <button class="react ${m && f.votes.includes(m) ? 'on' : ''}" data-a="fame-vote" data-id="${f.id}">🏛️ ${f.votes.length}</button>
            </span>
          </div>
        </div>
      </article>`;
    }).join('') || `<section class="card">${empty({ art: 'trophy', title: 'Nothing enshrined yet', text: 'Tap 🏛️ on any logged play to save it forever, or add one by hand.', cta: '<a class="btn hot" href="#/fame/new">Enshrine a moment</a>' })}</section>`}`;
}

function viewFameNew(query) {
  const g = query.get('g') ? S.db.games.find((x) => x.id === query.get('g')) : null;
  const ev = g && query.get('e') ? g.events.find((e) => e.id === query.get('e')) : null;
  let cat = 'best', title = '', who = [];
  if (ev) {
    cat = ev.type === 'drop' ? 'drop' : ev.type === 'incomplete' ? 'dumb' : 'best';
    const t = E.EVENT_TYPES[ev.type];
    title = `${t.label}: ${nick(ev.p1)}${ev.p2 ? (ev.type === 'drop' ? '' : ` / ${nick(ev.p2)}`) : ''}`;
    who = [ev.p1, ev.p2].filter(Boolean);
  }
  const finals = gamesSorted().filter((x) => x.status !== 'scheduled').reverse();
  return `
    <a class="back" href="#/fame">‹ Hall of Fame</a>
    <section class="card">
      <h2>Enshrine a moment</h2>
      <form data-f="fame" class="form" data-e="${ev ? ev.id : ''}">
        <div class="seg-row">${Object.entries(FAME).map(([k, c]) => `
          <label class="seg-radio"><input type="radio" name="category" value="${k}" ${cat === k ? 'checked' : ''}><span>${c.emoji} ${c.label}</span></label>`).join('')}
        </div>
        <label>Title <input name="title" required maxlength="80" value="${h(title)}" placeholder="The One-Handed Snag"></label>
        <label>What happened <textarea name="description" maxlength="600" rows="4" placeholder="Paint the picture. Be cruel if needed."></textarea></label>
        <div class="chips-label">Who was involved</div>
        <div class="chips">${activePlayers().map((p) => `
          <label class="pchip check-chip"><input type="checkbox" name="playerIds" value="${p.id}" ${who.includes(p.id) ? 'checked' : ''}>${avatar(p.id, 'xs')} ${h(nick(p.id))}</label>`).join('')}
        </div>
        <label>Game
          <select name="gameId"><option value="">—</option>${finals.map((x) => `<option value="${x.id}" ${g?.id === x.id ? 'selected' : ''}>${h(fmtDate(x.date))} · ${h(teamName(x, 'A'))} vs ${h(teamName(x, 'B'))}</option>`).join('')}</select>
        </label>
        <label>Photo / screenshot (optional) <input type="file" name="image" accept="image/*"></label>
        <button class="btn hot block">Enshrine it forever</button>
      </form>
    </section>`;
}

// Card photos: crop to the card's shape around the face (the browser's face detector
// when it has one, a head-and-shoulders guess otherwise), then shrink.
async function cardPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read that image')); img.src = url; });
    let faces = [];
    if ('FaceDetector' in window) {
      try {
        faces = (await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 }).detect(img))
          .map((f) => ({ x: f.boundingBox.x, y: f.boundingBox.y, w: f.boundingBox.width, h: f.boundingBox.height }));
      } catch { /* no face detection here; fall back to the guess */ }
    }
    const c = cardCrop(img.naturalWidth, img.naturalHeight, { faces });
    const scale = Math.min(1, 960 / c.w);
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(c.w * scale), height: Math.round(c.h * scale) });
    canvas.getContext('2d').drawImage(img, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
    let quality = 0.85, dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > 600 * 1024 && quality > 0.35) dataUrl = canvas.toDataURL('image/jpeg', (quality -= 0.12));
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function resizeImage(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read that image')); img.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    // Keep photos small enough for any storage backend (Firebase caps them at 700KB).
    let quality = 0.82, dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > 600 * 1024 && quality > 0.35) dataUrl = canvas.toDataURL('image/jpeg', (quality -= 0.12));
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Settings

// ---------------------------------------------------------------------------
// League rules (league admins write them, everyone reads them)

function ruleForm(r = null) {
  return `
    <form data-f="rule" data-id="${r ? r.id : ''}" class="form rule-form">
      <label>Rule <input name="title" required maxlength="80" value="${h(r?.title || '')}" placeholder="Two-hand touch below the waist"></label>
      <label>Details <span class="muted small">(optional)</span><textarea name="text" maxlength="2000" placeholder="Anything the crew argues about goes here.">${h(r?.text || '')}</textarea></label>
      <div class="btn-row tight">
        ${r ? '<button type="button" class="btn ghost" data-a="rule-cancel">Cancel</button>' : ''}
        <button class="btn hot grow">${r ? 'Save rule' : '+ Add rule'}</button>
      </div>
    </form>`;
}

function viewRules() {
  const rules = S.db.settings.rules || [];
  const boss = iAmCommish();
  const lockedAdmin = !boss && isAdmin(S.me);
  return `
    ${pageHead(`${rules.length} rule${rules.length === 1 ? '' : 's'}`, 'League rules')}
    ${lockedAdmin ? `<a class="banner" href="#/unlock/${S.me}"><span class="banner-dot"></span><span><b>Enter your PIN to edit the rules.</b></span><span class="banner-go">›</span></a>` : ''}
    ${rules.length ? `<ol class="rules-list">${rules.map((r, i) => (boss && S.ruleEdit === r.id ? `<li class="rule">${ruleForm(r)}</li>` : `
      <li class="rule">
        <h3>${h(r.title)}</h3>
        ${r.text ? `<p>${h(r.text)}</p>` : ''}
        ${boss ? `
          <div class="rule-tools">
            <button class="btn sm ghost" data-a="rule-edit" data-r="${r.id}">✎ Edit</button>
            <button class="btn sm ghost" data-a="rule-move" data-r="${r.id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button class="btn sm ghost" data-a="rule-move" data-r="${r.id}" data-d="1" ${i === rules.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button class="btn sm ghost" data-a="rule-delete" data-r="${r.id}">🗑 Delete</button>
          </div>
          ${r.updatedAt ? `<div class="rule-meta">Updated ${h(fmtDate(r.updatedAt.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' }))}</div>` : ''}` : ''}
      </li>`)).join('')}</ol>`
    : `<section class="card">${empty({ art: 'whistle', title: 'No rules yet', text: boss ? 'Write the first one below. Everybody sees them here.' : 'The league admins haven\'t posted any rules yet.' })}</section>`}
    ${boss ? `<section class="card"><h3>Add a rule</h3>${ruleForm()}</section>` : ''}`;
}

function viewSettings() {
  const players = [...allPlayers()].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <section class="card">
      <h2>League settings</h2>
      <form data-f="settings" class="form">
        <label>Crew name <input name="crewName" maxlength="30" required value="${h(S.db.settings.crewName)}"></label>
        <label>Current season <input name="season" maxlength="20" required value="${h(S.db.settings.season)}"></label>
        <p class="muted small">New season? Change the name (e.g. "2027" or "Fall 26"). Old stats stay under their season; ratings carry over.</p>
        <button class="btn">Save</button>
      </form>
    </section>
    <section class="card">
      <div class="row-between"><h3>Roster (${players.length})</h3><a class="btn sm" href="#/new-player">+ Player</a></div>
      <p class="muted small">🔒 = claimed with a PIN.</p>
      ${players.map((p) => `
        <div class="row-link">${avatar(p.id, 'xs')} <a class="grow" href="#/p/${p.id}">${p.pinHash ? '🔒 ' : ''}${h(p.name)} ${p.active === false ? '<span class="muted small">(retired)</span>' : ''}</a>
          ${iAmCommish() && p.pinHash && p.id !== me() ? `<button class="btn sm ghost" data-a="reset-pin" data-p="${p.id}">Reset PIN</button>` : ''}<span class="muted">${ovr(p.id)}</span></div>`).join('') || '<p class="muted">No players yet.</p>'}
      ${players.length ? '' : `<button class="btn ghost block" data-a="seed-demo">👀 Load demo crew</button>`}
    </section>
    <section class="card">
      <div class="row-between"><h3>Rate players ${iAmCommish() ? '' : '🔒'}</h3><a class="btn sm ${iAmCommish() ? 'hot' : 'ghost'}" href="#/ratings">${iAmCommish() ? 'Open' : 'View'} ›</a></div>
      <p class="muted small">Madden style: set each guy's seventeen ratings (speed, acceleration, catching, throw power…) and position. His OVR is worked out from them.</p>
    </section>
    <section class="card">
      <h3>${S.auth?.managedBy === 'firebase' ? 'Crew password' : 'Crew passcode'}</h3>
      ${S.auth?.managedBy === 'firebase' ? `
        <p class="muted small">Everyone signs in once per phone with the crew password. Changing it signs every other phone out within the hour, so tell the crew the new one.</p>
        <form data-f="crewpass-change" class="form">
          <label>Current password <input name="current" type="password" required autocomplete="current-password"></label>
          <label>New password <input name="next" required minlength="6" maxlength="64" autocomplete="new-password" placeholder="at least 6 characters"></label>
          <button class="btn">Change crew password</button>
        </form>
        <button class="btn ghost block" data-a="sign-out">Sign this phone out</button>` : S.auth?.managedBy === 'server' ? `<p class="muted small">This passcode is set on the server (the HFL_PASSCODE setting), so change it there.</p>` : `
        <p class="muted small">${S.auth?.required
          ? 'The app is locked. Each phone types the passcode once and it’s remembered.'
          : 'Right now anyone with the link can get in and edit. Set a passcode to lock it to the crew.'}</p>
        <form data-f="passcode-set" class="form">
          <label>${S.auth?.required ? 'New passcode' : 'Passcode'} <input name="code" required minlength="4" maxlength="32" autocomplete="new-password" placeholder="at least 4 characters"></label>
          <button class="btn">${S.auth?.required ? 'Change' : 'Set'} passcode</button>
        </form>
        ${S.auth?.required ? `<button class="btn ghost block danger" data-a="remove-pass">Remove passcode</button>` : ''}`}
    </section>
    <section class="card">
      <h3>Backup</h3>
      <p class="muted small">Download everything (players, games, stats, plays, posts) as one file. Restore it on any HFL, on Firebase or on a computer.</p>
      <div class="btn-row">
        <button class="btn ghost grow" data-a="export">⬇ Download backup</button>
        ${iAmCommish() ? '<label class="btn ghost grow file-btn">⬆ Restore<input type="file" accept="application/json,.json" data-ch="import" hidden></label>' : ''}
      </div>
    </section>
    <section class="card">
      <h3>This phone</h3>
      <p class="muted small">Playing as: <b>${me() ? h(P(me()).name) : 'nobody yet'}</b> · <a href="#/me">change</a></p>
      ${S.pass ? `<button class="btn ghost block" data-a="forget-pass">Forget crew passcode</button>` : ''}
      <p class="muted small">Tip: in your phone's browser menu, choose “Add to Home Screen” to use the HFL like a real app.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Rate players

function viewKey() {
  const pct = (w) => `${Math.round(w * 100)}%`;
  return `
    <a class="back" href="#/cards">‹ Cards</a>
    ${pageHead('Madden style', 'Ratings key')}
    <section class="card">
      <h3>The seventeen ratings</h3>
      <p class="muted small">Every player is rated 20–99 in each one.</p>
      <div class="key-list">${E.ATTRS.map((a) => `
        <div class="key-row">
          <span class="key-abbr">${a.short}</span>
          <div><b>${h(a.label)}</b><p>${h(ATTR_INFO[a.key][0])}</p><p class="key-moves">${h(ATTR_INFO[a.key][1])}</p></div>
        </div>`).join('')}
      </div>
      <p class="muted small">Every rating also moves a little with the result: win a game you were expected to lose and they all tick up; get upset and they tick down. Gains get harder the closer you are to 99.</p>
    </section>
    <section class="card">
      <h3>What the colors mean</h3>
      <div class="key-grades">${GRADES.map(([g, range, name]) => `
        <div class="key-grade"><b class="g-${g}">${range}</b><span>${name}</span><i class="g-${g}"></i></div>`).join('')}
      </div>
      <div class="chips-label">Card colors (by OVR)</div>
      <div class="key-tiers">
        <span class="key-tier tier-legend">90+ Legend</span><span class="key-tier tier-gold">80–89 Gold</span>
        <span class="key-tier tier-silver">70–79 Silver</span><span class="key-tier tier-bronze">Under 70 Bronze</span>
      </div>
    </section>
    <section class="card">
      <h3>Form & clutch</h3>
      <div class="key-list">
        <div class="key-row"><span class="key-abbr">🔥</span><div><b>On fire</b><p>Scored or threw a TD in 3 straight games. His card catches fire until the streak ends.</p></div></div>
        <div class="key-row"><span class="key-abbr">❄️</span><div><b>Ice cold</b><p>2+ straight games with a drop or a pick thrown and no TDs. His card frosts over until he finds the end zone.</p></div></div>
        <div class="key-row"><span class="key-abbr">🧊</span><div><b>Clutch</b><p>Plays made in a one-score game late (the last 40% of the plays). Big plays add points, picks and drops take them away. Leaderboard under Stats → 🧊 Clutch. Most clutch points this season (with 2+ big plays) gets the Clutch badge; 15+ career clutch points makes you Mr. Clutch.</p></div></div>
      </div>
    </section>
    <section class="card">
      <h3>How OVR works</h3>
      <p class="muted small">Like Madden, OVR is a mix of the seventeen ratings, and the mix depends on your position. The same guy can be a 90 at WR and a 65 at QB. His player page shows his OVR at every position.</p>
      <div class="key-pos">${E.POSITIONS.map((pos) => `
        <div class="key-pos-row"><b>${pos}</b><span>${Object.entries(E.POSITION_WEIGHTS[pos]).sort((x, y) => y[1] - x[1])
          .map(([k, w]) => `<em title="${h(attrMeta[k].label)}">${attrMeta[k].short} ${pct(w)}</em>`).join('')}</span></div>`).join('')}
      </div>
    </section>`;
}

function viewRatings() {
  const list = activePlayers().sort((a, b) => ovr(b.id) - ovr(a.id));
  if (!iAmCommish()) {
    const boss = isAdmin(S.me) ? S.me : null;
    return `
      <a class="back" href="#/settings">‹ Settings</a>
      <section class="card">${empty({ art: 'chart', title: 'Ratings are locked', text: `The app updates everyone's ratings after every game.${boss ? ' Enter your PIN to unlock.' : ''}`, cta: boss ? `<a class="btn hot" href="#/unlock/${boss}">Enter PIN</a>` : '<a class="btn ghost" href="#/stats">See everyone\'s ratings</a>' })}</section>`;
  }
  return `
    <a class="back" href="#/settings">‹ Settings</a>
    <section class="card">
      <h2>Rate players</h2>
      <p class="muted">Madden style. Every guy has seventeen ratings from 20 to 99, and his <b>OVR</b> comes from them based on his position: a QB's is mostly throwing, a WR's is catching, routes and speed, a DB's is coverage and speed. Tap a player to set him up. After that his ratings move with every game he plays. <a href="#/key">What each rating means ›</a></p>
      <form data-f="ratings" class="form rate-list">
        ${list.map(rateRow).join('')}
        <button class="btn hot block">Save ratings</button>
      </form>
    </section>`;
}

// Height as feet + inches pickers. mode 'height' = named form fields, 'rate' = Rate players row.
function heightPicker(inches, mode) {
  const ft = inches ? Math.floor(inches / 12) : '';
  const inch = inches ? inches % 12 : 0;
  const a = mode === 'rate' ? (k) => `data-bio="${k}"${k === 'ft' ? ` data-cur="${inches ?? ''}"` : ''}` : (k) => `name="${k === 'ft' ? 'heightFt' : 'heightIn'}"`;
  return `<span class="height-pick">
    <select ${a('ft')}${mode === 'rate' ? ' data-ch="rate-bio"' : ''} aria-label="Feet"><option value="">–</option>${[4, 5, 6, 7].map((f) => `<option value="${f}" ${f === ft ? 'selected' : ''}>${f}′</option>`).join('')}</select>
    <select ${a('in')}${mode === 'rate' ? ' data-ch="rate-bio"' : ''} aria-label="Inches">${[...Array(12).keys()].map((i) => `<option value="${i}" ${i === inch ? 'selected' : ''}>${i}″</option>`).join('')}</select>
  </span>`;
}
const heightFrom = (ft, inch) => (ft ? Number(ft) * 12 + Number(inch || 0) : '');

function rateRow(p) {
  const a = attrsOf(p.id);
  const o = ovr(p.id);
  const pos = p.position || 'ATH';
  return `
    <details class="rate-row" data-pid="${p.id}" data-pos="${pos}">
      <summary class="rate-head">
        ${avatar(p.id, 'xs')}
        <span class="grow"><b>${h(p.name)}</b>${p.nickname ? ` <span class="muted small">“${h(p.nickname)}”</span>` : ''}</span>
        <span class="rate-pos">${h(pos)}</span>
        <output class="rate-val tier-${tier(o)}">${o}</output>
      </summary>
      <div class="rate-body">
        <div class="rate-top">
          <label>Position
            <select data-ch="rate-pos">${E.POSITIONS.map((x) => `<option ${x === pos ? 'selected' : ''}>${x}</option>`).join('')}</select>
          </label>
          <label>Height ${heightPicker(p.heightIn, 'rate')}</label>
          <label>Weight <input type="number" min="60" max="400" inputmode="numeric" placeholder="lbs" value="${h(p.weightLb ?? '')}" data-bio="weight" data-cur="${h(p.weightLb ?? '')}" data-ch="rate-bio"></label>
          <label>Set all
            <input type="range" min="${E.ATTR_MIN}" max="${E.ATTR_MAX}" value="${Math.round(E.ATTR_KEYS.reduce((t, k) => t + a[k], 0) / E.ATTR_KEYS.length)}" data-ch="rate-all">
          </label>
        </div>
        ${E.ATTRS.map((at) => `
          <label class="rate-attr" title="${h(at.label)}">
            <span class="ra-k">${at.short}</span><span class="ra-l">${h(at.label)}</span>
            <input type="range" min="${E.ATTR_MIN}" max="${E.ATTR_MAX}" value="${a[at.key]}" data-attr="${at.key}" data-cur="${a[at.key]}" data-ch="rate">
            <output class="ra-v g-${grade(a[at.key])}">${a[at.key]}</output>
          </label>`).join('')}
        <div class="rate-note muted small"></div>
      </div>
    </details>`;
}

// Live preview while dragging: rating colors, the player's OVR and where he'd fit best.
function refreshRateRow(row) {
  const attrs = {};
  let changed = false;
  row.querySelectorAll('input[data-attr]').forEach((el) => {
    const v = Number(el.value);
    attrs[el.dataset.attr] = v;
    if (v !== Number(el.dataset.cur)) changed = true;
    const out = el.parentElement.querySelector('output');
    out.textContent = v;
    out.className = `ra-v g-${grade(v)}`;
  });
  const pos = row.querySelector('[data-ch=rate-pos]').value;
  if (pos !== row.dataset.pos) changed = true;
  const ft = row.querySelector('[data-bio=ft]'), w = row.querySelector('[data-bio=weight]');
  if (String(heightFrom(ft.value, row.querySelector('[data-bio=in]').value)) !== ft.dataset.cur || w.value !== w.dataset.cur) changed = true;
  const o = E.overall(attrs, pos);
  const head = row.querySelector('.rate-val');
  head.textContent = o;
  head.className = `rate-val tier-${tier(o)}`;
  row.querySelector('.rate-pos').textContent = pos;
  const byPos = E.positionOveralls(attrs);
  const best = Object.entries(byPos).sort((x, y) => y[1] - x[1])[0];
  row.querySelector('.rate-note').innerHTML = `${pos} OVR <b>${o}</b>${best[0] !== pos ? ` · best fit ${best[0]} (${best[1]})` : ''}`;
  row.classList.toggle('changed', changed);
}

async function setPasscode(code) {
  const old = S.pass;
  const req = fetch('/api/passcode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hfl-pass': old }, body: JSON.stringify({ passcode: code }) });
  S.pass = code; // switch now so the "passcode changed" ping doesn't lock this phone out
  const res = await req;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { S.pass = old; throw new Error(data.error || 'Could not change the passcode'); }
  lsSet('hfl.pass', code);
  S.auth = { ...S.auth, required: data.required };
  connectStream();
  render();
}

// ---------------------------------------------------------------------------
// Actions (click), changes and forms

const A = {
  'seed-demo': () => run(() => api('POST', '/api/seed-demo'), 'Demo crew loaded 👀'),
  'set-me': ({ p }) => {
    if (!pinOk(p)) { location.hash = `#/unlock/${p}`; return; } // PIN first (or create one)
    S.me = p;
    lsSet('hfl.me', p);
    location.hash = P(p).nickname ? '#/' : '#/nickname'; // first time: offer a nickname
    if (P(p).nickname) toast(`What's up, ${nick(p)} 👊`);
    render();
  },
  rsvp: ({ g, p, s }) => {
    const game = S.db.games.find((x) => x.id === g);
    run(() => api('POST', `/api/games/${g}/rsvp`, { playerId: p, status: game?.rsvps[p] === s ? null : s }));
  },
  'rsvp-cycle': ({ g, p }) => {
    const cur = S.db.games.find((x) => x.id === g)?.rsvps[p] || '';
    const next = { '': 'in', in: 'out', out: null }[cur];
    run(() => api('POST', `/api/games/${g}/rsvp`, { playerId: p, status: next }));
  },
  'undo-teams': ({ g }) => run(() => api('POST', `/api/games/${g}/undo-teams`), '↶ Back to the previous teams'),
  'auto-teams': ({ g }) => run(() => api('POST', `/api/games/${g}/auto-teams`), '⚖️ Teams balanced'),
  swap: ({ g, p }) => {
    const game = S.db.games.find((x) => x.id === g);
    const from = E.teamOf(game, p);
    const to = from === 'A' ? 'B' : 'A';
    const teams = { [from]: game.teams[from].filter((id) => id !== p), [to]: [...game.teams[to], p] };
    run(() => api('PUT', `/api/games/${g}/teams`, { teams }));
  },
  'bench-add': ({ g, p }) => {
    const game = S.db.games.find((x) => x.id === g);
    const side = game.teams.A.length <= game.teams.B.length ? 'A' : 'B';
    run(() => api('PUT', `/api/games/${g}/teams`, { teams: { ...game.teams, [side]: [...game.teams[side], p] } }));
  },
  'rename-team': ({ g, side }) => {
    const game = S.db.games.find((x) => x.id === g);
    const name = prompt('Team name', teamName(game, side));
    if (name?.trim()) run(() => api('PATCH', `/api/games/${g}`, { teamNames: { [side]: name.trim() } }));
  },
  start: ({ g }) => run(() => api('POST', `/api/games/${g}/start`, {}), '🏈 Game on! Anyone can log plays'),
  'log-type': ({ g, t }) => { S.log = { gameId: g, type: t, p1: null }; render(); },
  clock: ({ g, c }) => {
    if ((c === 'off' || c === 'reset') && !confirm(c === 'off' ? 'Turn the game clock off? It disappears from every screen.' : 'Reset the clock to 0:00?')) return;
    run(() => api('POST', `/api/games/${g}/clock`, { action: c }));
  },
  'voice-start': ({ g }) => voiceStart(g),
  'rule-edit': ({ r }) => { S.ruleEdit = r; render(); },
  'team-forget': ({ g, side }) => { lsSet(teamKeyName(g, side), ''); toast('🔒 Locked on this phone'); render(); },
  'team-reset': ({ g, side }) => {
    const game = S.db.games.find((x) => x.id === g);
    const n = teamPlayDocs(game, side).length;
    if (!confirm(`Reset the ${teamName(game, side)} team PIN?${n ? ` This deletes the team's ${n} play${n > 1 ? 's' : ''} for good.` : ''}`)) return;
    run(async () => { await api('POST', `/api/games/${g}/team-lock`, { side, reset: true, lock: null }); lsSet(teamKeyName(g, side), ''); }, 'Team PIN reset. Set a new one');
  },
  'team-copy': ({ g, side, p }) => {
    const game = S.db.games.find((x) => x.id === g);
    const sec = teamSecrets(game, side);
    const src = S.db.plays.find((x) => x.id === p && !x.gameId);
    if (!sec || !src) return;
    run(async () => {
      const box = await encryptJSON(sec.key, cleanPlay(src));
      await api('POST', '/api/plays', { gameId: g, side, enc: box, authorId: me(), _team: sec.proof });
    }, `Copied “${src.name}” in 🔒`);
  },
  'rule-cancel': () => { S.ruleEdit = null; render(); },
  'rule-move': ({ r, d }) => run(() => api('POST', `/api/rules/${r}/move`, { dir: Number(d) })),
  'rule-delete': ({ r }) => {
    const rule = (S.db.settings.rules || []).find((x) => x.id === r);
    if (rule && confirm(`Delete the rule “${rule.title}”?`)) run(() => api('DELETE', `/api/rules/${r}`), 'Rule deleted');
  },
  'wr-go': ({ d }) => { if (S.wr) { S.wr.i = Math.max(0, S.wr.i + Number(d)); render(); } },
  'share-wrapped': ({ p, s }) => shareWrapped(p, s),
  'voice-stop': () => { voiceStop(); render(); },
  'voice-undo': () => {
    const L = V.last;
    V.last = null;
    if (L?.ev?.id) run(() => api('DELETE', `/api/games/${L.gameId}/events/${L.ev.id}`), 'Play removed');
    voiceRefresh();
  },
  'log-cancel': () => { S.log = null; render(); },
  'log-pick': ({ p }) => {
    const L = S.log;
    if (!L) return;
    const t = E.EVENT_TYPES[L.type];
    if (!L.p1 && t.roles.length > 1) { L.p1 = p; render(); return; }
    submitLog(L.p1 ? { p1: L.p1, p2: p } : { p1: p });
  },
  'log-skip': () => submitLog({ p1: S.log.p1, p2: null }),
  'undo-event': ({ g, e }) => run(() => api('DELETE', `/api/games/${g}/events/${e}`), 'Play removed'),
  final: ({ g }) => {
    if (!confirm('Blow the final whistle? Ratings and MVP voting kick in.')) return;
    S.log = null;
    run(() => api('POST', `/api/games/${g}/final`), '🏁 Final! Go vote for MVP');
  },
  reopen: ({ g }) => { if (confirm('Reopen this game so you can fix plays?')) run(() => api('POST', `/api/games/${g}/reopen`), 'Game reopened'); },
  'delete-game': ({ g }) => {
    if (!confirm('Delete this game and all its stats? No take-backs.')) return;
    run(async () => { await api('DELETE', `/api/games/${g}`); location.hash = '#/'; }, 'Game deleted');
  },
  mvp: ({ g, p }) => run(() => api('POST', `/api/games/${g}/mvp`, { voterId: me(), playerId: p }), `👑 Vote locked in for ${nick(p)}`),
  react: ({ id, e }) => needMe() && run(() => api('POST', `/api/posts/${id}/react`, { emoji: e, playerId: me() })),
  'del-post': ({ id }) => confirm('Delete your post?') && run(() => api('DELETE', `/api/posts/${id}`)),
  roast: (_, el) => { const ta = el.closest('form').querySelector('textarea'); ta.value = roast(); ta.focus(); },
  'fame-vote': ({ id }) => needMe() && run(() => api('POST', `/api/fame/${id}/vote`, { playerId: me() })),
  'del-fame': ({ id }) => confirm('Remove this from the Hall?') && run(() => api('DELETE', `/api/fame/${id}`), 'Removed'),
  'stat-tab': ({ t }) => { S.statTab = t; render(); },
  'fame-tab': ({ t }) => { S.fameTab = t; render(); },
  flip: (_, el) => el.classList.toggle('flipped'),
  'remove-pass': () => confirm('Remove the passcode? Anyone with the link will be able to get in.') && run(() => setPasscode(''), 'Passcode removed'),
  export: () => {
    const blob = new Blob([JSON.stringify(S.db, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `hfl-backup-${todayISO()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'sign-out': () => {
    if (!confirm('Sign this phone out? You\'ll need the crew password to get back in.')) return;
    S.backend.auth.signOut();
  },
  'remove-photo': ({ p }) => {
    if (!confirm('Remove this card photo?')) return;
    run(() => api('POST', `/api/players/${p}/photo`, { image: null }), 'Photo removed');
  },
  'share-recap': ({ g }) => { const game = S.db.games.find((x) => x.id === g); if (game) shareRecap(game); },
  'set-design': ({ p, d }) => run(() => api('PATCH', `/api/players/${p}`, { cardStyle: d }), d ? `${DESIGNS.find((x) => x.key === d).emoji} Card design on` : 'Back to Classic'),
  'reset-pin': ({ p }) => {
    if (!confirm(`Reset ${P(p).name}'s PIN? He'll create a new one next time he picks his name.`)) return;
    run(() => api('POST', `/api/players/${p}/pin`, { pinHash: null }), 'PIN reset');
  },
  'lock-phone': () => { lsSet(`hfl.pin.${S.me}`, ''); S.me = ''; lsSet('hfl.me', ''); toast('Signed out on this phone'); location.hash = '#/me'; render(); },
  'forget-pass': () => { S.pass = ''; lsSet('hfl.pass', ''); toast('Passcode forgotten on this phone'); render(); },
};

function submitLog({ p1, p2 }) {
  const L = S.log;
  S.log = null;
  const t = E.EVENT_TYPES[L.type];
  const game = S.db.games.find((x) => x.id === L.gameId);
  // Everyone can log, so two people might log the same play. Double-check recent twins.
  const twin = game?.events.find((e) => e.type === L.type && e.p1 === p1 && (e.p2 || null) === (p2 || null) && Date.now() - Date.parse(e.ts) < 90000);
  if (twin && !confirm(`${twin.by ? (twin.by === me() ? 'You' : nick(twin.by)) : 'Someone'} already logged "${t.label}: ${nick(p1)}${p2 ? ` / ${nick(p2)}` : ''}" ${Math.max(1, Math.round((Date.now() - Date.parse(twin.ts)) / 1000))}s ago. Log it again?`)) { render(); return; }
  run(async () => {
    await api('POST', `/api/games/${L.gameId}/events`, { type: L.type, p1, p2, by: me() });
    const g = S.db.games.find((x) => x.id === L.gameId);
    const sc = gameInfo(g).summary.score;
    toast(`${t.emoji} ${t.label}${t.points ? `! ${teamName(g, 'A')} ${sc.A} – ${sc.B} ${teamName(g, 'B')}` : ` — ${nick(p1)}`}`);
  });
}

const CHANGE = {
  rate: (el) => refreshRateRow(el.closest('.rate-row')),
  'rate-pos': (el) => refreshRateRow(el.closest('.rate-row')),
  'rate-bio': (el) => refreshRateRow(el.closest('.rate-row')),
  'rate-all': (el) => {
    const row = el.closest('.rate-row');
    row.querySelectorAll('input[data-attr]').forEach((i) => { i.value = el.value; });
    refreshRateRow(row);
  },
  season: (el) => { S.season = el.value; render(); },
  'photo-preview': async (el) => {
    const box = el.closest('form')?.querySelector('.crop-preview');
    const file = el.files?.[0];
    if (!box) return;
    if (!file) { box.hidden = true; return; }
    try {
      box.querySelector('.crop-box').style.backgroundImage = `url('${await cardPhoto(file)}')`;
      box.hidden = false;
    } catch (e) { toast(e.message, true); }
  },
  'wrapped-season': (el) => { location.hash = `#/wrapped?s=${encodeURIComponent(el.value)}`; },
  'range-out': (el) => { const out = el.form.querySelector(`[data-out="${el.name}"]`); if (out) out.textContent = el.value; },
  import: (el) => {
    const file = el.files?.[0];
    if (!file || !confirm('Replace EVERYTHING on this server with the backup?')) return;
    run(async () => {
      const db = JSON.parse(await file.text());
      await api('POST', '/api/import', { db });
    }, 'Backup restored');
  },
};

const FORMS = {
  unlock: async (d, form) => {
    const id = form.dataset.id;
    if (!/^\d{4}$/.test(d.pin)) return toast('PIN is 4 digits', true);
    const hash = await hashPin(id, d.pin);
    if (form.dataset.claimed) {
      if (hash !== P(id).pinHash) { form.reset(); return toast('Wrong PIN', true); }
    } else {
      if (d.pin !== d.pin2) return toast("Those PINs don't match", true);
      const ok = await run(() => api('POST', `/api/players/${id}/pin`, { pinHash: hash }));
      if (ok === undefined) return;
    }
    lsSet(`hfl.pin.${id}`, hash);
    S.me = id;
    lsSet('hfl.me', id);
    toast(form.dataset.claimed ? `Unlocked. What's up, ${nick(id)} 👊` : `🔒 ${P(id).name} is yours. Don't forget your PIN`);
    location.hash = P(id).nickname ? '#/' : '#/nickname';
  },
  'team-setpin': async (d, form) => {
    const { g: gid, side } = form.dataset;
    if (!TEAM_PIN.test(d.pin)) return toast('The team PIN has to be 4 to 8 digits', true);
    if (d.pin !== d.pin2) return toast("The two PINs don't match", true);
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Locking…';
    try {
      const { lock, secrets } = await makeLock(d.pin);
      const ok = await run(() => api('POST', `/api/games/${gid}/team-lock`, { side, lock }), '🔒 Team PIN set. Tell your teammates in person');
      if (ok) lsSet(teamKeyName(gid, side), JSON.stringify(secrets));
    } finally { render(); }
  },
  'team-unlock': async (d, form) => {
    const { g: gid, side } = form.dataset;
    const g = S.db.games.find((x) => x.id === gid);
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
    const secrets = await openLock(g?.teamLocks?.[side], d.pin.trim());
    if (!secrets) { btn.disabled = false; btn.textContent = 'Unlock'; form.reset(); return toast('Wrong team PIN', true); }
    lsSet(teamKeyName(gid, side), JSON.stringify(secrets));
    toast(`🔓 ${teamName(g, side)} playbook unlocked`);
    render();
  },
  'team-changepin': async (d, form) => {
    const { g: gid, side } = form.dataset;
    const g = S.db.games.find((x) => x.id === gid);
    const old = teamSecrets(g, side);
    if (!old) return toast('Unlock the playbook first', true);
    if (!TEAM_PIN.test(d.pin)) return toast('The team PIN has to be 4 to 8 digits', true);
    if (d.pin !== d.pin2) return toast("The two PINs don't match", true);
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Re-locking…';
    try {
      const { lock, secrets } = await makeLock(d.pin);
      // every play gets re-locked with the new PIN
      const plays = await Promise.all(teamPlayDocs(g, side).map(async (p) => ({ id: p.id, enc: await encryptJSON(secrets.key, await decryptJSON(old.key, p.enc)) })));
      const ok = await run(() => api('POST', `/api/games/${gid}/team-lock`, { side, lock, plays, _team: old.proof }), '🔒 Team PIN changed. Tell your teammates the new one');
      if (ok) lsSet(teamKeyName(gid, side), JSON.stringify(secrets));
    } catch (e) {
      toast(`Couldn't change it: ${e.message}`, true);
    } finally { render(); }
  },
  rule: async (d, form) => {
    const id = form.dataset.id;
    const body = { title: d.title, text: d.text };
    const saved = await run(() => api(id ? 'PATCH' : 'POST', id ? `/api/rules/${id}` : '/api/rules', body), id ? 'Rule saved' : '📜 Rule added');
    if (!saved) return;
    S.ruleEdit = null;
    if (!id) form.reset();
    render();
  },
  'my-nickname': async (d, form) => {
    const nickname = d.nickname.trim();
    const saved = await run(() => api('PATCH', `/api/players/${form.dataset.id}`, { nickname }), nickname ? `Nickname saved: “${nickname}” 🏈` : 'Nickname cleared');
    if (saved && location.hash === '#/nickname') location.hash = '#/';
  },
  ratings: (d, form) => {
    const ratings = {};
    form.querySelectorAll('.rate-row').forEach((row) => {
      const entry = {};
      row.querySelectorAll('input[data-attr]').forEach((el) => {
        if (Number(el.value) !== Number(el.dataset.cur)) (entry.attrs ||= {})[el.dataset.attr] = Number(el.value);
      });
      const pos = row.querySelector('[data-ch=rate-pos]').value;
      if (pos !== row.dataset.pos) entry.position = pos;
      const hIn = heightFrom(row.querySelector('[data-bio=ft]').value, row.querySelector('[data-bio=in]').value);
      if (String(hIn) !== String(row.querySelector('[data-bio=ft]').dataset.cur)) entry.heightIn = hIn;
      const w = row.querySelector('[data-bio=weight]');
      if (w.value !== w.dataset.cur) entry.weightLb = w.value;
      if (Object.keys(entry).length) ratings[row.dataset.pid] = entry;
    });
    const n = Object.keys(ratings).length;
    if (!n) return toast('Nothing changed');
    run(() => api('POST', '/api/ratings', { ratings }), `⭐ Saved ratings for ${n} player${n > 1 ? 's' : ''}`);
  },
  'passcode-set': (d, form) => {
    const code = d.code.trim();
    run(() => setPasscode(code), `🔒 Passcode set. Tell the crew: it's what you just typed`).then(() => form.reset?.());
  },
  passcode: async (d, form) => {
    if (S.backend) { // Firebase crew login
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await S.backend.auth.signIn(d.pass);
        bootFirebase();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
      return;
    }
    S.pass = d.pass.trim();
    lsSet('hfl.pass', S.pass);
    boot();
  },
  'crewpass-change': (d, form) => run(async () => {
    await S.backend.auth.changePassword(d.current, d.next);
    form.reset();
  }, '🔒 Crew password changed. Tell the crew the new one'),
  player: async (d, form) => {
    const id = form.dataset.id;
    const boss = iAmCommish();
    const body = { nickname: d.nickname, number: d.number, emoji: d.emoji, color: d.color };
    if (!id || boss) body.name = d.name;
    if (boss) Object.assign(body, { position: d.position, heightIn: heightFrom(d.heightFt, d.heightIn), weightLb: d.weightLb, ...(d.startOvr !== undefined ? { startOvr: Number(d.startOvr) } : {}) });
    if (id && boss) body.active = !d.retired;
    const saved = await run(() => api(id ? 'PATCH' : 'POST', id ? `/api/players/${id}` : '/api/players', body), id ? 'Saved' : `${d.nickname || d.name} joined the HFL 🏈`);
    if (!saved) return;
    const photo = form.querySelector('input[name=photo]')?.files?.[0];
    if (photo && photo.size) {
      try {
        const image = await cardPhoto(photo);
        await run(() => api('POST', `/api/players/${saved.id}/photo`, { image }), '📸 Card photo saved');
      } catch (e) {
        toast(e.message, true);
      }
    }
    if (!id && !me()) { location.hash = `#/unlock/${saved.id}`; return; } // new guy: claim it with a PIN
    location.hash = `#/p/${saved.id}`;
  },
  game: async (d) => {
    const g = await run(() => api('POST', '/api/games', { date: d.date, time: d.time, location: d.location, teamNames: { A: d.teamA, B: d.teamB } }), '📅 Game scheduled — tell the crew to tap in');
    if (g) location.hash = '#/';
  },
  'game-edit': (d, form) => run(() => api('PATCH', `/api/games/${form.dataset.g}`, {
    date: d.date, time: d.time, location: d.location, season: d.season, teamNames: { A: d.teamA, B: d.teamB },
  }), 'Game updated'),
  post: async (d, form) => {
    if (!needMe()) return;
    const ok = await run(() => api('POST', '/api/posts', { authorId: me(), text: d.text, gameId: d.gameId || null }), 'Posted 🗣️');
    if (ok) form.reset();
  },
  fame: async (d, form) => {
    const fd = new FormData(form);
    const file = fd.get('image');
    const body = {
      category: d.category, title: d.title, description: d.description,
      playerIds: fd.getAll('playerIds'), gameId: d.gameId || null, eventId: form.dataset.e || null, authorId: me(),
    };
    const btn = form.querySelector('button:not([type=button])');
    btn.disabled = true;
    try {
      if (file && file.size) body.image = await resizeImage(file);
      const saved = await run(() => api('POST', '/api/fame', body), '🏛️ Enshrined forever');
      if (saved) { S.fameTab = saved.category; location.hash = '#/fame'; }
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  },
  settings: (d) => run(() => api('PATCH', '/api/settings', { crewName: d.crewName, season: d.season }).then(() => { S.season = d.season; render(); }), 'Settings saved'),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (!fn) return;
  e.preventDefault();
  fn({ ...el.dataset }, el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-ch]');
  if (el && CHANGE[el.dataset.ch]) CHANGE[el.dataset.ch](el);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-ch="range-out"], [data-ch="rate"], [data-ch="rate-all"]');
  if (el) CHANGE[el.dataset.ch](el);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-f]');
  if (!form) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  FORMS[form.dataset.f]?.(d, form);
});

// ---------------------------------------------------------------------------
// Boot

const loginScreen = (label, hint, failed = '') => `
  <section class="hero"><div class="hero-kicker">Crew only</div><div class="hero-logo">HFL</div><p class="hero-tag">${hint}</p></section>
  <section class="card">
    <form data-f="passcode" class="form">
      <label>${label} <input name="pass" type="password" required autocomplete="current-password" autofocus></label>
      <button class="btn hot block">Let me in</button>
    </form>
    ${failed ? `<p class="muted small">${failed}</p>` : ''}
  </section>`;

// Running on Firebase Hosting? It serves the project's config at this reserved URL.
async function firebaseConfig() {
  try {
    const res = await fetch('/__/firebase/init.json');
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    const cfg = await res.json();
    return cfg?.projectId ? cfg : null;
  } catch {
    return null;
  }
}

async function bootFirebase() {
  try {
    if (!S.backend) {
      const { connectFirebase } = await import('./backend-firebase.js');
      S.backend = await connectFirebase(S.fbConfig);
      // Signed out (here, or because the crew password changed): back to the login screen.
      S.backend.auth.onChange((user) => { if (!user && S.db) { S.db = null; S.backend.stop(); bootFirebase(); } });
      const dot = () => {
        $('#live-dot').classList.toggle('on', navigator.onLine);
        if (!S.live.dead) setLive(navigator.onLine, navigator.onLine ? '' : 'No signal. The score may be behind');
      };
      window.addEventListener('online', dot);
      window.addEventListener('offline', dot);
      dot();
    }
    const user = S.backend.auth.current() || await S.backend.auth.waitForUser();
    S.auth = { required: true, ok: !!user, managedBy: 'firebase' };
    if (!user) {
      $('#view').innerHTML = loginScreen('Crew password', 'Members only. Type the crew password.');
      return;
    }
    const db = await S.backend.start(
      (next) => setDb(next, { remote: true }),
      (err) => {
        toast(err.message, true);
        // the live listeners stop after an error; nothing new arrives until a reload
        S.live = { ok: false, message: 'Live updates stopped. Close the camera and reload the app', dead: true };
        S.cast?.update();
      },
    );
    setDb(db);
    if (!boot.started) {
      boot.started = true;
      window.addEventListener('hashchange', render);
    }
    render();
    ensureRoster();
    undoEarlyStarts();
  } catch (e) {
    $('#view').innerHTML = `<section class="card">${empty({ art: 'whistle', title: 'Can\'t reach Firebase', text: h(e.message), cta: '<button class="btn hot" onclick="location.reload()">Try again</button>' })}</section>`;
  }
}

async function boot() {
  if (S.fbConfig || (S.fbConfig = await firebaseConfig())) return bootFirebase();
  try {
    const auth = await fetch('/api/auth', { headers: { 'x-hfl-pass': S.pass } }).then((r) => r.json());
    S.auth = auth;
    if (auth.required && !auth.ok) {
      $('#view').innerHTML = loginScreen('Crew passcode', 'Members only. Type the crew passcode.', S.pass ? "That passcode didn't work." : '');
      return;
    }
    await loadState();
    if (boot.started) connectStream(); // passcode may have changed; reconnect with the current one
    if (!boot.started) {
      boot.started = true;
      connectStream();
      window.addEventListener('hashchange', render);
    }
    render();
    ensureRoster();
    undoEarlyStarts();
  } catch (e) {
    $('#view').innerHTML = `<section class="card">${empty({ art: 'whistle', title: 'Can\'t reach the HFL server', text: h(e.message), cta: '<button class="btn hot" onclick="location.reload()">Try again</button>' })}</section>`;
  }
}

boot();
