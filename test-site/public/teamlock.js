// Team playbooks: each game's two teams get a private playbook locked with a team PIN.
//
// Every phone downloads the whole league (and anyone can download a backup), so hiding team
// plays in the app wouldn't keep them private. Instead each team play is encrypted
// (AES-GCM) with a key made from the team PIN (PBKDF2, 200k rounds, random salt). The other
// team only ever sees scrambled data. The same PIN also makes a separate "proof" value; the
// league stores only its SHA-256, so writing to a team playbook needs the PIN, not a login.
//
// Honest limits: this keeps the other team out of your plays, including through backups and
// the browser's developer tools. A determined person with a laptop could still guess a short
// PIN offline (each guess is deliberately slow, but 4 digits is only 10,000 guesses), which is
// why the app asks for 6.
import { sha256hex } from './sha256.js';

export const TEAM_PIN = /^\d{4,8}$/;
export const PBKDF2_ROUNDS = 200_000;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// PIN + salt → { key (AES key, base64), proof (base64) }
async function secretsFor(pin, saltB64, iter) {
  const base = await subtle().importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', salt: fromB64(saltB64), iterations: iter, hash: 'SHA-256' }, base, 512));
  return { key: toB64(bits.slice(0, 32)), proof: toB64(bits.slice(32)) };
}

// A new lock for a team. `lock` is stored on the game (safe to share); `secrets` stay on the phone.
export async function makeLock(pin, { iter = PBKDF2_ROUNDS } = {}) {
  if (!TEAM_PIN.test(String(pin))) throw new Error('The team PIN has to be 4 to 8 digits');
  const salt = toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const secrets = await secretsFor(pin, salt, iter);
  return { lock: { v: 1, salt, iter, proofHash: sha256hex(secrets.proof) }, secrets };
}

// The right PIN → secrets; the wrong one → null.
export async function openLock(lock, pin) {
  if (!lock || !TEAM_PIN.test(String(pin))) return null;
  const secrets = await secretsFor(pin, lock.salt, lock.iter);
  return sha256hex(secrets.proof) === lock.proofHash ? secrets : null;
}

// Do these saved secrets still match the team's current lock (the PIN may have changed)?
export const secretsMatch = (lock, secrets) => !!(lock && secrets?.proof && sha256hex(secrets.proof) === lock.proofHash);

const aesKey = (keyB64, uses) => subtle().importKey('raw', fromB64(keyB64), 'AES-GCM', false, uses);

export async function encryptJSON(keyB64, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64, ['encrypt']), enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(keyB64, box) {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, await aesKey(keyB64, ['decrypt']), fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}
