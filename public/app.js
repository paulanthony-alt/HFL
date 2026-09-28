import * as E from './engine.js';
import { PlayEditor, playSVG, newPlay, playToPngBlob } from './playbook.js';

// ---------------------------------------------------------------------------
// State + helpers

const $ = (s, r = document) => r.querySelector(s);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } };

const S = {
  db: null, league: null,
  me: lsGet('hfl.me'), pass: lsGet('hfl.pass'),
  season: null, statTab: 'mvp', fameTab: 'best',
  log: null, editor: null, editorHash: null, after: null, pending: false, lastPath: null,
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
  if (!res.ok) throw new Error('Could not load the league');
  const { db } = await res.json();
  if (!S.db || db.version !== S.db.version) setDb(db, { remote });
}

function connectStream() {
  const es = new EventSource(`/api/stream?pass=${encodeURIComponent(S.pass)}`);
  es.addEventListener('change', (e) => {
    const { version } = JSON.parse(e.data);
    if (!S.db || version !== S.db.version) loadState(true).catch(() => {});
  });
  es.onopen = () => $('#live-dot').classList.add('on');
  es.onerror = () => $('#live-dot').classList.remove('on');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadState(true).catch(() => {});
  });
}

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
  $('#view').innerHTML = match.fn(...match.args, new URLSearchParams(qs || ''));
  S.after?.();
  renderChrome(match.tab);
  if (S.lastPath !== path) window.scrollTo(0, 0);
  S.lastPath = path;
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
  const status = g.status === 'live' ? '<span class="chip live">● LIVE</span>' : g.status === 'final' ? '<span class="chip">FINAL</span>' : '';
  return `
    <div class="scoreboard">
      <div class="sb-team ${w === 'A' ? 'win' : ''}"><div class="sb-name">${h(teamName(g, 'A'))}</div><div class="sb-score">${summary.score.A}</div></div>
      <div class="sb-mid">${status}<div class="sb-date">${h(fmtDate(g.date))}</div></div>
      <div class="sb-team ${w === 'B' ? 'win' : ''}"><div class="sb-name">${h(teamName(g, 'B'))}</div><div class="sb-score">${summary.score.B}</div></div>
    </div>`;
}

function describeEvent(ev) {
  const t = E.EVENT_TYPES[ev.type];
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
    safety: a,
    rush_td: a,
    pat1: a,
    pat2: a,
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
  if (s.safeties) parts.push(`${s.safeties} safety`);
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

  return `
    ${me() ? '' : `<a class="banner" href="#/me">👋 Tap here and pick who you are so your RSVPs, votes and posts count.</a>`}
    ${current ? gamePanel(current) : `
      <section class="card center">
        <div class="big-emoji">🏈</div>
        <h2>No game on the schedule</h2>
        <p class="muted">Set one up and the crew can start tapping in.</p>
        <a class="btn hot" href="#/new-game">+ Schedule a game</a>
      </section>`}
    ${[...live.slice(1), ...upcoming.filter((g) => g !== current)].map((g) => `
      <a class="row-link card-lite" href="#/g/${g.id}">
        <span>${g.status === 'live' ? '<span class="chip live">● LIVE</span>' : '📅'} ${h(fmtDate(g.date))} ${h(fmtTime(g.time))}</span>
        <span class="muted">${Object.values(g.rsvps).filter((s) => s === 'in').length} in ›</span>
      </a>`).join('')}
    ${current ? `<a class="btn ${current.status === 'final' ? 'hot' : 'ghost'} block" href="#/new-game">+ Schedule ${current.status === 'final' ? 'the next' : 'another'} game</a>` : ''}

    ${leaders.length ? `
      <h3 class="section">🏆 MVP race · ${h(S.db.settings.season)}</h3>
      <div class="podium">${leaders.map(([id, s], i) => `
        <a href="#/p/${id}" class="pod pod-${i + 1}">
          ${avatar(id, 'lg')}
          <div class="pod-name">${h(nick(id))}</div>
          <div class="pod-score">${Math.round(E.mvpScore(s))} pts</div>
        </a>`).join('')}
      </div>` : ''}

    ${finals.some((g) => g !== current) ? `
      <h3 class="section">Recent results</h3>
      ${finals.filter((g) => g !== current).slice(0, 6).map(resultRow).join('')}` : ''}
  `;
}

