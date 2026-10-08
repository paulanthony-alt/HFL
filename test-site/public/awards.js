// Awards, milestones and unlockable card designs. Everything here is derived from
// finished games (like ratings), so it's always consistent and never stored.
import { impactOf, totalTDs, mvpScore, seasonTable, sortGames, blankStats, addStats } from './engine.js';

// ---------------------------------------------------------------------------
// Career milestones

export const MILESTONES = [
  { key: 'td', label: 'TD', emoji: '🏈', value: totalTDs, steps: [1, 10, 25, 50, 100] },
  { key: 'passTD', label: 'TD pass', emoji: '🎯', value: (s) => s.passTD, steps: [1, 10, 25, 50, 100] },
  { key: 'rec', label: 'catch', emoji: '🙌', value: (s) => s.rec, steps: [1, 25, 50, 100] },
  { key: 'defInt', label: 'INT', emoji: '🦅', value: (s) => s.defInt, steps: [1, 5, 10, 25] },
  { key: 'sacks', label: 'sack', emoji: '💥', value: (s) => s.sacks, steps: [1, 5, 10, 25] },
  { key: 'gp', label: 'game', emoji: '🏟️', value: (s) => s.gp, steps: [10, 25, 50, 100] },
  { key: 'w', label: 'win', emoji: '✅', value: (s) => s.w, steps: [10, 25, 50, 100] },
  { key: 'mvps', label: 'crowd MVP', emoji: '👑', value: (s) => s.mvps, steps: [1, 5, 10] },
];

export const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
};
export const milestoneLabel = (m, n) => (n === 1 ? `First ${m.label}` : `${ordinal(n)} ${m.label}`);

// ---------------------------------------------------------------------------
// Card designs. `unlock(a)` gets a player's achievements.

export const DESIGNS = [
  { key: '', name: 'Classic', emoji: '🃏', how: 'Everyone has it. Color follows your OVR tier.', unlock: () => true },
  { key: 'fire', name: 'Heat Check', emoji: '🔥', how: 'Win Player of the Week.', unlock: (a) => a.potw.length > 0 },
  { key: 'crown', name: 'Crowned', emoji: '👑', how: 'Win a season MVP, or 3 crowd MVPs.', unlock: (a) => a.awards.some((x) => x.key === 'mvp') || a.career.mvps >= 3 },
  { key: 'glow', name: 'Glow Up', emoji: '📈', how: 'Win Most Improved, or gain 5+ OVR from games in one season.', unlock: (a) => a.awards.some((x) => x.key === 'improved') || a.bestSeasonGain >= 5 },
  { key: 'butter', name: 'Butter', emoji: '🧈', how: 'Win Butterfingers, or drop 5 passes. Wear it with shame.', unlock: (a) => a.awards.some((x) => x.key === 'butter') || a.career.drops >= 5 },
  { key: 'foil', name: 'Milestone Foil', emoji: '✨', how: 'Reach any 25-level milestone (25th TD, 25th catch, 25 games…).', unlock: (a) => a.milestones.some((m) => m.n >= 25) },
  { key: 'century', name: 'Century Club', emoji: '💯', how: 'Reach any 100-level milestone, like your 100th TD.', unlock: (a) => a.milestones.some((m) => m.n >= 100) },
];
export const DESIGN_KEYS = DESIGNS.map((d) => d.key);

// ---------------------------------------------------------------------------

