// HFL engine — pure game logic shared by the server, the browser and the tests.
// Nothing in here touches the DOM, the network or the disk.

export const DEFAULT_ELO = 1000;
export const K_FACTOR = 32;
// No centers in the HFL: the QB snaps it himself and four receivers go out.
export const POSITIONS = ['QB', 'WR', 'RB', 'DB', 'LB', 'RUSH', 'ATH'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Ratings are tracked internally as Elo and shown as a 40–99 "OVR" like a video game card.
export const ovrToElo = (ovr) => DEFAULT_ELO + (clamp(Number(ovr) || 70, 40, 99) - 70) * 10;
export const eloToOvr = (elo) => Math.round(clamp(70 + (elo - DEFAULT_ELO) / 10, 40, 99));
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
    rec: 0, targets: 0, recTD: 0, drops: 0,
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
    case 'drop': { if (r.qb) s(r.qb).att++; const w = s(r.rec); w.drops++; w.targets++; break; }
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

// Replays every finished game in order to derive current ratings. Ratings are never
// stored, so fixing a stat or deleting a game later keeps everything consistent.
// Manual ratings (player.ratingEdits: [{ at, ovr }]) are replayed too: an edit sets
// the player's rating at that moment, and games finished afterwards move it from there.
export function computeLeague(db) {
  const elo = {};
  const history = {};
  for (const p of db.players || []) {
    elo[p.id] = ovrToElo(p.startOvr ?? 70);
    history[p.id] = [{ gameId: null, date: (p.createdAt || '').slice(0, 10), elo: elo[p.id], delta: 0 }];
  }
  const ensure = (id) => {
    if (elo[id] === undefined) { elo[id] = DEFAULT_ELO; history[id] = [{ gameId: null, date: '', elo: DEFAULT_ELO, delta: 0 }]; }
  };
  const pending = (db.players || [])
    .flatMap((p) => (p.ratingEdits || []).map((e) => ({ id: p.id, at: e.at, ovr: e.ovr })))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const applyEditsBefore = (time) => {
    while (pending.length && pending[0].at < time) {
      const e = pending.shift();
      ensure(e.id);
      const next = ovrToElo(e.ovr);
      history[e.id].push({ gameId: null, date: e.at.slice(0, 10), elo: next, delta: next - elo[e.id], edit: true });
      elo[e.id] = next;
    }
  };
  const games = {};
  for (const g of sortGames(db.games || [])) {
    // Finished games count from when they ended; games not played yet see every edit.
    applyEditsBefore(g.status === 'final' ? g.endedAt || `${g.date}T23:59:59` : '9999');
    const summary = summarizeGame(g);
    const info = { summary, ratingChanges: null, mvp: null, winProbA: null };
    const A = g.teams?.A || [];
    const B = g.teams?.B || [];
    if (A.length && B.length) {
      [...A, ...B].forEach(ensure);
      const avgA = mean(A.map((id) => elo[id]));
      const avgB = mean(B.map((id) => elo[id]));
      info.winProbA = winProbability(avgA, avgB);
      if (g.status === 'final') {
        const actualA = summary.winner === 'A' ? 1 : summary.winner === 'B' ? 0 : 0.5;
        const margin = Math.abs(summary.score.A - summary.score.B);
        const mult = 1 + Math.min(margin, 28) / 56; // blowouts move ratings up to 50% more
        const teamDelta = K_FACTOR * mult * (actualA - info.winProbA);
        const impacts = Object.fromEntries([...A, ...B].map((id) => [id, impactOf(summary.stats[id] || blankStats())]));
        const avgImpact = mean(Object.values(impacts));
        const changes = {};
        for (const id of [...A, ...B]) {
          const base = A.includes(id) ? teamDelta : -teamDelta;
          const bonus = clamp((impacts[id] - avgImpact) * 0.5, -6, 6);
          changes[id] = Math.round((base + bonus) * 10) / 10;
        }
        for (const [id, d] of Object.entries(changes)) {
          elo[id] += d;
          history[id].push({ gameId: g.id, date: g.date, elo: elo[id], delta: d });
        }
        info.ratingChanges = changes;
        info.mvp = tallyMvp(g, summary);
      }
    }
    games[g.id] = info;
  }
  applyEditsBefore('9999');
  const ovr = Object.fromEntries(Object.entries(elo).map(([id, e]) => [id, eloToOvr(e)]));
  return { elo, ovr, history, games };
}

// What the stats say each player's rating should be, from a stat table (usually career).
// Compares production per game to the rest of the crew, then adds winning and MVPs.
export function statRatings(table, { minGames = 2 } = {}) {
  const rows = Object.entries(table).filter(([, s]) => s.gp >= minGames);
  if (!rows.length) return {};
  const ipg = rows.map(([, s]) => impactOf(s) / s.gp);
  const avg = mean(ipg);
  const sd = Math.sqrt(mean(ipg.map((x) => (x - avg) ** 2))) || 1;
  const out = {};
  rows.forEach(([id, s], i) => {
    const z = (ipg[i] - avg) / sd;
    const winPct = (s.w + s.t / 2) / s.gp;
    const score = 70 + z * 8 + (winPct - 0.5) * 16 + (s.mvps / s.gp) * 10;
    out[id] = { ovr: Math.round(clamp(score, 40, 99)), gp: s.gp };
  });
  return out;
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