function resultRow(g) {
  const { summary, mvp } = gameInfo(g);
  const w = summary.winner;
  return `
    <a class="result card-lite" href="#/g/${g.id}">
      <div class="res-date">${h(fmtDate(g.date, { month: 'short', day: 'numeric' }))}</div>
      <div class="res-teams">
        <div class="${w === 'A' ? 'win' : ''}">${h(teamName(g, 'A'))} <b>${summary.score.A}</b></div>
        <div class="${w === 'B' ? 'win' : ''}">${h(teamName(g, 'B'))} <b>${summary.score.B}</b></div>
      </div>
      <div class="res-mvp">${mvp?.winner ? `👑 ${h(nick(mvp.winner))}` : ''}</div>
    </a>`;
}

function viewOnboarding() {
  return `
    <section class="hero">
      <div class="hero-logo">HFL</div>
      <p class="hero-tag">Your pickup league. Real stats. Zero mercy.</p>
    </section>
    <section class="card">
      <h2>Start the league</h2>
      <p class="muted">Add your crew, schedule a game, and let everyone tap in. Teams balance themselves and ratings update after every game.</p>
      <a class="btn hot block" href="#/new-player">+ Add the first player</a>
      <button class="btn ghost block" data-a="seed-demo">👀 Load a demo crew to try it out</button>
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
      <div>
        <div class="kicker">${g.status === 'scheduled' ? 'Next game' : g.status === 'live' ? 'Game on' : 'Final'}</div>
        <h2>${h(fmtDate(g.date, { weekday: 'long', month: 'short', day: 'numeric' }))}${g.time ? ` · ${h(fmtTime(g.time))}` : ''}</h2>
        ${g.location ? `<div class="muted">📍 ${h(g.location)}</div>` : ''}
      </div>
      <a class="icon-btn" href="#/g/${g.id}" aria-label="Game details">›</a>
    </div>`;
  if (g.status === 'scheduled') return `<section class="card">${head}${rsvpSection(g)}${teamsSection(g)}</section>`;
  if (g.status === 'live') return `<section class="card">${head}${liveSection(g)}</section>`;
  return `<section class="card">${head}${finalSection(g)}</section>`;
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
          <button class="btn big ${mine === 'in' ? 'in' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="in">✅ I'm in</button>
          <button class="btn big ${mine === 'out' ? 'out' : 'ghost'}" data-a="rsvp" data-g="${g.id}" data-p="${m}" data-s="out">❌ I'm out</button>
        </div>` : `<a class="btn ghost block" href="#/me">Pick who you are to RSVP</a>`}
      <div class="count"><b>${ins.length}</b> in${ins.length >= TARGET_PLAYERS ? ' — we got a game 🔥' : ` · need ${TARGET_PLAYERS - ins.length} more for 5v5`}</div>
      <div class="bar"><span style="width:${Math.min(100, (ins.length / TARGET_PLAYERS) * 100)}%"></span></div>
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
    <h3>⚖️ Teams</h3>
    ${hasTeams ? `
      ${teamColumns(g, { editable: true })}
      <p class="muted small">Tap a player to move him to the other side.</p>
      ${bench.length ? `<div class="chips-label">In but not on a team</div><div class="chips">${bench.map((p) => `<button class="pchip" data-a="bench-add" data-g="${g.id}" data-p="${p.id}">+ ${h(nick(p.id))}</button>`).join('')}</div>` : ''}
      <div class="btn-row">
        <button class="btn ghost" data-a="auto-teams" data-g="${g.id}">🔀 Reshuffle</button>
        <button class="btn hot grow" data-a="start" data-g="${g.id}">▶ Start game</button>
      </div>` : `
      <p class="muted">Once guys are in, the app splits them into the fairest teams it can find from everyone's rating.</p>
      <button class="btn hot block" data-a="auto-teams" data-g="${g.id}" ${ins.length < 2 ? 'disabled' : ''}>⚖️ Make balanced teams (${ins.length} in)</button>`}`;
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
    <h3 class="section">Play by play</h3>
    ${events.length ? `<ul class="feed">${events.map((ev) => eventRow(g, ev, true)).join('')}</ul>` : '<p class="muted">No plays logged yet.</p>'}
    <details class="card-lite"><summary>Rosters & live box score</summary>${boxScore(g, info)}</details>
    <button class="btn block danger-outline" data-a="final" data-g="${g.id}">🏁 Final whistle</button>`;
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
    <h3 class="section">Box score</h3>
    ${boxScore(g, info)}
    <p class="muted small">▲▼ = OVR change from this game (result vs. the odds, plus how much he balled out).</p>
    <details class="card-lite"><summary>Play by play (${g.events.length})</summary>
      <ul class="feed">${[...g.events].reverse().map((ev) => eventRow(g, ev, false)).join('')}</ul>
    </details>
    <a class="btn block" href="#/wall">🗣️ Talk trash about this one</a>`;
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
      <h3>👑 MVP of the day ${tally.winner ? `<span class="mvp-name">${h(nick(tally.winner))}</span>` : ''}</h3>
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
        <button class="btn hot block">📅 Put it on the schedule</button>
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
  const medal = (i) => ['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`;
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
    list = rows.filter((r) => r.s.defInt || r.s.sacks || r.s.safeties).sort((a, b) => (b.s.defInt * 5 + b.s.sacks * 3 + b.s.defTD * 6) - (a.s.defInt * 5 + a.s.sacks * 3 + a.s.defTD * 6));
    cols = [['INT', (s) => s.defInt], ['Pick6', (s) => s.defTD], ['Sacks', (s) => s.sacks], ['Sfty', (s) => s.safeties]];
  } else if (tab === 'ovr') {
    list = activePlayers().map((p) => ({ id: p.id, s: table[p.id] || E.blankStats() })).sort((a, b) => ovr(b.id) - ovr(a.id));
    cols = [['OVR', (s, id) => `<b>${ovr(id)}</b>`], ['Trend', (s, id) => {
      const hist = S.league.history[id] || [];
      const last = hist[hist.length - 1];
      return last?.delta ? deltaTag(last.delta) : '—';
    }]];
    note = 'Ratings move after every game: beat the odds and they go up.';
  }
  return `
    <div class="page-head">
      <h2>Leaderboards</h2>
      <select data-ch="season" aria-label="Season">
        ${seasons().map((s) => `<option value="${h(s)}" ${S.season === s ? 'selected' : ''}>Season ${h(s)}</option>`).join('')}
        <option value="career" ${S.season === 'career' ? 'selected' : ''}>Career</option>
      </select>
    </div>
    <div class="tabs-scroll">${Object.entries(STAT_TABS).map(([k, l]) => `<button class="tab-chip ${tab === k ? 'on' : ''}" data-a="stat-tab" data-t="${k}">${l}</button>`).join('')}</div>
    ${list.length ? `
      <table class="lb">
        <thead><tr><th></th><th class="l">Player</th>${cols.map(([c]) => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${list.map((r, i) => `
          <tr class="${r.id === me() ? 'me' : ''}">
            <td class="medal">${medal(i)}</td>
            <td class="l"><a href="#/p/${r.id}">${avatar(r.id, 'xs')} ${h(nick(r.id))}</a></td>
            ${cols.map(([, f]) => `<td>${f(r.s, r.id)}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>` : `<p class="muted center pad">Nothing here yet. Play some games and log some stats.</p>`}
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
      <div class="tc-art" style="--c:${h(p.color || '#ff6b1a')}"><span>${h(p.emoji || initials(p.name))}</span></div>
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
    <div class="page-head"><h2>Player cards</h2><a class="btn sm" href="#/new-player">+ Player</a></div>
    ${list.length ? `<div class="card-grid">${list.map((p) => tradingCard(p.id, { mini: true })).join('')}</div>` : '<p class="muted">No players yet.</p>'}`;
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
        </a>`).join('') : '<p class="muted">No games yet.</p>'}
    </section>

    ${fame.length ? `<section class="card"><h3>🏛️ In the Hall</h3>${fame.map((f) => `<div class="mini-fame">${FAME[f.category].emoji} <b>${h(f.title)}</b></div>`).join('')}</section>` : ''}
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
        <p class="muted small">Be honest. The app only uses this as a starting point — after that, his rating moves with every game he plays. 70 is an average dude.</p>
        ${p ? `<label class="check"><input type="checkbox" name="retired" ${p.active === false ? 'checked' : ''}> Retired (hide from RSVPs and cards, keep his stats)</label>` : ''}
        <button class="btn hot block">${p ? 'Save' : '+ Add to the league'}</button>
      </form>
    </section>`;
}

function viewMe() {
  const list = activePlayers();
  const m = me();
  return `
    <section class="card">
      <h2>Who are you?</h2>
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
    <div class="page-head"><h2>Playbook</h2><a class="btn sm hot" href="#/play/new">+ New play</a></div>
    ${plays.length ? `<div class="play-grid">${plays.map((pl) => `
      <a class="play-tile" href="#/play/${pl.id}">
        ${playSVG(pl, { cls: 'thumb' })}
        <div class="pt-name">${h(pl.name)}</div>
        <div class="muted small">${pl.authorId ? `by ${h(nick(pl.authorId))} · ` : ''}${h(ago(pl.updatedAt || pl.createdAt))}</div>
      </a>`).join('')}</div>` : `
      <section class="card center">
        <div class="big-emoji">📋</div>
        <h3>No plays yet</h3>
        <p class="muted">Draw routes with your finger, run the animation, and share it to the group chat before the game.</p>
        <a class="btn hot" href="#/play/new">Draw the first play</a>
      </section>`}`;
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
    ${latest ? `
      <section class="card">
        <div class="kicker">Last game · ${h(fmtDate(latest.date))}</div>
        <div class="mini-score">${h(teamName(latest, 'A'))} <b>${gameInfo(latest).summary.score.A}</b> – <b>${gameInfo(latest).summary.score.B}</b> ${h(teamName(latest, 'B'))}</div>
        ${mvpBlock(latest)}
      </section>` : ''}
    <section class="card">
      <h2>🗣️ Trash-talk wall</h2>
      ${m ? `
        <form data-f="post" class="form composer">
          <textarea name="text" maxlength="500" rows="3" required placeholder="Say it with your chest…"></textarea>
          <div class="btn-row">
            <select name="gameId" aria-label="About which game">
              <option value="">No game tag</option>
              ${finals.slice(0, 8).map((g) => `<option value="${g.id}" ${g === latest ? 'selected' : ''}>${h(fmtDate(g.date, { month: 'short', day: 'numeric' }))}</option>`).join('')}
            </select>
            <button type="button" class="btn ghost" data-a="roast" title="Generate a roast from real stats">🎲 Roast</button>
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
      </article>`).join('') || '<p class="muted center pad">Quiet in here. Too quiet.</p>'}`;
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
    <div class="page-head"><h2>🏛️ Hall of Fame</h2><a class="btn sm hot" href="#/fame/new">+ Enshrine</a></div>
    <div class="tabs-scroll">${Object.entries(FAME).map(([k, c]) => `<button class="tab-chip ${tab === k ? 'on' : ''}" data-a="fame-tab" data-t="${k}">${c.emoji} ${c.label} <span class="muted">${S.db.fame.filter((f) => f.category === k).length}</span></button>`).join('')}</div>
    ${list.map((f, i) => {
      const g = f.gameId && S.db.games.find((x) => x.id === f.gameId);
      return `
      <article class="fame ${i === 0 ? 'top' : ''}">
        ${f.image ? `<img src="${h(f.image)}" alt="" loading="lazy">` : ''}
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
    }).join('') || `<p class="muted center pad">Nothing enshrined yet. Tap 🏛️ on any logged play to save it forever.</p>`}`;
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
        <button class="btn hot block">🏛️ Enshrine it forever</button>
      </form>
    </section>`;
}

