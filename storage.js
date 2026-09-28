// Where the league lives. Two interchangeable backends with the same async interface:
//
//   fileStore      data/db.json + data/uploads/  (default)
//   firestoreStore Google Firestore, used when FIREBASE_SERVICE_ACCOUNT is set
//
// Firestore is spoken to over its REST API with a service-account token signed
// right here, so the app still has zero npm dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Local files

export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'db.json');
  const authFile = path.join(dir, 'auth.json');
  const uploads = path.join(dir, 'uploads');
  const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const writeAtomic = (f, text) => {
    fs.writeFileSync(f + '.tmp', text);
    fs.renameSync(f + '.tmp', f);
  };
  return {
    kind: 'file',
    label: `local file (${dbFile})`,
    maxImageBytes: 3 * 1024 * 1024,
    async load() { return readJson(dbFile); },
    async save(db) { writeAtomic(dbFile, JSON.stringify(db)); },
    async loadAuth() { return readJson(authFile); },
    async saveAuth(auth) { auth ? writeAtomic(authFile, JSON.stringify(auth)) : fs.rmSync(authFile, { force: true }); },
    async putImage(name, buf) {
      fs.mkdirSync(uploads, { recursive: true });
      fs.writeFileSync(path.join(uploads, path.basename(name)), buf);
    },
    async getImage(name) {
      try { return fs.readFileSync(path.join(uploads, path.basename(name))); } catch { return null; }
    },
    async deleteImage(name) { fs.rmSync(path.join(uploads, path.basename(name)), { force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Firestore
//
// Layout inside the collection (default "hfl"):
//   state      { version, chunks, savedAt, data: gzip(JSON) part 0 }
//   state-1..  { data: part N }      only if the league ever outgrows one document
//   auth       { salt, hash }        crew passcode (hashed)
//   img-<file> { type, data }        Hall of Fame photos
// The whole league is one gzipped blob, so it costs one read at startup and one
// write per change, which keeps a crew comfortably inside Firebase's free plan.

// Firestore documents max out at 1 MiB; 700 KB stays under it even counting base64.
const CHUNK = 700 * 1024;

export function firestoreStore(sa, {
  collection = 'hfl',
  apiBase = 'https://firestore.googleapis.com/v1',
  tokenUrl = sa.token_uri || 'https://oauth2.googleapis.com/token',
  fetchImpl = fetch,
} = {}) {
  for (const k of ['project_id', 'client_email', 'private_key']) {
    if (!sa?.[k]) throw new Error(`Firebase service account is missing "${k}". Use the JSON file from Project settings → Service accounts.`);
  }
  const root = `projects/${sa.project_id}/databases/(default)/documents`;
  const docName = (id) => `${root}/${collection}/${id}`;
  let token = null;
  let lastChunks = 1;

  const b64url = (x) => Buffer.from(x).toString('base64url');
  async function accessToken() {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: tokenUrl, iat: now, exp: now + 3600,
    }))}`;
    const jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firebase login failed: ${data.error_description || data.error || res.status}`);
    token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (res.status === 404 && method === 'GET') return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || res.statusText;
      if (res.status === 403) throw new Error(`Firebase said no (403): ${msg}. Is Firestore turned on for project "${sa.project_id}"?`);
      throw new Error(`Firebase error ${res.status}: ${msg}`);
    }
    return data;
  }
  const getDoc = async (id) => (await call('GET', `${apiBase}/${docName(id)}`))?.fields || null;
  const commit = (writes) => call('POST', `${apiBase}/${root}:commit`, { writes });
  const update = (id, fields) => ({ update: { name: docName(id), fields } });
  const remove = (id) => ({ delete: docName(id) });
  const bytes = (buf) => ({ bytesValue: buf.toString('base64') });
  const readBytes = (v) => Buffer.from(v?.bytesValue || '', 'base64');

  return {
    kind: 'firestore',
    label: `Firebase project "${sa.project_id}" (collection "${collection}")`,
    maxImageBytes: 700 * 1024,

    async load() {
      const head = await getDoc('state');
      if (!head) return null;
      const n = Number(head.chunks?.integerValue || 1);
      lastChunks = n;
      const parts = [readBytes(head.data)];
      for (let i = 1; i < n; i++) parts.push(readBytes((await getDoc(`state-${i}`))?.data));
      return JSON.parse(zlib.gunzipSync(Buffer.concat(parts)).toString('utf8'));
    },

    async save(db) {
      const gz = zlib.gzipSync(JSON.stringify(db));
      const parts = [];
      for (let i = 0; i < gz.length || i === 0; i += CHUNK) parts.push(gz.subarray(i, i + CHUNK));
      const writes = [update('state', {
        version: { integerValue: String(db.version || 0) },
        chunks: { integerValue: String(parts.length) },
        savedAt: { timestampValue: new Date().toISOString() },
        data: bytes(parts[0]),
      })];
      parts.slice(1).forEach((p, i) => writes.push(update(`state-${i + 1}`, { data: bytes(p) })));
      for (let i = parts.length; i < lastChunks; i++) writes.push(remove(`state-${i}`));
      await commit(writes); // one atomic commit: readers never see half a league
      lastChunks = parts.length;
    },

    async loadAuth() {
      const f = await getDoc('auth');
      return f ? { salt: f.salt.stringValue, hash: f.hash.stringValue } : null;
    },
    async saveAuth(auth) {
      await commit([auth ? update('auth', { salt: { stringValue: auth.salt }, hash: { stringValue: auth.hash } }) : remove('auth')]);
    },

    async putImage(name, buf, type) {
      await commit([update(`img-${path.basename(name)}`, { type: { stringValue: type }, data: bytes(buf) })]);
    },
    async getImage(name) {
      const f = await getDoc(`img-${path.basename(name)}`);
      return f ? readBytes(f.data) : null;
    },
    async deleteImage(name) { await commit([remove(`img-${path.basename(name)}`)]); },
  };
}

// ---------------------------------------------------------------------------
// Pick a backend from the environment.
//   FIREBASE_SERVICE_ACCOUNT       the service-account JSON itself (or base64 of it)
//   FIREBASE_SERVICE_ACCOUNT_FILE  or a path to that JSON file
//   HFL_FIREBASE_COLLECTION        optional, defaults to "hfl"

export function storeFromEnv(env, dataDir) {
  let raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw && env.FIREBASE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
  if (!raw || !raw.trim()) return fileStore(dataDir);
  raw = raw.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded key file.'); }
  return firestoreStore(sa, { collection: env.HFL_FIREBASE_COLLECTION || 'hfl' });
}
