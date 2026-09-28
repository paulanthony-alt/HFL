// Runs the Firebase backend against a tiny fake of the Firestore REST API, so the
// wire format, token flow, chunking and startup migration are all exercised offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firestoreStore, storeFromEnv } from '../storage.js';
import { createHflServer } from '../server.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account', project_id: 'hfl-test', client_email: 'hfl@hfl-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

let fake, base, docs, tokenCalls, commits;
before(async () => {
  docs = new Map();
  tokenCalls = 0;
  commits = [];
  fake = http.createServer(async (req, res) => {
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/token') {
      const jwt = new URLSearchParams(body).get('assertion');
      const [h, c, sig] = jwt.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      if (!ok || claims.iss !== SA.client_email || !claims.scope.includes('datastore')) return json(401, { error: 'invalid_grant' });
      tokenCalls++;
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }
    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: { message: 'no token' } });
    const prefix = '/v1/projects/hfl-test/databases/(default)/documents';
    const url = decodeURIComponent(req.url);
    if (req.method === 'POST' && url === `${prefix}:commit`) {
      const { writes } = JSON.parse(body);
      commits.push(writes);
      for (const w of writes) {
        if (w.update) {
          const size = Buffer.byteLength(JSON.stringify(w.update.fields));
          if (size > 1048576) return json(400, { error: { message: 'document too big' } });
          docs.set(w.update.name, w.update.fields);
        } else docs.delete(w.delete);
      }
      return json(200, { writeResults: [] });
    }
    if (req.method === 'GET' && url.startsWith(`${prefix}/`)) {
      const name = url.slice('/v1/'.length);
      return docs.has(name) ? json(200, { name, fields: docs.get(name) }) : json(404, { error: { message: 'not found' } });
    }
    json(404, { error: { message: 'bad route ' + url } });
  });
  await new Promise((r) => fake.listen(0, r));
  base = `http://localhost:${fake.address().port}`;
});
after(() => fake.close());

const mkStore = (collection = 'hfl') => firestoreStore(SA, { collection, apiBase: `${base}/v1`, tokenUrl: `${base}/token` });

test('saves and loads the league, reusing the login token', async () => {
  const store = mkStore('t1');
  assert.equal(await store.load(), null);
  const db = { version: 3, settings: { crewName: 'HFL' }, players: [{ id: 'a', name: 'Marcus' }], games: [], posts: [], plays: [], fame: [] };
  await store.save(db);
  assert.deepEqual(await store.load(), db);
  assert.deepEqual(await mkStore('t1').load(), db, 'a fresh connection reads the same data');
  assert.equal(tokenCalls <= 2, true);
});

test('big leagues are split across documents in one atomic commit, and shrink back', async () => {
  const store = mkStore('t2');
  // random text doesn't compress, so this forces ~3 chunks
  const big = { version: 1, blob: crypto.randomBytes(1_800_000).toString('base64') };
  await store.save(big);
  const last = commits.at(-1);
  assert.ok(last.length >= 3, 'state + extra chunks written together');
  assert.deepEqual(await mkStore('t2').load(), big);
  await store.save({ version: 2, small: true });
  assert.ok(commits.at(-1).some((w) => w.delete?.endsWith('/t2/state-1')), 'old chunks are deleted');
  assert.deepEqual(await mkStore('t2').load(), { version: 2, small: true });
});

test('passcode hash and photos round-trip', async () => {
  const store = mkStore('t3');
  assert.equal(await store.loadAuth(), null);
  await store.saveAuth({ salt: 'ab', hash: 'cd' });
  assert.deepEqual(await store.loadAuth(), { salt: 'ab', hash: 'cd' });
  await store.saveAuth(null);
  assert.equal(await store.loadAuth(), null);
  const png = crypto.randomBytes(5000);
  await store.putImage('x1.png', png, 'image/png');
  assert.deepEqual(await store.getImage('x1.png'), png);
  await store.deleteImage('x1.png');
  assert.equal(await store.getImage('x1.png'), null);
});

test('the full server runs on Firebase and migrates an existing local league once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-fb-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 7, settings: { crewName: 'Old Crew', season: '2026' }, players: [], games: [], posts: [], plays: [], fame: [] }));
  const server = await createHflServer({ dataDir: dir, passcode: '', store: mkStore('t4') });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  try {
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.db.settings.crewName, 'Old Crew', 'local league copied up');
    const r = await (await fetch(url + '/api/players', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Firebase Fred' }) })).json();
    assert.equal(r.db.version, 8);
    const stored = await mkStore('t4').load();
    assert.equal(stored.players[0].name, 'Firebase Fred', 'every change lands in Firestore');
    await (await fetch(url + '/api/passcode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: '6767' }) })).json();
    assert.ok(await mkStore('t4').loadAuth(), 'passcode stored in Firestore too');
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed save is reported and nothing changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-fb-'));
  const store = mkStore('t5');
  const server = await createHflServer({ dataDir: dir, passcode: '', store });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  try {
    const realSave = store.save;
    store.save = async () => { throw new Error('offline'); };
    const res = await fetch(url + '/api/players', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ghost' }) });
    assert.equal(res.status, 503);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.db.players.length, 0);
    store.save = realSave;
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storeFromEnv picks the backend and gives helpful errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfl-env-'));
  assert.equal(storeFromEnv({}, dir).kind, 'file');
  assert.equal(storeFromEnv({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA) }, dir).kind, 'firestore');
  assert.equal(storeFromEnv({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(SA)).toString('base64') }, dir).kind, 'firestore');
  const f = path.join(dir, 'key.json');
  fs.writeFileSync(f, JSON.stringify(SA));
  assert.equal(storeFromEnv({ FIREBASE_SERVICE_ACCOUNT_FILE: f }, dir).kind, 'firestore');
  assert.throws(() => storeFromEnv({ FIREBASE_SERVICE_ACCOUNT: '{nope' }, dir), /not valid JSON/);
  assert.throws(() => storeFromEnv({ FIREBASE_SERVICE_ACCOUNT: '{"project_id":"x"}' }, dir), /missing "client_email"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