// Monday of the game's week, e.g. "2026-09-28".
export function weekOf(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

export function computeAwards(db, league) {
  const finals = sortGames(db.games || []).filter((g) => g.status === 'final' && league.games[g.id]);
  const current = db.settings?.season;
  const players = (db.players || []).map((p) => p.id);
  const per = {};
  const ach = (id) => (per[id] ||= { potw: [], awards: [], milestones: [], career: blankStats(), seasonGains: {}, bestSeasonGain: 0 });
  players.forEach(ach);

  // Player of the Week: biggest total stat impact across that week's games.
  const weeks = new Map();
  for (const g of finals) {
    const w = weekOf(g.date);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(g);
  }
  const potw = [];
  for (const [week, games] of weeks) {
    const total = {};
    const stats = {};
    for (const g of games) {
      for (const [id, s] of Object.entries(league.games[g.id].summary.stats)) {
        total[id] = (total[id] || 0) + impactOf(s);
        addStats((stats[id] ||= blankStats()), s);
      }
    }
    const best = Object.entries(total).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] <= 0) continue;
    const entry = { week, id: best[0], impact: best[1], stats: stats[best[0]], gameIds: games.map((g) => g.id), season: games[0].season };
    potw.push(entry);
    ach(best[0]).potw.push(entry);
  }

  // Season awards.
  const seasonsList = [...new Set(finals.map((g) => g.season))];
  const seasons = {};
  for (const season of seasonsList) {
    const table = seasonTable(db, league, season);
    const rows = Object.entries(table).filter(([, s]) => s.gp);
    const gain = {};
    for (const g of finals.filter((x) => x.season === season)) {
      for (const [id, d] of Object.entries(league.games[g.id].ratingChanges || {})) gain[id] = (gain[id] || 0) + d / 10;
    }
    for (const [id, v] of Object.entries(gain)) {
      const a = ach(id);
      a.seasonGains[season] = v;
      a.bestSeasonGain = Math.max(a.bestSeasonGain, v);
    }
    const top = (list, score) => list.sort((a, b) => score(b) - score(a))[0];
    const mvpRow = top([...rows], ([, s]) => mvpScore(s));
    const improvedRow = top(rows.filter(([id, s]) => s.gp >= 2 && gain[id] > 0), ([id]) => gain[id]);
    const butterRow = top(rows.filter(([, s]) => s.drops > 0), ([, s]) => s.drops * 100 - s.rec);
    const done = season !== current;
    const s = {
      season, done,
      mvp: mvpRow && { key: 'mvp', id: mvpRow[0], value: Math.round(mvpScore(mvpRow[1])), note: `${Math.round(mvpScore(mvpRow[1]))} MVP points` },
      improved: improvedRow && { key: 'improved', id: improvedRow[0], value: gain[improvedRow[0]], note: `+${gain[improvedRow[0]].toFixed(1)} OVR from games` },
      butter: butterRow && { key: 'butter', id: butterRow[0], value: butterRow[1].drops, note: `${butterRow[1].drops} drop${butterRow[1].drops > 1 ? 's' : ''}` },
    };
    seasons[season] = s;
    if (done) for (const k of ['mvp', 'improved', 'butter']) if (s[k]) ach(s[k].id).awards.push({ ...s[k], season });
  }

  // Career milestones, replayed game by game so each one is stamped with its game.
  const milestones = [];
  const reached = {};
  for (const g of finals) {
    const info = league.games[g.id];
    const played = [...(g.teams?.A || []), ...(g.teams?.B || [])];
    for (const id of played) {
      const c = ach(id).career;
      const s = info.summary.stats[id] || blankStats();
      addStats(c, { ...s, gp: 1, w: info.summary.winner === (g.teams.A.includes(id) ? 'A' : 'B') ? 1 : 0, l: 0, t: 0, mvps: info.mvp?.winner === id ? 1 : 0 });
      for (const m of MILESTONES) {
        const v = m.value(c);
        for (const n of m.steps) {
          const k = `${id}|${m.key}|${n}`;
          if (v >= n && !reached[k]) {
            reached[k] = true;
            const entry = { id, key: m.key, n, label: milestoneLabel(m, n), emoji: m.emoji, gameId: g.id, date: g.date };
            milestones.push(entry);
            ach(id).milestones.push(entry);
          }
        }
      }
    }
  }

  const designs = Object.fromEntries(Object.entries(per).map(([id, a]) => [id, DESIGNS.filter((d) => d.unlock(a)).map((d) => d.key)]));
  return { potw, seasons, milestones, byPlayer: per, designs };
}

// The design a card should wear: the player's pick if they've unlocked it, else Classic.
export const cardDesign = (awards, p) => (p?.cardStyle && awards.designs[p.id]?.includes(p.cardStyle) ? p.cardStyle : '');
