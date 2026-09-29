// League rules: validation and every change the app can make, shared by the Node
// server (server.js) and the Firebase backend that runs in the browser.
import { EVENT_TYPES, POSITIONS, ATTR_KEYS, ATTR_MIN, ATTR_MAX, computeLeague, balanceTeams, teamOf } from './engine.js';
import { buildDemo } from './demo.js';

const REACTIONS = ['🔥', '😂', '💀', '🧂', '🗑️'];

// The HFL crew. The first time the app opens a league without this roster
// (settings.rosterVersion), it clears out everyone else and adds these guys.
export const HFL_ROSTER = ['Kellen', 'Max', 'Boden', 'Liam', 'Evan', 'Henry', 'Matteo', 'Ben', 'Lucas', 'Paul', 'Dane'];
export const ROSTER_VERSION = 1;
const ROSTER_COLORS = ['#ff5a1f', '#36c8ff', '#ffc53d', '#2fd57b', '#ff3d5e', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#84cc16', '#e2e8f0'];
const FAME_CATEGORIES = ['best', 'dumb', 'drop'];
const ROUTE_STYLES = ['route', 'motion', 'block'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
};
const now = () => new Date().toISOString();
export const MAX_IMAGE_BYTES = 700 * 1024; // fits in one Firestore document with room to spare

export function emptyDb() {
  return {
    version: 0,
    settings: { crewName: 'HFL', season: String(new Date().getFullYear()) },
    players: [], games: [], posts: [], plays: [], fame: [],
  };
}

// ---------------------------------------------------------------------------
// Validation helpers

export function str(v, max, { required = false, name = 'field' } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} must be text`);
  const s = String(v).trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max})`);
  return s;
}
function num(v, lo, hi, { name = 'number', int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} must be between ${lo} and ${hi}`);
  return int ? Math.round(n) : Math.round(n * 10) / 10;
}
function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`${name} must be one of ${list.join(', ')}`);
  return v;
}
const color = (v, fallback) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);
function find(list, id, what) {
  const item = list.find((x) => x.id === id);
  if (!item) throw new HttpError(404, `${what} not found`);
  return item;
}
const player = (db, id, name = 'player') => {
  if (!id) throw bad(`${name} is required`);
  return find(db.players, id, name);
};

function cleanPlayer(body, existing = {}) {
  const p = { ...existing };
  if ('name' in body || !existing.id) p.name = str(body.name, 40, { required: true, name: 'name' });
  if ('nickname' in body) p.nickname = str(body.nickname, 40, { name: 'nickname' });
  if ('number' in body) p.number = body.number === '' || body.number === null ? '' : num(body.number, 0, 99, { name: 'jersey number', int: true });
  if ('position' in body) p.position = oneOf(body.position, POSITIONS, 'position');
  if ('startOvr' in body) p.startOvr = num(body.startOvr, ATTR_MIN, ATTR_MAX, { name: 'starting level', int: true });
  if ('emoji' in body) p.emoji = str(body.emoji, 16, { name: 'emoji' });
  if ('color' in body) p.color = color(body.color, existing.color || '#ff6b1a');
  if ('active' in body) p.active = !!body.active;
  return p;
}

function cleanPlay(body) {
  const players = Array.isArray(body.players) ? body.players : [];
  const routes = Array.isArray(body.routes) ? body.routes : [];
  if (players.length > 14) throw bad('too many players on the field');
  if (routes.length > 30) throw bad('too many routes');
  const cleanPlayers = players.map((p) => ({
    id: str(p.id, 16, { required: true, name: 'player id' }),
    label: str(p.label, 4, { name: 'label' }),
    side: oneOf(p.side, ['O', 'D'], 'side'),
    x: num(p.x, 0, 100, { name: 'x' }),
    y: num(p.y, 0, 120, { name: 'y' }),
    color: color(p.color, '#ffffff'),
  }));
  const ids = new Set(cleanPlayers.map((p) => p.id));
  const cleanRoutes = routes.map((r) => {
    if (!ids.has(r.pid)) throw bad('route belongs to a missing player');
    const pts = Array.isArray(r.points) ? r.points : [];
    if (pts.length < 2 || pts.length > 80) throw bad('route needs 2–80 points');
    return {
      id: str(r.id || newId(), 16, { name: 'route id' }),
      pid: r.pid,
      style: oneOf(r.style, ROUTE_STYLES, 'route style'),
      points: pts.map((pt) => [num(pt?.[0], 0, 100, { name: 'x' }), num(pt?.[1], 0, 120, { name: 'y' })]),
    };
  });
  return {
    name: str(body.name, 60, { required: true, name: 'play name' }),
    notes: str(body.notes, 600, { name: 'notes' }),
    formation: str(body.formation, 20, { name: 'formation' }),
    players: cleanPlayers,
    routes: cleanRoutes,
  };
}

function checkTeams(db, teams) {
  const A = Array.isArray(teams?.A) ? teams.A : [];
  const B = Array.isArray(teams?.B) ? teams.B : [];
  const seen = new Set();
  for (const id of [...A, ...B]) {
    player(db, id);
    if (seen.has(id)) throw bad('a player cannot be on both teams');
    seen.add(id);
  }
  return { A, B };
}

// ---------------------------------------------------------------------------
// Routes

// Every change to the league is one of these routes. Handlers are synchronous and
// work on a draft copy of the whole league; whoever runs them (the Node server or
// the Firebase backend in the browser) saves the draft only if the handler succeeds.
// Photo uploads and deletions are queued in fx.images for the backend to carry out.
// imageUrl turns a stored photo's file name into something an <img> can show.
export function buildRoutes({ imageUrl = (file) => `/uploads/${file}` } = {}) {
  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  const game = (db, id) => find(db.games, id, 'game');

  // --- settings / backup
  on('PATCH', '/api/settings', (db, b) => {
    if ('crewName' in b) db.settings.crewName = str(b.crewName, 30, { required: true, name: 'crew name' });
    if ('season' in b) db.settings.season = str(b.season, 20, { required: true, name: 'season' });
  });
  on('POST', '/api/seed-demo', (db) => {
    if (db.players.length) throw bad('demo data can only be loaded into an empty league');
    Object.assign(db, buildDemo(newId, db.settings.season));
  });
  on('POST', '/api/import', (db, b) => {
    const incoming = b?.db;
    for (const k of ['players', 'games', 'posts', 'plays', 'fame']) {
      if (!Array.isArray(incoming?.[k])) throw bad(`backup is missing "${k}"`);
    }
    const version = db.version;
    Object.assign(db, emptyDb(), incoming, { version });
  });

  // --- players
  // One-time roster setup. Removes every player who isn't on HFL_ROSTER, plus anything
  // that only makes sense with them (their games, posts, plays, Hall of Fame entries),
  // then adds whoever on the roster is missing. Safe to call repeatedly: once the
  // roster version is recorded it does nothing, so players added later are never touched.
  on('POST', '/api/setup-roster', (db, b, params, fx) => {
    if ((db.settings.rosterVersion || 0) >= ROSTER_VERSION) return { changed: false };
    const wanted = new Map(HFL_ROSTER.map((n) => [n.toLowerCase(), n]));
    const keep = new Map(); // roster name → existing player (first one wins)
    for (const p of db.players) {
      const key = String(p.name || '').trim().toLowerCase();
      if (wanted.has(key) && !keep.has(key)) keep.set(key, p);
    }
    const kept = new Set([...keep.values()].map((p) => p.id));
    const removed = new Set(db.players.filter((p) => !kept.has(p.id)).map((p) => p.id));
    const gone = (id) => id && removed.has(id);

    db.players = HFL_ROSTER.map((name, i) => (keep.has(name.toLowerCase()) ? { ...keep.get(name.toLowerCase()), name } : {
      id: newId(), name, nickname: '', number: '', position: 'ATH', startOvr: 70, emoji: '',
      color: ROSTER_COLORS[i % ROSTER_COLORS.length], active: true, createdAt: now(),
    }));
    db.games = db.games.filter((g) => ![...g.teams.A, ...g.teams.B, ...Object.keys(g.rsvps)].some(gone)
      && !g.events.some((e) => gone(e.p1) || gone(e.p2)));
    for (const g of db.games) {
      for (const id of Object.keys(g.mvpVotes)) if (gone(id) || gone(g.mvpVotes[id])) delete g.mvpVotes[id];
    }
    db.posts = db.posts.filter((p) => !gone(p.authorId));
    for (const p of db.posts) for (const e of Object.keys(p.reactions)) p.reactions[e] = p.reactions[e].filter((id) => !gone(id));
    db.plays = db.plays.filter((p) => !gone(p.authorId));
    const gameIds = new Set(db.games.map((g) => g.id));
    db.fame = db.fame.filter((f) => {
      const drop = gone(f.authorId) || f.playerIds.some(gone) || (f.gameId && !gameIds.has(f.gameId));
      if (drop && f.image) fx.images.push({ op: 'delete', file: f.image.split(/[/:]/).pop() });
      return !drop;
    });
    for (const f of db.fame) f.votes = f.votes.filter((id) => !gone(id));
    db.settings.rosterVersion = ROSTER_VERSION;
    return { changed: true, removed: removed.size, added: HFL_ROSTER.length - keep.size };
  });

  on('POST', '/api/players', (db, b) => {
    const p = cleanPlayer({ position: 'ATH', startOvr: 70, emoji: '', nickname: '', number: '', ...b });
    Object.assign(p, { id: newId(), active: true, createdAt: now(), color: color(b.color, '#ff6b1a') });
    db.players.push(p);
    return p;
  });
  on('PATCH', '/api/players/:id', (db, b, { id }) => {
    const i = db.players.findIndex((p) => p.id === id);
    if (i < 0) throw new HttpError(404, 'player not found');
    db.players[i] = cleanPlayer(b, db.players[i]);
    return db.players[i];
  });

  // Manual ratings, Madden style: { ratings: { playerId: { attrs: { spd: 88, ... }, position } } }.
  // (A plain number still works and sets all nine ratings to it.) Stored as dated edits so
  // games played afterwards keep moving the ratings from the new numbers.
  on('POST', '/api/ratings', (db, b) => {
    const entries = Object.entries(b.ratings || {});
    if (!entries.length) throw bad('no ratings to save');
    const at = now();
    for (const [id, value] of entries) {
      const p = player(db, id);
      const edit = { at };
      if (typeof value === 'number' || typeof value === 'string') {
        edit.ovr = num(value, ATTR_MIN, ATTR_MAX, { name: `${p.name}'s rating`, int: true });
      } else {
        if (value?.position !== undefined) p.position = oneOf(value.position, POSITIONS, 'position');
        const attrs = value?.attrs || {};
        if (Object.keys(attrs).length) {
          edit.attrs = {};
          for (const [k, v] of Object.entries(attrs)) {
            if (!ATTR_KEYS.includes(k)) throw bad(`unknown rating "${k}"`);
            edit.attrs[k] = num(v, ATTR_MIN, ATTR_MAX, { name: `${p.name}'s ${k.toUpperCase()}`, int: true });
          }
        }
      }
      if (edit.ovr !== undefined || edit.attrs) p.ratingEdits = [...(p.ratingEdits || []), edit].slice(-50);
    }
    return entries.length;
  });

  // --- games
  on('POST', '/api/games', (db, b) => {
    const date = str(b.date, 10, { required: true, name: 'date' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must look like 2026-09-28');
    const time = str(b.time, 5, { name: 'time' });
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw bad('time must look like 18:30');
    const g = {
      id: newId(), date, time,
      location: str(b.location, 80, { name: 'location' }),
      season: str(b.season || db.settings.season, 20, { name: 'season' }),
      teamNames: { A: str(b.teamNames?.A || 'Shirts', 24), B: str(b.teamNames?.B || 'Skins', 24) },
      status: 'scheduled', rsvps: {}, teams: { A: [], B: [] }, events: [], mvpVotes: {}, createdAt: now(),
    };
    db.games.push(g);
    return g;
  });
  on('PATCH', '/api/games/:id', (db, b, { id }) => {
    const g = game(db, id);
    if ('date' in b) {
      const d = str(b.date, 10, { required: true, name: 'date' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('date must look like 2026-09-28');
      g.date = d;
    }
    if ('time' in b) g.time = str(b.time, 5, { name: 'time' });
    if ('location' in b) g.location = str(b.location, 80, { name: 'location' });
    if ('season' in b) g.season = str(b.season, 20, { required: true, name: 'season' });
    if (b.teamNames) {
      if ('A' in b.teamNames) g.teamNames.A = str(b.teamNames.A, 24, { required: true, name: 'team name' });
      if ('B' in b.teamNames) g.teamNames.B = str(b.teamNames.B, 24, { required: true, name: 'team name' });
    }
    return g;
  });
  on('DELETE', '/api/games/:id', (db, b, { id }) => {
    game(db, id);
    db.games = db.games.filter((g) => g.id !== id);
  });
  on('POST', '/api/games/:id/rsvp', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'scheduled') throw bad('RSVPs are closed once the game starts');
    player(db, b.playerId);
    if (b.status === null || b.status === '') delete g.rsvps[b.playerId];
    else g.rsvps[b.playerId] = oneOf(b.status, ['in', 'out'], 'status');
    return g;
  });
  on('POST', '/api/games/:id/auto-teams', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'scheduled') throw bad('teams are locked once the game starts');
    const league = computeLeague(db);
    const ins = db.players.filter((p) => p.active !== false && g.rsvps[p.id] === 'in');
    if (ins.length < 2) throw bad('need at least 2 players in to make teams');
    const res = balanceTeams(ins.map((p) => ({ id: p.id, elo: league.elo[p.id], position: p.position })));
    g.teams = { A: res.A, B: res.B };
    return g;
  });
  on('PUT', '/api/games/:id/teams', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status === 'final') throw bad('reopen the game to change teams');
    g.teams = checkTeams(db, b.teams);
    return g;
  });
  on('POST', '/api/games/:id/start', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'scheduled') throw bad('game already started');
    if (!g.teams.A.length || !g.teams.B.length) throw bad('pick teams first');
    g.status = 'live';
    g.startedAt = now();
    if (b.scorekeeperId) g.scorekeeperId = player(db, b.scorekeeperId, 'scorekeeper').id;
    return g;
  });
  on('POST', '/api/games/:id/final', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'live') throw bad('game is not live');
    g.status = 'final';
    g.endedAt = now();
    return g;
  });
  on('POST', '/api/games/:id/reopen', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'final') throw bad('game is not final');
    g.status = 'live';
    return g;
  });
  on('POST', '/api/games/:id/events', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status === 'scheduled') throw bad('start the game first');
    const t = EVENT_TYPES[b.type];
    if (!t) throw bad('unknown play type');
    const team = teamOf(g, b.p1);
    if (!team) throw bad(`${t.prompts[0]} must be playing in this game`);
    let p2 = null;
    if (b.p2 && t.roles[1]) {
      const team2 = teamOf(g, b.p2);
      const want = t.side === 'same' ? team : team === 'A' ? 'B' : 'A';
      if (team2 !== want) throw bad(`${t.prompts[1]} must be on the ${t.side === 'same' ? 'same' : 'other'} team`);
      if (b.p2 === b.p1) throw bad('pick two different players');
      p2 = b.p2;
    } else if (t.required) throw bad(`${t.prompts[1]} is required`);
    const ev = { id: newId(), type: b.type, p1: b.p1, p2, team, ts: now(), by: b.by || null };
    g.events.push(ev);
    return ev;
  });
  on('DELETE', '/api/games/:id/events/:eid', (db, b, { id, eid }) => {
    const g = game(db, id);
    find(g.events, eid, 'play');
    g.events = g.events.filter((e) => e.id !== eid);
  });
  on('POST', '/api/games/:id/mvp', (db, b, { id }) => {
    const g = game(db, id);
    if (g.status !== 'final') throw bad('MVP voting opens after the final whistle');
    if (!teamOf(g, b.voterId)) throw bad('only guys who played can vote');
    if (!teamOf(g, b.playerId)) throw bad('vote for someone who played');
    if (b.voterId === b.playerId) throw bad('nice try. no voting for yourself');
    g.mvpVotes[b.voterId] = b.playerId;
    return g;
  });

  // --- trash talk wall
  on('POST', '/api/posts', (db, b) => {
    const post = {
      id: newId(), authorId: player(db, b.authorId, 'author').id,
      text: str(b.text, 500, { required: true, name: 'post' }),
      gameId: b.gameId ? game(db, b.gameId).id : null,
      reactions: {}, createdAt: now(),
    };
    db.posts.push(post);
    return post;
  });
  on('POST', '/api/posts/:id/react', (db, b, { id }) => {
    const post = find(db.posts, id, 'post');
    const emoji = oneOf(b.emoji, REACTIONS, 'reaction');
    player(db, b.playerId);
    const list = (post.reactions[emoji] ||= []);
    const i = list.indexOf(b.playerId);
    if (i >= 0) list.splice(i, 1); else list.push(b.playerId);
    return post;
  });
  on('DELETE', '/api/posts/:id', (db, b, { id }) => {
    find(db.posts, id, 'post');
    db.posts = db.posts.filter((p) => p.id !== id);
  });

  // --- playbook
  on('POST', '/api/plays', (db, b) => {
    const play = { id: newId(), ...cleanPlay(b), authorId: b.authorId || null, createdAt: now(), updatedAt: now() };
    db.plays.push(play);
    return play;
  });
  on('PUT', '/api/plays/:id', (db, b, { id }) => {
    const play = find(db.plays, id, 'play');
    Object.assign(play, cleanPlay(b), { updatedAt: now() });
    return play;
  });
  on('DELETE', '/api/plays/:id', (db, b, { id }) => {
    find(db.plays, id, 'play');
    db.plays = db.plays.filter((p) => p.id !== id);
  });

  // --- hall of fame
  on('POST', '/api/fame', (db, b, params, fx) => {
    const entry = {
      id: newId(),
      category: oneOf(b.category, FAME_CATEGORIES, 'category'),
      title: str(b.title, 80, { required: true, name: 'title' }),
      description: str(b.description, 600, { name: 'description' }),
      playerIds: (Array.isArray(b.playerIds) ? b.playerIds : []).slice(0, 10).map((pid) => player(db, pid).id),
      gameId: b.gameId ? game(db, b.gameId).id : null,
      eventId: b.eventId ? str(b.eventId, 16) : null,
      authorId: b.authorId ? player(db, b.authorId, 'author').id : null,
      votes: [], image: null, createdAt: now(),
    };
    if (b.image) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      if (!m) throw bad('photo must be a JPEG, PNG or WebP');
      if (Math.floor((m[2].length * 3) / 4) > MAX_IMAGE_BYTES) throw bad(`photo is too big (${MAX_IMAGE_BYTES / 1024}KB max)`);
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const file = `${entry.id}.${ext}`;
      fx.images.push({ op: 'put', file, base64: m[2], mime: `image/${m[1]}` });
      entry.image = imageUrl(file);
    }
    db.fame.push(entry);
    return entry;
  });
  on('POST', '/api/fame/:id/vote', (db, b, { id }) => {
    const entry = find(db.fame, id, 'entry');
    player(db, b.playerId);
    const i = entry.votes.indexOf(b.playerId);
    if (i >= 0) entry.votes.splice(i, 1); else entry.votes.push(b.playerId);
    return entry;
  });
  on('DELETE', '/api/fame/:id', (db, b, { id }, fx) => {
    const entry = find(db.fame, id, 'entry');
    if (entry.image) fx.images.push({ op: 'delete', file: entry.image.split(/[/:]/).pop() });
    db.fame = db.fame.filter((f) => f.id !== id);
  });

  return routes;
}

export function matchRoute(routes, method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
  }
  return null;
}