async function resizeImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read that image')); img.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
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
      <h3>Backup</h3>
      <p class="muted small">Download everything (players, games, stats, plays, posts) as one file. Restore it on any HFL server.</p>
      <div class="btn-row">
        <a class="btn ghost grow" href="/api/export?pass=${encodeURIComponent(S.pass)}" download="hfl-backup.json">⬇ Download backup</a>
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
// Actions (click), changes and forms

const A = {
  'seed-demo': () => run(() => api('POST', '/api/seed-demo'), 'Demo crew loaded 👀'),
  'set-me': ({ p }) => { S.me = p; lsSet('hfl.me', p); toast(`What's up, ${nick(p)} 👊`); location.hash = '#/'; render(); },
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
  passcode: async (d) => {
    S.pass = d.pass.trim();
    lsSet('hfl.pass', S.pass);
    boot();
  },
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
  const el = e.target.closest('[data-ch="range-out"]');
  if (el) CHANGE['range-out'](el);
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

async function boot() {
  try {
    const auth = await fetch('/api/auth', { headers: { 'x-hfl-pass': S.pass } }).then((r) => r.json());
    if (auth.required && !auth.ok) {
      $('#view').innerHTML = `
        <section class="hero"><div class="hero-logo">HFL</div><p class="hero-tag">Members only.</p></section>
        <section class="card">
          <form data-f="passcode" class="form">
            <label>Crew passcode <input name="pass" type="password" required autocomplete="current-password" autofocus></label>
            <button class="btn hot block">Let me in</button>
          </form>
          ${S.pass ? '<p class="muted small">That passcode didn\'t work.</p>' : ''}
        </section>`;
      return;
    }
    await loadState();
    if (!boot.started) {
      boot.started = true;
      connectStream();
      window.addEventListener('hashchange', render);
    }
    render();
  } catch (e) {
    $('#view').innerHTML = `<section class="card center"><h2>Can't reach the HFL server</h2><p class="muted">${h(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></section>`;
  }
}

boot();
