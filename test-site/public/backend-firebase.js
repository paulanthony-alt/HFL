// Firebase backend: the app talks straight to Firestore, no server of our own.
//
// Layout (every document is { json, rev }: the item as JSON plus a revision counter):
//   players/{id}  games/{id}  posts/{id}  plays/{id}  fame/{id}   one document per item
//   meta/settings                                                   crew name + season
//   images/{file}  { data, mime }                                   Hall of Fame photos
//
// Changes run the exact same league rules as the local server (league.js) on a draft
// of the league, then the documents that changed are written in one transaction.
// Each write checks the document's rev first, so two phones changing the same game at
// the same moment can't clobber each other: the loser re-runs on fresh data.
import * as F from './vendor/firebase.js';
import { buildRoutes, matchRoute, emptyDb, HttpError } from './league.js';

// The one shared login the whole crew uses. firestore.rules only lets this account in.
export const CREW_EMAIL = 'crew@hfl.app';

const COLLECTIONS = ['players', 'games', 'posts', 'plays', 'fame'];
// TEST SITE: every Firestore collection gets this prefix (test_players, test_games, test_meta...),
// so this copy never reads or writes the real league's data, even in the same Firebase project.
export const DB_PREFIX = 'test_';
const MAX_TX_WRITES = 450; // Firestore allows 500 writes per transaction

