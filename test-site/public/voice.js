// Voice logging: turn what someone says ("Kellen to Max, touchdown") into a play.
// Pure parsing lives here so it can be tested; the microphone plumbing is in app.js.
import { EVENT_TYPES } from './engine.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Words that sound like names but are really play words; never treat these as a player.
const STOP = new Set(['to', 'the', 'a', 'and', 'by', 'from', 'for', 'it', 'in', 'on', 'off', 'he', 'his', 'him', 'was', 'got', 'gets', 'touchdown', 'td', 'pick', 'picks', 'six', 'sack', 'sacked', 'drop', 'dropped', 'catch', 'caught', 'run', 'runs', 'score']);

// roster: [{ id, names: ['Kellen', 'K-Train', ...], team: 'A' | 'B' }]
// Returns every player mention in the order spoken: [{ id, team, at }].
export function findPlayers(text, roster) {
  const words = norm(text).split(' ').filter(Boolean);
  const hits = [];
  const used = new Set();
  // longest names first so "Big Mike" beats "Mike"
  const names = roster.flatMap((p) => p.names.filter(Boolean).map((n) => ({ p, w: norm(n).split(' ') })))
    .filter((x) => x.w.length && x.w[0]).sort((a, b) => b.w.length - a.w.length);
  for (const { p, w } of names) {
    for (let i = 0; i + w.length <= words.length; i++) {
      if ([...Array(w.length).keys()].some((k) => used.has(i + k))) continue;
      const ok = w.every((nw, k) => {
        const sw = words[i + k];
        if (sw === nw) return true;
        if (STOP.has(sw) || nw.length < 4) return false;
        return lev(sw, nw) <= 1 || (sw.length >= 4 && (sw + 's' === nw || nw + 's' === sw));
      });
      if (ok) { hits.push({ id: p.id, team: p.team, at: i }); for (let k = 0; k < w.length; k++) used.add(i + k); }
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return { words, mentions: hits.filter((h) => !seen.has(h.id) && seen.add(h.id)) };
}

const has = (t, re) => re.test(t);

// → { type, p1, p2 } or { error }
export function parsePlay(text, roster) {
  const t = ` ${norm(text)} `;
  if (!t.trim()) return { error: "Didn't hear anything" };
  const { words, mentions } = findPlayers(text, roster);
  const wordAt = (w) => words.indexOf(w);
  const td = has(t, / (touchdown|touch down|td|tuddy|score|scores|scored|to the house|house|six) /) && !has(t, / pick (six|6) /);
  const pickSix = has(t, / pick (six|6) | pick six|pick6 /) || (has(t, / (intercept\w*|picked|picks|pick|int) /) && td);
  const int = has(t, / (intercept\w*|picked|picks|pick off|picks off|pick|int) /);
  const sack = has(t, / (sack\w*) /);
  const drop = has(t, / (drop\w*|butter\w*) /);
  const incomplete = has(t, / (incomplete|incompletion|incomplet\w*|overthr\w*|underthr\w*|miss\w*|no good|broken up|batted) /);
  const rush = has(t, / (run|runs|ran|rush\w*|scrambl\w*|keeps it|keeper|takes it in|walks in) /);

  let type;
  if (pickSix) type = 'pick_six';
  else if (int) type = 'int';
  else if (sack) type = 'sack';
  else if (drop) type = 'drop';
  else if (incomplete) type = 'incomplete';
  else if (td) {
    const passed = mentions.length >= 2 && words.some((w, i) => (w === 'to' || w === 'from' || w === 'hits' || w === 'finds') && i > mentions[0].at && i < mentions[1].at);
    type = passed || (mentions.length >= 2 && !rush) ? 'pass_td' : 'rush_td';
  }
  else if (mentions.length >= 2) type = 'catch';
  else if (has(t, / (catch|caught|complete|completion) /)) return { error: 'Say who threw it and who caught it, like "Kellen to Max"' };
  else return { error: mentions.length ? `Heard ${mentions.length === 1 ? 'a name' : 'names'} but not the play. Try "touchdown", "catch", "pick", "sack" or "drop"` : 'Didn\'t catch a play or any names' };

  const def = EVENT_TYPES[type];
  if (!mentions.length) return { type, error: `Didn't catch who. Say a name with it, like "${type === 'rush_td' ? 'Lucas touchdown run' : type === 'sack' ? 'Ben sacks Kellen' : 'Boden picks off Kellen'}"` };
  const [n1, n2] = mentions;
  const byAt = wordAt('by');
  const toAt = words.findIndex((w, i) => w === 'to' && mentions[0] && i > mentions[0].at);
  const fromAt = wordAt('from');

  let p1 = null, p2 = null;
  if (type === 'rush_td') p1 = n1;
  else if (def.side === 'same') {
    // pass plays: QB first ("Kellen to Max"), unless it's "Max from Kellen"
    let qb = n1, rec = n2;
    if (n2 && fromAt > n1.at && fromAt < n2.at) [qb, rec] = [n2, n1];
    if (type === 'drop') {
      // drops: the receiver is p1. "Kellen to Max, dropped" → Max; "Max drops it" → Max
      const toPattern = n2 && toAt > n1.at && toAt < n2.at;
      [p1, p2] = toPattern ? [rec, qb] : [qb, rec];
    } else [p1, p2] = [qb, rec];
    if (!p2 && def.required) return { type, error: 'Say who threw it and who caught it, like "Kellen to Max, touchdown"' };
  } else {
    // defense plays: the defender is p1, the QB is on the other team
    if (byAt >= 0) {
      p1 = mentions.find((m) => m.at > byAt) || n1;
      p2 = mentions.find((m) => m !== p1 && m.team !== p1.team) || null;
    } else {
      // with a pass ("Kellen to Max, picked off by..." handled above) the first name is the defender
      p1 = n1;
      p2 = mentions.find((m) => m !== p1 && m.team !== p1.team) || null;
      // "Kellen to Max ... picked" with no defender named: the passer was the victim
      const others = mentions.filter((m) => m.team !== n1.team);
      if (!others.length && mentions.length >= 2) return { type, error: `Who made the ${def.label.toLowerCase()}? Say "...by <name>"` };
      if (mentions.length === 1 && has(t, / (got|gets|was|is|been) (sacked|picked|intercepted)/)) return { type, error: `Who made the ${def.label.toLowerCase()}? Say "...by <name>"` };
    }
  }
  // same/other team check (the server double-checks)
  if (p1 && p2) {
    const want = def.side === 'same' ? p1.team : p1.team === 'A' ? 'B' : 'A';
    if (p2.team !== want) {
      return { type, error: def.side === 'same' ? 'Those two are on different teams' : 'Those two are on the same team' };
    }
  }
  return { type, p1: p1?.id || null, p2: p2?.id || null };
}

export const VOICE_EXAMPLES = ['Kellen to Max, touchdown', 'Lucas touchdown run', 'Max catch from Kellen', 'Boden picks off Kellen', 'Ben sacks Kellen', 'Dane dropped it', 'Kellen incomplete to Henry', 'Pick six, Max off Ben'];
