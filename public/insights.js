// Win probability, momentum, clutch and form (hot/cold streaks). Pure functions, all
// derived from logged plays like everything else.
import { EVENT_TYPES, blankStats, totalTDs, sortGames, clamp } from './engine.js';

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Pickup games have no clock, so "how far along" is plays logged vs. a typical game.
export function typicalPlays(db) {
  const counts = (db.games || []).filter((g) => g.status === 'final' && g.events?.length).map((g) => g.events.length);
  return counts.length ? Math.max(12, Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)) : 30;
}

// Team A's chance to win given the score gap and how far along the game is. Early on it's
// mostly the pre-game odds; late, the scoreboard decides.
export function winProbAt(pregameA, diff, t) {
  t = clamp(t, 0, 0.98);
  const x = logit(clamp(pregameA, 0.02, 0.98)) * (1 - t) + diff * (0.12 / Math.sqrt(1 - t + 0.05));
  return clamp(sigmoid(x), 0.01, 0.99);
}

// One point before the game plus one after every play: { i, t, wp, score, ev, delta }.
export function winProbSeries(game, info, { expected = 30 } = {}) {
  const events = game.events || [];
  const n = events.length;
  const total = game.status === 'final' ? Math.max(n, 1) : Math.max(n + 3, expected);
  const pre = info?.winProbA ?? 0.5;
  const score = { A: 0, B: 0 };
  const pts = [{ i: 0, t: 0, wp: pre, score: { ...score }, ev: null, delta: 0 }];
  events.forEach((ev, idx) => {
    const p = EVENT_TYPES[ev.type]?.points || 0;
    if (p && (ev.team === 'A' || ev.team === 'B')) score[ev.team] += p;
    const t = (idx + 1) / total;
    let wp = winProbAt(pre, score.A - score.B, t);
    if (game.status === 'final' && idx === n - 1) wp = score.A > score.B ? 1 : score.A < score.B ? 0 : 0.5;
    pts.push({ i: idx + 1, t, wp, score: { ...score }, ev, delta: wp - pts[pts.length - 1].wp });
  });
  return pts;
}

// The single play that moved the needle most.
export function biggestSwing(series) {
  let best = null;
  for (const p of series) if (p.ev && (!best || Math.abs(p.delta) > Math.abs(best.delta))) best = p;
  return best && Math.abs(best.delta) >= 0.03 ? best : null;
}

// ---------------------------------------------------------------------------
// Clutch: plays made when the game was close (within one score) and late (last 40%).

export const CLUTCH_POINTS = {
  pass_td: { qb: 2, rec: 3 },
  rush_td: { runner: 3 },
  pick_six: { def: 4, qb: -3 },
  int: { def: 3, qb: -3 },
  sack: { def: 2 },
  drop: { rec: -2 },
};

export function clutchPlays(game, { expected = 30 } = {}) {
  const events = game.events || [];
  const total = game.status === 'final' ? Math.max(events.length, 1) : Math.max(events.length + 3, expected);
  const score = { A: 0, B: 0 };
  const out = [];
  events.forEach((ev, idx) => {
    const t = idx / total; // where the game was when the play started
    const close = Math.abs(score.A - score.B) <= 7;
    const rule = CLUTCH_POINTS[ev.type];
    if (rule && close && t >= 0.6) {
      const roles = EVENT_TYPES[ev.type].roles;
      const ids = { [roles[0]]: ev.p1, [roles[1]]: ev.p2 };
      for (const [role, pts] of Object.entries(rule)) if (ids[role]) out.push({ id: ids[role], pts, ev, gameId: game.id });
    }
    const p = EVENT_TYPES[ev.type]?.points || 0;
    if (p && (ev.team === 'A' || ev.team === 'B')) score[ev.team] += p;
  });
  return out;
}

export const blankClutch = () => ({ score: 0, plays: 0, big: 0, chokes: 0, games: 0 });

// Clutch totals per player for a season (or career when season is null).
export function clutchTable(db, season = null) {
  const expected = typicalPlays(db);
  const table = {};
  for (const g of db.games || []) {
    if (g.status !== 'final' || (season && g.season !== season)) continue;
    const seen = new Set();
    for (const c of clutchPlays(g, { expected })) {
      const r = (table[c.id] ||= blankClutch());
      r.score += c.pts;
      r.plays++;
      if (c.pts > 0) r.big++; else r.chokes++;
      if (!seen.has(c.id)) { seen.add(c.id); r.games++; }
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Form: 🔥 = TD (scored or thrown) in 3+ straight games; ❄️ = 2+ straight games with a
// drop or pick thrown and no TDs. Streaks count from the player's most recent game.

export function formOf(db, league) {
  const form = {};
  const perPlayer = {};
  for (const g of sortGames(db.games || [])) {
    if (g.status !== 'final' || !league.games[g.id]) continue;
    for (const id of [...(g.teams?.A || []), ...(g.teams?.B || [])]) (perPlayer[id] ||= []).push(league.games[g.id].summary.stats[id] || blankStats());
  }
  for (const [id, games] of Object.entries(perPlayer)) {
    let hot = 0, cold = 0;
    for (let i = games.length - 1; i >= 0; i--) { if (totalTDs(games[i]) + games[i].passTD > 0) hot++; else break; }
    for (let i = games.length - 1; i >= 0; i--) {
      const s = games[i];
      if ((s.drops || s.intThrown) && !(totalTDs(s) + s.passTD)) cold++; else break;
    }
    form[id] = { hot: hot >= 3 ? hot : 0, cold: hot >= 3 ? 0 : cold >= 2 ? cold : 0 };
  }
  return form;
}
