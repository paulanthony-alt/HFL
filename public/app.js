import * as E from './engine.js';
import { ROSTER_VERSION } from './league.js';
import { PlayEditor, playSVG, newPlay, playToPngBlob } from './playbook.js';

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
};

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
const me = () => (S.me && S.db.players.some((p) => p.id === S.me) ? S.me : null);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const avatar = (id, cls = '') => { const p = P(id); return `<span class="av ${cls}" style="--c:${h(p.color || '#ff6b1a')}">${h(p.emoji || initials(p.name))}</span>`; };
const tier = (o) => (o >= 90 ? 'legend' : o >= 80 ? 'gold' : o >= 70 ? 'silver' : 'bronze');
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
  es.onopen = () => $('#live-dot').classList.add('on');
  es.onerror = () => {
    $('#live-dot').classList.remove('on');
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
  [/^#\/wall$/, viewWall, 'wall'],
  [/^#\/fame$/, viewFame, 'fame'],
  [/^#\/fame\/new$/, viewFameNew, 'fame'],
  [/^#\/me$/, viewMe, ''],
  [/^#\/nickname$/, viewNickname, ''],
  [/^#\/ratings$/, viewRatings, ''],
  [/^#\/settings$/, viewSettings, ''],
];

function render() {
  if (!S.db) return;
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
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
}

// One-time: make the league the HFL crew (see HFL_ROSTER in league.js).
function ensureRoster() {
  if ((S.db.settings.rosterVersion || 0) >= ROSTER_VERSION || ensureRoster.running) return;
  ensureRoster.running = true;
  api('POST', '/api/setup-roster')
    .then((r) => { if (r?.changed) toast('🏈 The HFL roster is set. Tap “Who are you?” to pick yourself'); })
    .catch(() => {})
    .finally(() => { ensureRoster.running = false; });
}

function renderChrome(tab) {
  $('#crew-name').textContent = S.db.settings.crewName === 'HFL' ? '' : S.db.settings.crewName;
  document.title = S.db.settings.crewName === 'HFL' ? 'HFL' : `HFL · ${S.db.settings.crewName}`;
  const m = me();
  $('#me-pill').innerHTML = m ? `${avatar(m, 'xs')} ${h(nick(m))}` : 'Who are you?';
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
    ${me() ? '' : `<a class="banner" href="#/me"><span class="banner-dot"></span><span><b>Who's holding this phone?</b> Pick yourself so your RSVPs, votes and posts count.</span><span class="banner-go">›</span></a>`}
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
  const side = `
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
  const chip = (p) => `<button class="pchip ${status(p.id)}" data-a="rsvp-cycle" data-g="${g.id}" data-p="${p.id}">${avatar(p.id, 'xs')} ${h(nick(p.id))}</button>`;
  return `
    <div class="rsvp">
      ${m ? `
        <div class="rsvp-me">
          <button class="btn big rsvp-btn ${mine === 'in' ? 'in' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="in">I'm in</button>
          <button class="btn big rsvp-btn ${mine === 'out' ? 'out' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="out">I'm out</button>
        </div>` : `<a class="btn ghost block" href="#/me">Pick who you are to RSVP</a>`}
      <div class="count"><b>${ins.length}</b><span>in</span><em>${ins.length >= TARGET_PLAYERS ? 'We got a game' : `Need ${TARGET_PLAYERS - ins.length} more for 5v5`}</em></div>
      <div class="bar ${ins.length >= TARGET_PLAYERS ? 'full' : ''}">${Array.from({ length: TARGET_PLAYERS }, (_, i) => `<i class="${i < ins.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="chips-label">In</div><div class="chips">${ins.map(chip).join('') || '<span class="muted small">Nobody yet</span>'}</div>
      ${none.length ? `<div class="chips-label">No reply</div><div class="chips">${none.map(chip).join('')}</div>` : ''}
      ${outs.length ? `<div class="chips-label">Out</div><div class="chips">${outs.map(chip).join('')}</div>` : ''}
      <p class="muted small">Tap anyone's name to mark them in / out / no reply.</p>
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
            ${avatar(id, 'xs')}<span class="tp-name">${h(nick(id))}</span><span class="tp-ovr">${ovr(id)}</span>
          </${editable ? 'button' : 'div'}>`).join('')}
      </div>`;
  };
  const wp = i.winProbA ?? 0.5;
  return `
    <div class="teams">${col('A')}${col('B')}</div>
    <div class="wp"><span style="width:${pct(wp)}"></span></div>
    <div class="wp-labels"><span>${pct(wp)}</span><span class="muted small">win odds</span><span>${pct(1 - wp)}</span></div>`;
}

function teamsSection(g) {
  const ins = activePlayers().filter((p) => g.rsvps[p.id] === 'in');
  const hasTeams = g.teams.A.length && g.teams.B.length;
  const onTeam = new Set([...g.teams.A, ...g.teams.B]);
  const bench = ins.filter((p) => !onTeam.has(p.id));
  return `
    <div class="divider"></div>
    ${sec('Teams', hasTeams ? '<span class="sec-link muted">Tap a player to swap sides</span>' : '')}
    ${hasTeams ? `
      ${teamColumns(g, { editable: true })}
      ${bench.length ? `<div class="chips-label">In but not on a team</div><div class="chips">${bench.map((p) => `<button class="pchip" data-a="bench-add" data-g="${g.id}" data-p="${p.id}">+ ${h(nick(p.id))}</button>`).join('')}</div>` : ''}
      <div class="btn-row">
        <button class="btn ghost" data-a="auto-teams" data-g="${g.id}">Reshuffle</button>
        <button class="btn hot grow" data-a="start" data-g="${g.id}">▶ Start game</button>
      </div>` : `
      <p class="muted">Once guys are in, the app splits them into the fairest teams it can find from everyone's rating.</p>
      <button class="btn hot block" data-a="auto-teams" data-g="${g.id}" ${ins.length < 2 ? 'disabled' : ''}>Make balanced teams · ${ins.length} in</button>`}`;
}

function liveSection(g) {
  const info = gameInfo(g);
  const m = me();
  const keeper = g.scorekeeperId;
  const isKeeper = !keeper || keeper === m;
  const events = [...g.events].reverse();
  return `
    ${scoreboard(g)}
    ${keeper ? `<div class="muted small center">📝 Scorekeeper: ${h(nick(keeper))}</div>` : ''}
    ${isKeeper ? logger(g) : `<details class="log-anyway"><summary>Log a play anyway</summary>${logger(g)}</details>`}
    ${sec('Play by play', `<span class="sec-link muted">${events.length} logged</span>`)}
    ${events.length ? `<ul class="feed">${events.map((ev) => eventRow(g, ev, true)).join('')}</ul>` : `<div class="empty-inline">${ART.whistle}<span>No plays logged yet. Pick a play type above to start.</span></div>`}
    <details class="card-lite"><summary>Rosters & live box score</summary>${boxScore(g, info)}</details>
    <button class="btn block danger-outline" data-a="final" data-g="${g.id}">Final whistle</button>`;
}

function logger(g) {
  const L = S.log?.gameId === g.id ? S.log : null;
  if (!L?.type) {
    return `
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
            ${g.teams[side].filter((id) => id !== L.p1).map((id) => `<button class="log-player" data-a="log-pick" data-p="${id}">${avatar(id, 'xs')} ${h(nick(id))}</button>`).join('')}
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
      <span class="ev-body">${describeEvent(ev)}</span>
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
    ${mvpBlock(g)}
    ${sec('Box score')}
    ${boxScore(g, info)}
    <p class="muted small">▲▼ = OVR change from this game (result vs. the odds, plus how much he balled out).</p>
    <details class="card-lite"><summary>Play by play (${g.events.length})</summary>
      <ul class="feed">${[...g.events].reverse().map((ev) => eventRow(g, ev, false)).join('')}</ul>
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
  mvp: '👑 MVP Race', tds: '🏈 TDs', qb: '🎯 QB Rating', record: '📈 Record', rec: '🙌 Receiving', def: '🦅 Defense', ovr: '⭐ Ratings',
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
  } else if (tab === 'ovr') {
    list = activePlayers().map((p) => ({ id: p.id, s: table[p.id] || E.blankStats() })).sort((a, b) => ovr(b.id) - ovr(a.id));
    cols = [['OVR', (s, id) => `<b>${ovr(id)}</b>`], ['Trend', (s, id) => {
      const hist = S.league.history[id] || [];
      const last = hist[hist.length - 1];
      return last?.delta ? deltaTag(last.delta) : '—';
    }]];
    note = 'Ratings move after every game: beat the odds and they go up. <a href="#/ratings">Rate players ›</a>';
  }
  return `
    ${pageHead(S.season === 'career' ? 'All-time' : `Season ${h(S.season)}`, 'Leaderboards', `
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
            ${cols.map(([, f]) => `<td>${f(r.s, r.id)}</td>`).join('')}
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

function badges(id) {
  const c = careerOf(id);
  const log = gameLog(id);
  let streak = 0;
  for (const x of log) { if (x.res === 'W') streak++; else break; }
  const out = [];
  if (c.mvps) out.push(`👑 ${c.mvps}× MVP`);
  if (S.db.fame.some((f) => f.category === 'best' && f.playerIds.includes(id))) out.push('🏛️ Hall of Famer');
  if (streak >= 3) out.push(`🔥 ${streak}-game win streak`);
  if (c.defInt >= 3) out.push('🦅 Ball Hawk');
  if (c.sacks >= 4) out.push('💥 QB Hunter');
  if (E.totalTDs(c) >= 5) out.push('🏈 End Zone Regular');
  if (c.drops >= 3) out.push('🧈 Butter Hands');
  if (S.db.fame.some((f) => f.category !== 'best' && f.playerIds.includes(id))) out.push('🤡 Hall of Shame');
  return out;
}

function tradingCard(id, { mini = false } = {}) {
  const p = P(id);
  const o = ovr(id);
  const s = E.seasonTable(S.db, S.league, S.db.settings.season)[id] || E.blankStats();
  const c = careerOf(id);
  const front = `
    <div class="tc-face tc-front">
      <div class="tc-top">
        <div class="tc-ovr">${o}<small>OVR</small></div>
        <div class="tc-pos">${h(p.position || 'ATH')}${p.number !== '' && p.number !== undefined ? `<small>#${h(p.number)}</small>` : ''}</div>
      </div>
      <div class="tc-art" style="--c:${h(p.color || '#ff6b1a')}">${p.number !== '' && p.number !== undefined ? `<i class="tc-num">${h(p.number)}</i>` : ''}<span>${h(p.emoji || initials(p.name))}</span></div>
      <div class="tc-name">${h(p.name)}</div>
      ${p.nickname ? `<div class="tc-nick">“${h(p.nickname)}”</div>` : '<div class="tc-nick">&nbsp;</div>'}
      <div class="tc-stats">
        <div><b>${s.gp}</b><small>GP</small></div>
        <div><b>${s.w}-${s.l}</b><small>W-L</small></div>
        <div><b>${E.totalTDs(s)}</b><small>TD</small></div>
        <div><b>${s.mvps}</b><small>MVP</small></div>
      </div>
      <div class="tc-foot">HFL · ${h(S.db.settings.season)}</div>
    </div>`;
  if (mini) return `<a href="#/p/${id}" class="tcard mini tier-${tier(o)}">${front}</a>`;
  const qbr = E.qbRating(c);
  const back = `
    <div class="tc-face tc-back">
      <div class="tc-back-title">${h(p.nickname || p.name)} · Career</div>
      <table class="tc-table">
        <tr><td>Games</td><td>${c.gp}</td><td>Record</td><td>${c.w}-${c.l}${c.t ? `-${c.t}` : ''}</td></tr>
        <tr><td>TDs</td><td>${E.totalTDs(c)}</td><td>MVPs</td><td>${c.mvps}</td></tr>
        <tr><td>Pass</td><td>${c.comp}/${c.att}</td><td>QB Rtg</td><td>${qbr === null ? '—' : qbr.toFixed(1)}</td></tr>
        <tr><td>Pass TD</td><td>${c.passTD}</td><td>INT thr</td><td>${c.intThrown}</td></tr>
        <tr><td>Catches</td><td>${c.rec}</td><td>Drops</td><td>${c.drops}</td></tr>
        <tr><td>INTs</td><td>${c.defInt}</td><td>Sacks</td><td>${c.sacks}</td></tr>
      </table>
      <div class="tc-spark">${sparkline(S.league.history[id] || [], { w: 220, hgt: 50 })}</div>
      <div class="tc-badges">${badges(id).slice(0, 4).map((b) => `<span>${h(b)}</span>`).join('')}</div>
      <div class="tc-foot">tap to flip</div>
    </div>`;
  return `<div class="tcard big tier-${tier(o)}" data-a="flip"><div class="tc-inner">${front}${back}</div></div>`;
}

function viewCards() {
  const list = activePlayers().sort((a, b) => ovr(b.id) - ovr(a.id));
  return `
    ${pageHead(`${list.length} on the roster`, 'Player cards', '<a class="btn sm" href="#/new-player">+ Player</a>')}
    ${list.length ? `<div class="card-grid">${list.map((p) => tradingCard(p.id, { mini: true })).join('')}</div>` : `<section class="card">${empty({ art: 'cards', title: 'No cards printed yet', text: 'Add your crew and everyone gets a card that levels up with every game.', cta: '<a class="btn hot" href="#/new-player">Add a player</a>' })}</section>`}`;
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

    <section class="card">
      <div class="row-between"><h3>Rating</h3><span class="muted small">started at ${first} → now <b>${ovr(id)}</b></span></div>
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

    ${fame.length ? `<section class="card"><h3>In the Hall</h3>${fame.map((f) => `<div class="mini-fame">${FAME[f.category].emoji} <b>${h(f.title)}</b></div>`).join('')}</section>` : ''}
    ${id === me() ? `<a class="btn hot block" href="#/me">${p.nickname ? 'Change your nickname' : 'Add your nickname'}</a>` : ''}
    <a class="btn ghost block" href="#/p/${id}/edit">✎ Edit player</a>`;
}

function viewEditPlayer(id) {
  const p = id ? S.db.players.find((x) => x.id === id) : null;
  if (id && !p) return `<p class="muted">Player not found.</p>`;
  const v = p || { name: '', nickname: '', number: '', position: 'ATH', startOvr: 70, emoji: '', color: '#ff6b1a', active: true };
  return `
    <a class="back" href="${p ? `#/p/${p.id}` : '#/cards'}">‹ Back</a>
    <section class="card">
      <h2>${p ? 'Edit player' : 'New player'}</h2>
      <form data-f="player" data-id="${p ? p.id : ''}" class="form">
        <label>Name <input name="name" required maxlength="40" value="${h(v.name)}" placeholder="Marcus Hill"></label>
        <label>Nickname <input name="nickname" maxlength="40" value="${h(v.nickname)}" placeholder="Slingshot"></label>
        <div class="form-row">
          <label>Position <select name="position">${E.POSITIONS.map((x) => `<option ${v.position === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label>Jersey # <input name="number" type="number" min="0" max="99" inputmode="numeric" value="${h(v.number)}"></label>
        </div>
        <div class="form-row">
          <label>Card emoji <input name="emoji" maxlength="8" value="${h(v.emoji)}" placeholder="⚡"></label>
          <label>Card color <input name="color" type="color" value="${h(v.color || '#ff6b1a')}"></label>
        </div>
        <label>Starting rating: <b data-out="startOvr">${v.startOvr ?? 70}</b>
          <input name="startOvr" type="range" min="40" max="99" value="${v.startOvr ?? 70}" data-ch="range-out">
        </label>
        <p class="muted small">${p ? 'This is where he started before any games. To change his rating now, use <a href="#/ratings">Rate players</a>.' : 'Be honest. The app only uses this as a starting point. After that, his rating moves with every game he plays. 70 is an average dude.'}</p>
        ${p ? `<label class="check"><input type="checkbox" name="retired" ${p.active === false ? 'checked' : ''}> Retired (hide from RSVPs and cards, keep his stats)</label>` : ''}
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

function viewMe() {
  const list = activePlayers();
  const m = me();
  return `
    ${m ? `
      <section class="card">
        <div class="kicker">Signed in as ${h(P(m).name)}</div>
        ${nicknameForm(m)}
      </section>` : ''}
    <section class="card">
      <h2>${m ? 'Not you?' : 'Who are you?'}</h2>
      <p class="muted">This phone will RSVP, vote and post as this player.</p>
      <div class="me-grid">${list.map((p) => `
        <button class="me-opt ${m === p.id ? 'on' : ''}" data-a="set-me" data-p="${p.id}">${avatar(p.id, 'lg')}<span>${h(p.name)}</span>${p.nickname ? `<small>“${h(p.nickname)}”</small>` : ''}</button>`).join('')}
      </div>
      <a class="btn ghost block" href="#/new-player">Not on the list? Add yourself</a>
    </section>`;
}

// ---------------------------------------------------------------------------
// Playbook

function viewPlays() {
  const plays = [...S.db.plays].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return `
    ${pageHead(`${plays.length} play${plays.length === 1 ? '' : 's'} · 5v5`, 'Playbook', '<a class="btn sm hot" href="#/play/new">+ New play</a>')}
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

async function sharePlay(play) {
  const url = `${location.origin}${location.pathname}#/play/${play.id}`;
  try {
    const blob = await playToPngBlob(play);
    const file = new File([blob], `${(play.name || 'play').replace(/[^\w-]+/g, '-')}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: play.name, text: `${play.name} — ${url}` });
      return;
    }
    if (navigator.share) { await navigator.share({ title: play.name, text: play.name, url }); return; }
    await navigator.clipboard?.writeText(url).catch(() => {});
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Link copied + image downloaded');
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
    ${posts.map((post) => `
      <article class="post">
        <div class="post-head">${avatar(post.authorId)}<div><b>${h(nick(post.authorId))}</b><div class="muted small">${h(ago(post.createdAt))}${post.gameId ? ` · re: ${h(fmtDate(S.db.games.find((g) => g.id === post.gameId)?.date, { month: 'short', day: 'numeric' }))}` : ''}</div></div>
          ${post.authorId === m ? `<button class="icon-btn sm" data-a="del-post" data-id="${post.id}" aria-label="Delete post">🗑</button>` : ''}</div>
        <p class="post-text">${h(post.text)}</p>
        <div class="reacts">${REACTIONS.map((e) => {
          const who = post.reactions?.[e] || [];
          return `<button class="react ${m && who.includes(m) ? 'on' : ''}" data-a="react" data-id="${post.id}" data-e="${e}">${e}${who.length ? ` ${who.length}` : ''}</button>`;
        }).join('')}</div>
      </article>`).join('') || `<section class="card">${empty({ art: 'mic', title: 'Quiet in here. Too quiet.', text: 'Somebody has to start it. Hit Roast if you need help.' })}</section>`}`;
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
      ${players.map((p) => `
        <a class="row-link" href="#/p/${p.id}/edit">${avatar(p.id, 'xs')} <span class="grow">${h(p.name)} ${p.active === false ? '<span class="muted small">(retired)</span>' : ''}</span><span class="muted">${ovr(p.id)} ›</span></a>`).join('') || '<p class="muted">No players yet.</p>'}
      ${players.length ? '' : `<button class="btn ghost block" data-a="seed-demo">👀 Load demo crew</button>`}
    </section>
    <section class="card">
      <div class="row-between"><h3>Rate players</h3><a class="btn sm hot" href="#/ratings">Open ›</a></div>
      <p class="muted small">Set everyone's rating yourself, or let the stats decide.</p>
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
        <label class="btn ghost grow file-btn">⬆ Restore<input type="file" accept="application/json,.json" data-ch="import" hidden></label>
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

function viewRatings() {
  const list = activePlayers().sort((a, b) => ovr(b.id) - ovr(a.id));
  const fromStats = E.statRatings(E.seasonTable(S.db, S.league, null));
  return `
    <a class="back" href="#/settings">‹ Settings</a>
    <section class="card">
      <h2>Rate players</h2>
      <p class="muted">Drag to set anyone's rating (40–99), then save. <b>📊 Stats say</b> is the app's rating from every logged game: how much he produces per game compared to the crew, his win %, and MVPs. After you save, ratings keep moving with every game.</p>
      <button type="button" class="btn ghost block" data-a="use-stat-ratings" ${Object.keys(fromStats).length ? '' : 'disabled'}>Use the stat rating for everyone</button>
      <form data-f="ratings" class="form rate-list">
        ${list.map((p) => {
          const cur = ovr(p.id);
          const sg = fromStats[p.id];
          return `
          <div class="rate-row">
            <div class="rate-head">${avatar(p.id, 'xs')} <b>${h(p.name)}</b>${p.nickname ? ` <span class="muted small">“${h(p.nickname)}”</span>` : ''}<span class="rate-now muted small">now ${cur}</span></div>
            <div class="rate-ctl">
              <input type="range" min="40" max="99" value="${cur}" data-pid="${p.id}" data-cur="${cur}" data-ch="rate" aria-label="${h(p.name)} rating">
              <output class="rate-val tier-${tier(cur)}">${cur}</output>
            </div>
            <div class="muted small">${sg
              ? `📊 Stats say <button type="button" class="linkish" data-a="use-stat" data-p="${p.id}" data-v="${sg.ovr}">${sg.ovr}</button> <span>(${sg.gp} games · tap to use)</span>`
              : '📊 Needs 2+ games for a stat rating'}</div>
          </div>`;
        }).join('')}
        <button class="btn hot block">Save ratings</button>
      </form>
    </section>`;
}

function setRateSlider(input, value) {
  input.value = value;
  CHANGE.rate(input);
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
  start: ({ g }) => run(() => api('POST', `/api/games/${g}/start`, { scorekeeperId: me() }), "🏈 Game on! You're the scorekeeper"),
  'log-type': ({ g, t }) => { S.log = { gameId: g, type: t, p1: null }; render(); },
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
  'use-stat': ({ p, v }) => setRateSlider($(`input[data-pid="${p}"][data-ch=rate]`), v),
  'use-stat-ratings': () => {
    const fromStats = E.statRatings(E.seasonTable(S.db, S.league, null));
    document.querySelectorAll('input[data-ch=rate]').forEach((el) => fromStats[el.dataset.pid] && setRateSlider(el, fromStats[el.dataset.pid].ovr));
    toast('Filled in the stat ratings. Hit Save to lock them in.');
  },
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
  'forget-pass': () => { S.pass = ''; lsSet('hfl.pass', ''); toast('Passcode forgotten on this phone'); render(); },
};

function submitLog({ p1, p2 }) {
  const L = S.log;
  S.log = null;
  const t = E.EVENT_TYPES[L.type];
  run(async () => {
    await api('POST', `/api/games/${L.gameId}/events`, { type: L.type, p1, p2, by: me() });
    const g = S.db.games.find((x) => x.id === L.gameId);
    const sc = gameInfo(g).summary.score;
    toast(`${t.emoji} ${t.label}${t.points ? `! ${teamName(g, 'A')} ${sc.A} – ${sc.B} ${teamName(g, 'B')}` : ` — ${nick(p1)}`}`);
  });
}

const CHANGE = {
  rate: (el) => {
    const v = Number(el.value);
    const out = el.parentElement.querySelector('output');
    out.textContent = v;
    out.className = `rate-val tier-${tier(v)}`;
    el.closest('.rate-row').classList.toggle('changed', v !== Number(el.dataset.cur));
  },
  season: (el) => { S.season = el.value; render(); },
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
  'my-nickname': async (d, form) => {
    const nickname = d.nickname.trim();
    const saved = await run(() => api('PATCH', `/api/players/${form.dataset.id}`, { nickname }), nickname ? `Nickname saved: “${nickname}” 🏈` : 'Nickname cleared');
    if (saved && location.hash === '#/nickname') location.hash = '#/';
  },
  ratings: (d, form) => {
    const ratings = {};
    form.querySelectorAll('input[data-ch=rate]').forEach((el) => {
      if (Number(el.value) !== Number(el.dataset.cur)) ratings[el.dataset.pid] = Number(el.value);
    });
    const n = Object.keys(ratings).length;
    if (!n) return toast('No ratings changed');
    run(() => api('POST', '/api/ratings', { ratings }), `⭐ Saved ${n} rating${n > 1 ? 's' : ''}`);
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
    const body = {
      name: d.name, nickname: d.nickname, position: d.position, number: d.number,
      emoji: d.emoji, color: d.color, startOvr: Number(d.startOvr),
    };
    if (id) body.active = !d.retired;
    const saved = await run(() => api(id ? 'PATCH' : 'POST', id ? `/api/players/${id}` : '/api/players', body), id ? 'Saved' : `${d.nickname || d.name} joined the HFL 🏈`);
    if (!saved) return;
    if (!id && !me()) { S.me = saved.id; lsSet('hfl.me', saved.id); }
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
  const el = e.target.closest('[data-ch="range-out"], [data-ch="rate"]');
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
      const dot = () => $('#live-dot').classList.toggle('on', navigator.onLine);
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
      (err) => { toast(err.message, true); },
    );
    setDb(db);
    if (!boot.started) {
      boot.started = true;
      window.addEventListener('hashchange', render);
    }
    render();
    ensureRoster();
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
  } catch (e) {
    $('#view').innerHTML = `<section class="card">${empty({ art: 'whistle', title: 'Can\'t reach the HFL server', text: h(e.message), cta: '<button class="btn hot" onclick="location.reload()">Try again</button>' })}</section>`;
  }
}

boot();
