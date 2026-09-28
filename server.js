// HFL local server — zero dependencies. Stores everything in data/db.json and pushes
// live updates to every open phone over Server-Sent Events. Used for running the app
// on your own computer (and by the tests); on Firebase Hosting the app talks to
// Firestore directly instead (see public/backend-firebase.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, bad, str, newId, emptyDb, buildRoutes, matchRoute } from './public/league.js';
import { fileStore } from './storage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 6 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

export { newId, emptyDb };

// ---------------------------------------------------------------------------
// Server

// Crew passcode set from inside the app. Kept out of the league data (so backups never
// carry it) and stored as a salted scrypt hash, never the passcode itself.
async function passcodeStore(store) {
  let saved = await store.loadAuth();
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
    async set(code) {
      let next = null;
      if (code) {
        const salt = crypto.randomBytes(16);
        next = { salt: salt.toString('hex'), hash: crypto.scryptSync(code, salt, 32).toString('hex') };
      }
      await store.saveAuth(next);
      saved = next;
      verified.clear();
    },
  };
}

export async function createHflServer({
  dataDir = path.join(ROOT, 'data'),
  passcode = process.env.HFL_PASSCODE || '',
  store = fileStore(dataDir),
} = {}) {
  const appPass = await passcodeStore(store);
  let db = { ...emptyDb(), ...((await store.load()) || {}) };

  // One change at a time: each waits for the previous one to be saved.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const clients = new Set();
  const broadcast = () => {
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ version: db.version })}\n\n`);
  };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  const routes = buildRoutes();

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
          await exclusive(() => appPass.set(code));
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
        const hit = matchRoute(routes, req.method, p);
        if (hit) {
          const body = await readBody(req);
          const result = await exclusive(async () => {
            // Mutate a copy so a validation error halfway through never leaves junk behind,
            // and only switch to it once it's safely stored.
            const draft = structuredClone(db);
            const fx = { images: [] };
            const out = hit.route.handler(draft, body || {}, hit.params, fx);
            for (const im of fx.images) if (im.op === 'put') await store.putImage(im.file, Buffer.from(im.base64, 'base64'), im.mime);
            draft.version = db.version + 1;
            try {
              await store.save(draft);
            } catch (err) {
              console.error('save failed:', err.message);
              throw new HttpError(503, "couldn't save that. Check the connection and try again");
            }
            db = draft;
            for (const im of fx.images) if (im.op === 'delete') await store.deleteImage(im.file).catch((e) => console.error('cleanup failed:', e.message));
            return out;
          });
          broadcast();
          return send(res, 200, { ok: true, result: result ?? null, db });
        }
        return send(res, 404, { error: 'no such endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      // Firebase Hosting serves the project config here; locally there is none (the app
      // then uses this server). 204 instead of 404 keeps the browser console clean.
      if (p.startsWith('/__/')) { res.writeHead(204); return res.end(); }
      if (p.startsWith('/uploads/')) {
        const name = path.basename(p);
        const buf = await store.getImage(name);
        if (!buf) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(name)] || 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(buf);
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
  const dataDir = process.env.HFL_DATA_DIR || path.join(ROOT, 'data');
  try {
    const store = fileStore(dataDir);
    console.log(`🏈 HFL starting. Saving to ${store.label}`);
    const server = await createHflServer({ dataDir, store });
    server.listen(port, () => console.log(`🏈 HFL is live on http://localhost:${port}`));
  } catch (err) {
    console.error(`\n❌ HFL couldn't start: ${err.message}\n`);
    process.exit(1);
  }
}