function friendly(err) {
  if (err instanceof HttpError) return err;
  const code = err?.code || '';
  const msg = {
    'auth/invalid-credential': "Wrong crew password (or the crew account isn't set up yet)",
    'auth/wrong-password': 'Wrong crew password',
    'auth/user-not-found': `No crew account yet. Create ${CREW_EMAIL} in Firebase → Authentication`,
    'auth/invalid-email': `No crew account yet. Create ${CREW_EMAIL} in Firebase → Authentication`,
    'auth/operation-not-allowed': 'Turn on Email/Password sign-in in Firebase → Authentication',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again',
    'auth/weak-password': 'The password needs at least 6 characters',
    'auth/network-request-failed': 'No connection. Try again when you have signal',
    'auth/requires-recent-login': 'Sign out and back in, then try again',
    'permission-denied': 'Firebase blocked that. Check the security rules (setup step 5)',
    unavailable: 'No connection. Try again when you have signal',
    'failed-precondition': 'No connection. Try again when you have signal',
    aborted: 'Lots going on right now. Try again',
  }[code.replace(/^firestore\//, '')];
  return new HttpError(503, msg || err?.message || 'Something went wrong');
}

export async function connectFirebase(config) {
  const app = F.initializeApp(config);
  const auth = F.getAuth(app);
  let fs;
  try {
    // Keep a copy on the phone so the app opens instantly and survives bad signal.
    fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    fs = F.initializeFirestore(app, {});
  }
  if (config.useEmulators) { // local testing against the Firebase emulators
    F.connectAuthEmulator(auth, config.useEmulators.auth, { disableWarnings: true });
    F.connectFirestoreEmulator(fs, ...config.useEmulators.firestore);
  }

  const routes = buildRoutes({ imageUrl: (file) => `fsimg:${file}` });
  const cache = { settings: null, settingsRev: 0 };
  for (const c of COLLECTIONS) cache[c] = new Map(); // id → { obj, rev }
  let version = 0;
  let unsubs = [];
  const images = new Map();

  const put = (coll, id, data) => {
    if (coll === 'meta') {
      cache.settings = data ? JSON.parse(data.json) : null;
      cache.settingsRev = data?.rev || 0;
    } else if (data) cache[coll].set(id, { obj: JSON.parse(data.json), rev: data.rev || 0 });
    else cache[coll].delete(id);
  };
  const snapshotDb = () => {
    const db = { version, settings: { ...emptyDb().settings, ...(cache.settings || {}) } };
    for (const c of COLLECTIONS) db[c] = [...cache[c].values()].map((e) => e.obj);
    return db;
  };
  const buildDb = () => { version++; return snapshotDb(); };
  const revOf = (coll, id) => (coll === 'meta' ? cache.settingsRev : cache[coll].get(id)?.rev || 0);
  const ref = (coll, id) => F.doc(fs, DB_PREFIX + coll, id);

  function diff(base, draft) {
    const writes = [];
    for (const c of COLLECTIONS) {
      const before = new Map(base[c].map((o) => [o.id, JSON.stringify(o)]));
      const after = new Map(draft[c].map((o) => [o.id, o]));
      for (const [id, o] of after) if (before.get(id) !== JSON.stringify(o)) writes.push({ coll: c, id, obj: o });
      for (const id of before.keys()) if (!after.has(id)) writes.push({ coll: c, id, obj: null });
    }
    if (JSON.stringify(base.settings) !== JSON.stringify(draft.settings)) writes.push({ coll: 'meta', id: 'settings', obj: draft.settings });
    for (const w of writes) w.rev = revOf(w.coll, w.id);
    return writes;
  }
  const encode = (w) => ({ json: JSON.stringify(w.obj), rev: w.rev + 1 });

  function stop() {
    unsubs.forEach((u) => u());
    unsubs = [];
  }

  return {
    kind: 'firebase',
    projectId: config.projectId,

    auth: {
      current: () => auth.currentUser,
      waitForUser: () => new Promise((resolve) => { const un = F.onAuthStateChanged(auth, (u) => { un(); resolve(u); }); }),
      onChange: (cb) => F.onAuthStateChanged(auth, cb),
      async signIn(password) {
        try { await F.signInWithEmailAndPassword(auth, CREW_EMAIL, password); } catch (e) { throw friendly(e); }
      },
      async signOut() { stop(); await F.signOut(auth); },
      async changePassword(current, next) {
        if (!next || next.length < 6) throw new HttpError(400, 'The new password needs at least 6 characters');
        try {
          await F.reauthenticateWithCredential(auth.currentUser, F.EmailAuthProvider.credential(CREW_EMAIL, current));
          await F.updatePassword(auth.currentUser, next);
        } catch (e) { throw friendly(e); }
      },
    },

    // Live-subscribe to the whole league. Resolves with the first full copy; later
    // changes (from any phone) arrive through onChange.
    start(onChange, onError) {
      stop();
      return new Promise((resolve, reject) => {
        const waiting = new Set([...COLLECTIONS, 'meta']);
        let done = false;
        const arrived = (name) => {
          waiting.delete(name);
          if (!waiting.size && !done) { done = true; resolve(buildDb()); } else if (done) onChange(buildDb());
        };
        const fail = (err) => {
          stop();
          const e = friendly(err);
          if (!done) { done = true; reject(e); } else onError?.(e, err);
        };
        for (const c of COLLECTIONS) {
          unsubs.push(F.onSnapshot(F.collection(fs, DB_PREFIX + c), (snap) => {
            for (const ch of snap.docChanges()) put(c, ch.doc.id, ch.type === 'removed' ? null : ch.doc.data());
            arrived(c);
          }, fail));
        }
        unsubs.push(F.onSnapshot(ref('meta', 'settings'), (snap) => {
          put('meta', 'settings', snap.exists() ? snap.data() : null);
          arrived('meta');
        }, fail));
      });
    },

    // Same interface as the local server's API: method + URL + body → handler result.
    async request(method, path, body) {
      const hit = matchRoute(routes, method, path);
      if (!hit) throw new HttpError(404, 'no such action');
      const run = (db) => {
        const draft = structuredClone(db);
        const fx = { images: [] };
        const result = hit.route.handler(draft, body || {}, hit.params, fx);
        return { result, writes: diff(db, draft), fx };
      };

      let out = run(snapshotDb());
      try {
        if (out.writes.length > MAX_TX_WRITES) {
          // Restoring a big backup: too much for one transaction, write in batches.
          for (let i = 0; i < out.writes.length; i += 400) {
            const batch = F.writeBatch(fs);
            for (const w of out.writes.slice(i, i + 400)) w.obj === null ? batch.delete(ref(w.coll, w.id)) : batch.set(ref(w.coll, w.id), encode(w));
            await batch.commit();
          }
        } else {
          await F.runTransaction(fs, async (tx) => {
            for (let attempt = 0; attempt < 6; attempt++) {
              if (attempt) out = run(snapshotDb());
              let stale = false;
              for (const w of out.writes) {
                const snap = await tx.get(ref(w.coll, w.id));
                const rev = snap.exists() ? snap.data().rev || 0 : 0;
                if (rev !== w.rev) { put(w.coll, w.id, snap.exists() ? snap.data() : null); stale = true; }
              }
              if (stale) continue; // someone beat us to it: redo the change on their version
              for (const w of out.writes) w.obj === null ? tx.delete(ref(w.coll, w.id)) : tx.set(ref(w.coll, w.id), encode(w));
              for (const im of out.fx.images) {
                const r = ref('images', im.file);
                im.op === 'put' ? tx.set(r, { data: im.base64, mime: im.mime }) : tx.delete(r);
              }
              return;
            }
            throw new HttpError(409, 'Lots going on right now. Try again');
          });
        }
      } catch (e) {
        throw friendly(e);
      }
      // Show it right away; the live listener will confirm the same thing shortly.
      for (const w of out.writes) put(w.coll, w.id, w.obj === null ? null : encode(w));
      return { result: out.result, db: buildDb() };
    },

    async getImage(file) {
      if (!images.has(file)) {
        images.set(file, F.getDoc(ref('images', file)).then((s) => (s.exists() ? `data:${s.data().mime};base64,${s.data().data}` : null)));
      }
      return images.get(file);
    },

    // Is this phone actually hearing from Firestore right now? (fromCache flips to true
    // when the connection drops.) Read-only; used by the Cast screen. Returns unsubscribe.
    watchConnection(cb) {
      return F.onSnapshot(ref('meta', 'settings'), { includeMetadataChanges: true },
        (snap) => cb(!snap.metadata.fromCache), () => cb(false));
    },

    exportDb: () => snapshotDb(),
    stop,
  };
}
