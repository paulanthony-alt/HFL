// HFL engine — pure game logic shared by the server, the browser and the tests.
// Nothing in here touches the DOM, the network or the disk.

export const DEFAULT_ELO = 1000;
// No centers in the HFL: the QB snaps it himself and four receivers go out.
export const POSITIONS = ['QB', 'WR', 'RB', 'DB', 'LB', 'RUSH', 'ATH'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------------------------------------------------------------------------
// Madden-style ratings
//
// Every player has sixteen ratings (20–99). Their overall (OVR) is a weighted mix of
// those ratings, and the mix depends on position, just like Madden: a QB's OVR is
// mostly throwing, a WR's is catching, routes and speed, and so on.

export const ATTR_MIN = 20;
export const ATTR_MAX = 99;
export const ATTRS = [
  { key: 'spd', short: 'SPD', label: 'Speed' },
  { key: 'acc', short: 'ACC', label: 'Acceleration' },
  { key: 'cth', short: 'CTH', label: 'Catching' },
  { key: 'rte', short: 'RTE', label: 'Route Running' },
  { key: 'rls', short: 'RLS', label: 'Release' },
  { key: 'thp', short: 'THP', label: 'Throw Power' },
  { key: 'tha', short: 'THA', label: 'Throw Accuracy' },
  { key: 'str', short: 'STR', label: 'Strength' },
  { key: 'mcv', short: 'MCV', label: 'Man Coverage' },
  { key: 'tak', short: 'TAK', label: 'Tackling' },
  { key: 'sta', short: 'STA', label: 'Stamina' },
  { key: 'bcv', short: 'BCV', label: 'Ball Carrier Vision' },
  { key: 'btk', short: 'BTK', label: 'Break Tackle' },
  { key: 'cod', short: 'COD', label: 'Change of Direction' },
  { key: 'jkm', short: 'JKM', label: 'Juke Move' },
  { key: 'car', short: 'CAR', label: 'Carrying' },
];
export const ATTR_KEYS = ATTRS.map((a) => a.key);
const DERIVED_FROM = { acc: 'spd', rls: 'rte', bcv: 'rte', btk: 'str', cod: 'spd', jkm: 'spd', car: 'cth' };

// How much each rating counts toward OVR at each position (each row adds up to 1).
export const POSITION_WEIGHTS = {
  QB:   { tha: 0.38, thp: 0.24, sta: 0.10, spd: 0.07, str: 0.06, acc: 0.06, bcv: 0.05, car: 0.04 },
  WR:   { cth: 0.24, rte: 0.20, spd: 0.15, rls: 0.10, acc: 0.08, cod: 0.06, bcv: 0.05, jkm: 0.04, car: 0.03, sta: 0.03, btk: 0.02 },
  RB:   { spd: 0.18, bcv: 0.14, btk: 0.13, acc: 0.12, jkm: 0.10, cod: 0.10, car: 0.08, str: 0.07, cth: 0.05, sta: 0.03 },
  DB:   { mcv: 0.34, spd: 0.20, acc: 0.13, tak: 0.12, cod: 0.08, cth: 0.07, sta: 0.06 },
  LB:   { tak: 0.32, str: 0.20, spd: 0.14, mcv: 0.14, acc: 0.10, sta: 0.10 },
  RUSH: { spd: 0.26, str: 0.24, tak: 0.22, acc: 0.20, sta: 0.08 },
  ATH:  { spd: 0.14, cth: 0.10, mcv: 0.10, acc: 0.08, sta: 0.08, rte: 0.07, tak: 0.07, str: 0.06, tha: 0.05, rls: 0.04, bcv: 0.04, cod: 0.04, car: 0.04, thp: 0.03, btk: 0.03, jkm: 0.03 },
};

// The ratings that matter most at a position, biggest first (shown on the card front).
export const keyAttrs = (position, n = 4) =>
  Object.entries(POSITION_WEIGHTS[position] || POSITION_WEIGHTS.ATH).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export const clampAttr = (v) => clamp(Math.round(Number(v)), ATTR_MIN, ATTR_MAX);
export function overallExact(attrs, position) {
  const w = POSITION_WEIGHTS[position] || POSITION_WEIGHTS.ATH;
  const x = Object.entries(w).reduce((sum, [k, wt]) => sum + wt * (attrs?.[k] ?? 70), 0);
  return Math.round(x * 1e6) / 1e6; // no floating-point dust from weights that add up to 1
}
export const overall = (attrs, position) => Math.round(clamp(overallExact(attrs, position), 1, 99));
export const positionOveralls = (attrs) => Object.fromEntries(POSITIONS.map((pos) => [pos, overall(attrs, pos)]));

// A player's ratings before any games: what the crew set, else their starting level.
export function baseAttrs(p) {
  const level = clamp(Number(p?.startOvr) || 70, ATTR_MIN, ATTR_MAX);
  return Object.fromEntries(ATTR_KEYS.map((k) => [k, p?.attrs?.[k] ?? level]));
}

// Internally OVR is also expressed on an Elo-like scale (10 points per OVR) so team
// odds and balancing can use the classic formula.
export const ovrToElo = (ovr) => DEFAULT_ELO + (Number(ovr ?? 70) - 70) * 10;
export const eloToOvr = (elo) => Math.round(clamp(70 + (elo - DEFAULT_ELO) / 10, 1, 99));
export const winProbability = (eloA, eloB) => 1 / (1 + Math.pow(10, (eloB - eloA) / 400));

// ---------------------------------------------------------------------------
// Live game events
// roles: who is picked, in order. `side` says which team the second pick comes
// from relative to the first ("same" = teammate, "other" = opponent).
// Points always go to the team of the first player picked.
export const EVENT_TYPES = {
  pass_td:    { label: 'TD Pass',    emoji: '🏈', points: 6, roles: ['qb', 'rec'],     prompts: ['QB', 'Receiver'], side: 'same',  required: true },
  rush_td:    { label: 'TD Run',     emoji: '💨', points: 6, roles: ['runner'],        prompts: ['Runner'] },
  catch:      { label: 'Catch',      emoji: '🙌', points: 0, roles: ['qb', 'rec'],     prompts: ['QB', 'Receiver'], side: 'same',  required: true },
  incomplete: { label: 'Incomplete', emoji: '❌', points: 0, roles: ['qb', 'rec'],     prompts: ['QB', 'Target'],   side: 'same',  required: false },
  drop:       { label: 'Drop',       emoji: '🧈', points: 0, roles: ['rec', 'qb'],     prompts: ['Who dropped it', 'QB'], side: 'same', required: false },
  int:        { label: 'INT',        emoji: '🦅', points: 0, roles: ['def', 'qb'],     prompts: ['Defender', 'QB who threw it'], side: 'other', required: false },
  pick_six:   { label: 'Pick Six',   emoji: '💰', points: 6, roles: ['def', 'qb'],     prompts: ['Defender', 'QB who threw it'], side: 'other', required: false },
  sack:       { label: 'Sack',       emoji: '💥', points: 0, roles: ['def', 'qb'],     prompts: ['Rusher', 'QB'],   side: 'other', required: false },
};

export function blankStats() {
  return {
    gp: 0, w: 0, l: 0, t: 0, mvps: 0,
    att: 0, comp: 0, passTD: 0, intThrown: 0, sacked: 0,
    rec: 0, targets: 0, recTD: 0, drops: 0, dropped: 0,
    rushTD: 0,
    defInt: 0, defTD: 0, sacks: 0,
  };
}

const STAT_KEYS = Object.keys(blankStats());

export function addStats(into, from) {
  for (const k of STAT_KEYS) into[k] += from[k] || 0;
  return into;
}

// Touchdowns a player personally scored (not TD passes thrown).
export const totalTDs = (s) => s.recTD + s.rushTD + s.defTD;

// NFL passer-rating formula minus the yardage term (nobody's measuring yards at the park),
// rescaled so a perfect game is still 158.3.
export function qbRating(s) {
  if (!s.att) return null;
  const a = clamp((s.comp / s.att - 0.3) * 5, 0, 2.375);
  const c = clamp((s.passTD / s.att) * 20, 0, 2.375);
  const d = clamp(2.375 - (s.intThrown / s.att) * 25, 0, 2.375);
  return ((a + c + d) / 4.5) * 100;
}

// One number for "how much did this guy swing the game". Drives the MVP race and
// the individual part of rating changes.
export function impactOf(s) {
  return (
    totalTDs(s) * 6 + s.passTD * 4 + s.comp * 0.5 + s.rec * 1 + s.defInt * 5 + s.sacks * 3 +
    -s.intThrown * 4 - s.drops * 2 - s.sacked
  );
}

export function eventRoles(ev) {
  const t = EVENT_TYPES[ev.type];
  const out = {};
  if (!t) return out;
  if (ev.p1) out[t.roles[0]] = ev.p1;
  if (ev.p2 && t.roles[1]) out[t.roles[1]] = ev.p2;
  return out;
}

function applyEvent(statFor, ev) {
  const r = eventRoles(ev);
  const s = (id) => (id ? statFor(id) : blankStats()); // missing optional role → throwaway bucket
  switch (ev.type) {
    case 'pass_td': { const q = s(r.qb); q.att++; q.comp++; q.passTD++; const w = s(r.rec); w.rec++; w.targets++; w.recTD++; break; }
    case 'catch': { const q = s(r.qb); q.att++; q.comp++; const w = s(r.rec); w.rec++; w.targets++; break; }
    case 'incomplete': { s(r.qb).att++; if (r.rec) s(r.rec).targets++; break; }
    case 'drop': { if (r.qb) { const q = s(r.qb); q.att++; q.dropped++; } const w = s(r.rec); w.drops++; w.targets++; break; }
    case 'int':
    case 'pick_six': {
      const d = s(r.def); d.defInt++; if (ev.type === 'pick_six') d.defTD++;
      if (r.qb) { const q = s(r.qb); q.att++; q.intThrown++; }
      break;
    }
    case 'sack': { s(r.def).sacks++; if (r.qb) s(r.qb).sacked++; break; }
    case 'rush_td': { s(r.runner).rushTD++; break; }
  }
}

export function teamOf(game, playerId) {
  if (game.teams?.A?.includes(playerId)) return 'A';
  if (game.teams?.B?.includes(playerId)) return 'B';
  return null;
}

// Score, per-player stat lines and result for one game.
export function summarizeGame(game) {
  const stats = {};
  const statFor = (id) => (stats[id] ||= blankStats());
  const score = { A: 0, B: 0 };
  for (const pid of [...(game.teams?.A || []), ...(game.teams?.B || [])]) statFor(pid);
  for (const ev of game.events || []) {
    const t = EVENT_TYPES[ev.type];
    if (!t) continue;
    applyEvent(statFor, ev);
    const team = ev.team || teamOf(game, ev.p1);
    if (t.points && (team === 'A' || team === 'B')) score[team] += t.points;
  }
  let winner = null;
  if (game.status === 'final') winner = score.A > score.B ? 'A' : score.B > score.A ? 'B' : 'tie';
  return { score, stats, winner };
}

// Crowd-voted MVP. Ties go to whoever had the bigger stat impact.
export function tallyMvp(game, summary) {
  const counts = {};
  for (const pick of Object.values(game.mvpVotes || {})) counts[pick] = (counts[pick] || 0) + 1;
  const ranked = Object.entries(counts)
    .map(([id, votes]) => ({ id, votes, impact: summary.stats[id] ? impactOf(summary.stats[id]) : 0 }))
    .sort((a, b) => b.votes - a.votes || b.impact - a.impact);
  return { ranked, winner: ranked[0]?.id || null, total: Object.keys(game.mvpVotes || {}).length };
}

export const gameSortKey = (g) => `${g.date || ''}T${g.time || '00:00'}|${g.createdAt || ''}`;
export const sortGames = (games) => [...games].sort((a, b) => (gameSortKey(a) < gameSortKey(b) ? -1 : 1));

// Madden-style progression: how one game moves each rating. Gains get harder near
// the top (diminishing returns), losses don't, and every rating nudges up or down a
// little depending on whether your team beat the odds.
export function progression(s, actual, expected, current = {}) {
  const incompletions = Math.max(0, s.att - s.comp - s.intThrown - s.dropped); // drops aren't on the QB
  const d = {
    cth: clamp(s.rec * 0.3 - s.drops * 1.0, -1.5, 1.5),
    rte: clamp(s.rec * 0.2 + s.recTD * 0.5, 0, 1.5),
    tha: clamp(s.comp * 0.2 - incompletions * 0.15 - s.intThrown * 1.0, -1.5, 1.5),
    thp: clamp(s.passTD * 0.4, 0, 1),
    spd: clamp(s.rushTD * 0.5 + s.defTD * 0.6 + s.sacks * 0.25, 0, 1),
    acc: clamp(s.rushTD * 0.4 + s.defTD * 0.4 + s.sacks * 0.2, 0, 1),
    rls: clamp(s.rec * 0.15 + s.recTD * 0.4, 0, 1),
    str: clamp(s.rushTD * 0.3 + s.sacks * 0.3, 0, 1),
    mcv: clamp(s.defInt * 0.8, 0, 1.5),
    tak: clamp(s.sacks * 0.5, 0, 1),
    sta: 0.2, // showing up and playing a full game
    // with the ball in his hands: finding the lane, shaking guys, not getting caught
    bcv: clamp(s.rushTD * 0.5 + s.recTD * 0.3 + s.defTD * 0.3, 0, 1),
    btk: clamp(s.rushTD * 0.4 + s.recTD * 0.2 + s.defTD * 0.4, 0, 1),
    cod: clamp(s.rushTD * 0.4 + s.recTD * 0.3 + s.defInt * 0.2, 0, 1),
    jkm: clamp(s.rushTD * 0.5 + s.recTD * 0.2 + s.defTD * 0.4, 0, 1),
    car: clamp((s.rec + s.rushTD + s.defInt) * 0.1, 0, 0.8),
  };
  const result = (actual - expected) * 1.2;
  for (const k of ATTR_KEYS) {
    let v = d[k] + result;
    if (v > 0) v *= clamp((ATTR_MAX - (current[k] ?? 70)) / 30, 0.1, 1);
    d[k] = Math.round(v * 100) / 100;
  }
  return d;
}

// Replays every finished game in order to derive current ratings. Ratings are never
// stored, so fixing a stat or deleting a game later keeps everything consistent.
// Manual ratings (player.ratingEdits: [{ at, attrs }] or the older [{ at, ovr }]) are
// replayed too: an edit sets the ratings at that moment, and games finished afterwards
// move them from there.
export function computeLeague(db) {
  const players = new Map((db.players || []).map((p) => [p.id, p]));
  const attrs = {};
  const history = {};
  const pos = (id) => players.get(id)?.position || 'ATH';
  const rating = (id) => overallExact(attrs[id], pos(id));
  for (const p of db.players || []) {
    attrs[p.id] = baseAttrs(p);
    history[p.id] = [{ gameId: null, date: (p.createdAt || '').slice(0, 10), elo: ovrToElo(rating(p.id)), delta: 0 }];
  }
  const ensure = (id) => {
    if (attrs[id] === undefined) { attrs[id] = baseAttrs(null); history[id] = [{ gameId: null, date: '', elo: DEFAULT_ELO, delta: 0 }]; }
  };
  const setOwn = {};
  const pending = (db.players || [])
    .flatMap((p) => (p.ratingEdits || []).map((e) => ({ ...e, id: p.id })))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const applyEditsBefore = (time) => {
    while (pending.length && pending[0].at < time) {
      const e = pending.shift();
      ensure(e.id);
      const before = rating(e.id);
      if (e.attrs) {
        for (const [k, v] of Object.entries(e.attrs)) { if (ATTR_KEYS.includes(k)) attrs[e.id][k] = clampAttr(v); }
        // Ratings added later (ACC, RLS, BCV, BTK, COD, JKM, CAR) start from their closest original one for players
        // who were rated before they existed, until they're set on their own.
        for (const [newKey, from] of Object.entries(DERIVED_FROM)) {
          if (e.attrs[newKey] !== undefined) (setOwn[e.id] ||= new Set()).add(newKey);
          else if (e.attrs[from] !== undefined && !setOwn[e.id]?.has(newKey)) attrs[e.id][newKey] = clampAttr(e.attrs[from]);
        }
      }
      else if (e.ovr !== undefined) for (const k of ATTR_KEYS) attrs[e.id][k] = clampAttr(e.ovr);
      const after = rating(e.id);
      history[e.id].push({ gameId: null, date: e.at.slice(0, 10), elo: ovrToElo(after), delta: Math.round((after - before) * 100) / 10, edit: true });
    }
  };
  const games = {};
  for (const g of sortGames(db.games || [])) {
    // Finished games count from when they ended; games not played yet see every edit.
    applyEditsBefore(g.status === 'final' ? g.endedAt || `${g.date}T23:59:59` : '9999');
    const summary = summarizeGame(g);
    const info = { summary, ratingChanges: null, attrChanges: null, mvp: null, winProbA: null };
    const A = g.teams?.A || [];
    const B = g.teams?.B || [];
    if (A.length && B.length) {
      [...A, ...B].forEach(ensure);
      const avgA = mean(A.map(rating));
      const avgB = mean(B.map(rating));
      info.winProbA = winProbability(ovrToElo(avgA), ovrToElo(avgB));
      if (g.status === 'final') {
        const actualA = summary.winner === 'A' ? 1 : summary.winner === 'B' ? 0 : 0.5;
        const margin = Math.abs(summary.score.A - summary.score.B);
        const mult = 1 + Math.min(margin, 28) / 56; // blowouts count up to 50% more
        const changes = {};
        const attrChanges = {};
        for (const id of [...A, ...B]) {
          const onA = A.includes(id);
          const actual = 0.5 + ((onA ? actualA : 1 - actualA) - 0.5) * mult;
          const expected = onA ? info.winProbA : 1 - info.winProbA;
          const before = rating(id);
          const d = progression(summary.stats[id] || blankStats(), actual, expected, attrs[id]);
          for (const k of ATTR_KEYS) attrs[id][k] = clamp(attrs[id][k] + d[k], ATTR_MIN, ATTR_MAX);
          attrChanges[id] = d;
          changes[id] = Math.round((rating(id) - before) * 100) / 10; // Elo-scale: 10 = 1 OVR
          history[id].push({ gameId: g.id, date: g.date, elo: ovrToElo(rating(id)), delta: changes[id] });
        }
        info.ratingChanges = changes;
        info.attrChanges = attrChanges;
        info.mvp = tallyMvp(g, summary);
      }
    }
    games[g.id] = info;
  }
  applyEditsBefore('9999');
  const ids = Object.keys(attrs);
  return {
    elo: Object.fromEntries(ids.map((id) => [id, ovrToElo(rating(id))])),
    ovr: Object.fromEntries(ids.map((id) => [id, Math.round(clamp(rating(id), 1, 99))])),
    attrs: Object.fromEntries(ids.map((id) => [id, Object.fromEntries(ATTR_KEYS.map((k) => [k, Math.round(attrs[id][k])]))])),
    history,
    games,
  };
}

// Season (or career, season = null) totals per player, from finished games only.
export function seasonTable(db, league, season = null) {
  const table = {};
  const row = (id) => (table[id] ||= blankStats());
  for (const g of db.games || []) {
    if (g.status !== 'final') continue;
    if (season && g.season !== season) continue;
    const info = league.games[g.id];
    if (!info) continue;
    const { summary, mvp } = info;
    for (const side of ['A', 'B']) {
      for (const id of g.teams?.[side] || []) {
        const r = row(id);
        r.gp++;
        if (summary.winner === 'tie') r.t++;
        else if (summary.winner === side) r.w++;
        else r.l++;
      }
    }
    for (const [id, s] of Object.entries(summary.stats)) addStats(row(id), { ...s, gp: 0, w: 0, l: 0, t: 0, mvps: 0 });
    if (mvp?.winner) row(mvp.winner).mvps++;
  }
  return table;
}

// MVP race score: stat impact + big bonus for crowd MVPs + a little for winning.
export const mvpScore = (s) => impactOf(s) + s.mvps * 10 + s.w * 2;

// ---------------------------------------------------------------------------
// Team balancing

function combos(n, k, mustInclude0, visit) {
  const pick = (start, left, mask) => {
    if (left === 0) return visit(mask);
    for (let i = start; i <= n - left; i++) pick(i + 1, left - 1, mask | (1 << i));
  };
  if (mustInclude0) pick(1, k - 1, 1);
  else pick(0, k, 0);
}

// players: [{ id, elo, position }]. Returns { A: [ids], B: [ids], diff, winProbA }.
// Looks at every possible split (fast for pickup-sized crews), then picks randomly
// among the near-perfect ones so "reshuffle" gives a different but still fair game.
export function balanceTeams(players, { random = Math.random, tolerance = 12 } = {}) {
  const n = players.length;
  if (n < 2) return { A: players.map((p) => p.id), B: [], diff: 0, winProbA: 0.5 };
  const sizeA = Math.floor(n / 2);
  const qbIdx = players.map((p, i) => (p.position === 'QB' ? i : -1)).filter((i) => i >= 0);
  const cost = (inA) => {
    let sA = 0, sB = 0, nA = 0, qA = 0;
    players.forEach((p, i) => {
      if (inA(i)) { sA += p.elo; nA++; } else sB += p.elo;
    });
    for (const i of qbIdx) if (inA(i)) qA++;
    const diff = Math.abs(sA / nA - sB / (n - nA));
    // Two or more QBs? Don't stack them all on one side.
    const qbPenalty = qbIdx.length >= 2 && (qA === 0 || qA === qbIdx.length) ? 40 : 0;
    return diff + qbPenalty;
  };

  let pool;
  if (n <= 20) {
    const all = [];
    combos(n, sizeA, n % 2 === 0, (mask) => all.push({ mask, c: cost((i) => (mask >> i) & 1) }));
    const best = Math.min(...all.map((x) => x.c));
    pool = all.filter((x) => x.c <= best + tolerance).map((x) => (i) => (x.mask >> i) & 1);
  } else {
    // Huge turnout: snake draft then greedy swaps.
    const order = players.map((p, i) => i).sort((a, b) => players[b].elo - players[a].elo);
    const inA = new Set(order.filter((_, k) => k % 4 === 0 || k % 4 === 3).slice(0, sizeA));
    let improved = true;
    while (improved) {
      improved = false;
      const cur = cost((i) => inA.has(i));
      outer: for (const a of [...inA]) {
        for (let b = 0; b < n; b++) {
          if (inA.has(b)) continue;
          inA.delete(a); inA.add(b);
          if (cost((i) => inA.has(i)) < cur - 0.01) { improved = true; break outer; }
          inA.delete(b); inA.add(a);
        }
      }
    }
    pool = [(i) => inA.has(i)];
  }
  const chosen = pool[Math.floor(random() * pool.length)];
  let A = players.filter((_, i) => chosen(i));
  let B = players.filter((_, i) => !chosen(i));
  if (random() < 0.5 && A.length === B.length) [A, B] = [B, A];
  const avgA = mean(A.map((p) => p.elo));
  const avgB = mean(B.map((p) => p.elo));
  return { A: A.map((p) => p.id), B: B.map((p) => p.id), diff: Math.abs(avgA - avgB), winProbA: winProbability(avgA, avgB) };
}
