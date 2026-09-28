// Where the local server keeps the league: data/db.json, the hashed passcode in
// data/auth.json, and Hall of Fame photos in data/uploads/.
import fs from 'node:fs';
import path from 'node:path';

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
