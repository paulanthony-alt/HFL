// HFL server — zero dependencies. Stores everything in data/db.json and pushes
// live updates to every open phone over Server-Sent Events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES, POSITIONS, computeLeague, balanceTeams, teamOf } from './public/engine.js';
import { buildDemo } from './demo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 6 * 1024 * 1024;
const REACTIONS = ['🔥', '😂', '💀', '🧂', '🗑️'];
const FAME_CATEGORIES = ['best', 'dumb', 'drop'];
const ROUTE_STYLES = ['route', 'motion', 'block'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
export const newId = () => crypto.randomBytes(6).toString('base64url');
const now = () => new Date().toISOString();

export function emptyDb() {
  return {
    version: 0,
    settings: { crewName: 'HFL', season: String(new Date().getFullYear()) },
    players: [], games: [], posts: [], plays: [], fame: [],
  };
}

// ---------------------------------------------------------------------------
// Validation helpers

function str(v, max, { required = false, name = 'field' } = {}) {
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
  if ('startOvr' in body) p.startOvr = num(body.startOvr, 40, 99, { name: 'starting rating', int: true });
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

function buildRoutes(ctx) {
  const { dataDir } = ctx;
  const uploadsDir = path.join(dataDir, 'uploads');
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

  // Manual ratings: { ratings: { playerId: ovr } }. Stored as dated edits so games
  // played afterwards keep moving the rating from the new number.
  on('POST', '/api/ratings', (db, b) => {
    const entries = Object.entries(b.ratings || {});
    if (!entries.length) throw bad('no ratings to save');
    const at = now();
    for (const [id, value] of entries) {
      const p = player(db, id);
      const ovr = num(value, 40, 99, { name: `${p.name}'s rating`, int: true });
      p.ratingEdits = [...(p.ratingEdits || []), { at, ovr }].slice(-50);
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
  on('POST', '/api/fame', (db, b) => {
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
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 3 * 1024 * 1024) throw bad('photo is too big (3MB max)');
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, `${entry.id}.${ext}`), buf);
      entry.image = `/uploads/${entry.id}.${ext}`;
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
  on('DELETE', '/api/fame/:id', (db, b, { id }) => {
    const entry = find(db.fame, id, 'entry');
    if (entry.image) fs.rmSync(path.join(uploadsDir, path.basename(entry.image)), { force: true });
    db.fame = db.fame.filter((f) => f.id !== id);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Server

// Crew passcode set from inside the app. Kept out of db.json (so backups never carry
// it) and stored as a salted scrypt hash, never the passcode itself.
function passcodeStore(dataDir) {
  const file = path.join(dataDir, 'auth.json');
  let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const verified = new Set(); // hashing is slow on purpose; remember codes that already matched
  return {
    isSet: () => !!saved,
    check(given) {
      if (!saved) return true;
      if (verified.has(given)) return true;
      const hash = crypto.scryptSync(String(given), Buffer.from(saved.salt, 'hex'), 32);
      const ok = crypto.timingSafeEqual(hash, Buffer.from(saved.hash, 'hex'));
      if (ok) verified.add(given);
      return ok;
    },
    set(code) {
      verified.clear();
      if (!code) { saved = null; fs.rmSync(file, { force: true }); return; }
      const salt = crypto.randomBytes(16);
      saved = { salt: salt.toString('hex'), hash: crypto.scryptSync(code, salt, 32).toString('hex') };
      fs.writeFileSync(file, JSON.stringify(saved));
    },
  };
}

export function createHflServer({ dataDir = path.join(ROOT, 'data'), passcode = process.env.HFL_PASSCODE || '' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const appPass = passcodeStore(dataDir);
  const dbFile = path.join(dataDir, 'db.json');
  let db = fs.existsSync(dbFile) ? { ...emptyDb(), ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) } : emptyDb();

  const save = () => {
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dbFile);
  };

  const clients = new Set();
  const broadcast = () => {
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ version: db.version })}\n\n`);
  };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  const routes = buildRoutes({ dataDir });

  // HFL_PASSCODE on the server wins; otherwise whatever was set in the app (if anything).
  const passRequired = () => !!passcode || appPass.isSet();
  const authed = (req, url) => {
    const given = String(req.headers['x-hfl-pass'] || url.searchParams.get('pass') || '');
    if (passcode) {
      const a = Buffer.from(given), b = Buffer.from(passcode);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    return appPass.check(given);
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('invalid JSON')); }
    });
    req.on('error', reject);
  });

  const serveFile = (res, file, cache) => {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
      res.end(data);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p.startsWith('/api/')) {
        if (p === '/api/auth') return send(res, 200, { required: passRequired(), ok: authed(req, url), managedBy: passcode ? 'server' : 'app' });
        if (!authed(req, url)) return send(res, 401, { error: 'wrong crew passcode' });
        if (req.method === 'POST' && p === '/api/passcode') {
          if (passcode) throw bad('the passcode is set on the server (HFL_PASSCODE), change it there');
          const body = await readBody(req);
          const code = str(body.passcode, 32, { name: 'passcode' });
          if (code && code.length < 4) throw bad('passcode needs at least 4 characters');
          appPass.set(code);
          // Tell every open phone to re-check, so they get asked for the new code.
          for (const c of clients) c.write('event: auth\ndata: {}\n\n');
          return send(res, 200, { ok: true, required: passRequired() });
        }
        if (req.method === 'GET' && p === '/api/state') return send(res, 200, { db });
        if (req.method === 'GET' && p === '/api/export') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="hfl-backup.json"' });
          return res.end(JSON.stringify(db, null, 2));
        }
        if (req.method === 'GET' && p === '/api/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`event: change\ndata: ${JSON.stringify({ version: db.version })}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(p);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const body = await readBody(req);
          // Mutate a copy so a validation error halfway through never leaves junk behind.
          const draft = structuredClone(db);
          const result = r.handler(draft, body || {}, params);
          draft.version = db.version + 1;
          db = draft;
          save();
          broadcast();
          return send(res, 200, { ok: true, result: result ?? null, db });
        }
        return send(res, 404, { error: 'no such endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      if (p.startsWith('/uploads/')) {
        return serveFile(res, path.join(dataDir, 'uploads', path.basename(p)), 'public, max-age=31536000, immutable');
      }
      const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, 'no-cache');
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'something broke on the server' });
    }
  });
  server.on('close', () => { clearInterval(heartbeat); for (const r of clients) r.end(); clients.clear(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createHflServer({ dataDir: process.env.HFL_DATA_DIR || path.join(ROOT, 'data') }).listen(port, () => {
    console.log(`🏈 HFL is live on http://localhost:${port}`);
    if (!process.env.HFL_PASSCODE) console.log('   (no HFL_PASSCODE set — anyone with the link can edit)');
  });
}
