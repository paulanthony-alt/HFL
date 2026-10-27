// Bowl games, keepers and free agency (test site preview).
//
// A season is SEASON_GAMES games; the last one is the HFL Bowl. When the Bowl ends the
// offseason starts:
//   1. keepers: each coach keeps up to KEEPERS players from his roster (a "keeper tag" that
//      costs a little more than the player's market value, like an NFL franchise tag);
//   2. frenzy: a week of free agency. Coaches offer 1-season contracts out of an equal
//      salary cap; each free agent picks the offer he likes and taps "Sign contract";
//   3. closed: the next season starts with coach + keepers + signings on each team.
//      Anyone who didn't sign stays a free agent.
// The money is fake. Everything here is plain data in settings.offseason, so the same
// rules run on the server, in the browser (Firebase) and in tests.

export const SEASON_GAMES = 4;
export const CAP = 100; // $M per team, the same for everyone
export const MIN_DEAL = 1; // $M
export const MAX_DEAL = 40; // $M, nobody gets more than 40% of a cap
export const KEEPERS = 2;
export const FRENZY_DAYS = 7;
const DAY = 864e5;

export const money = (m) => `$${Math.round(m * 10) / 10}M`;
export const roundHalf = (m) => Math.round(m * 2) / 2;

// "2026" → "2026 S2" → "2026 S3"
export function nextSeasonName(s) {
  const m = /^(.*\S)\s+S(\d+)$/.exec(String(s || '').trim());
  return m ? `${m[1]} S${Number(m[2]) + 1}` : `${String(s || '').trim() || 'Season'} S2`;
}

// What a player is worth on the open market, relative to the crew: an average player is
// about $14M (so the cap pays for about seven of them), and each OVR point above or below
// average is worth about 7% more or less, so stars get expensive fast (like the NFL).
export function marketValue(ovr, crewAvg) {
  return Math.min(MAX_DEAL, Math.max(MIN_DEAL, roundHalf(14 * 1.07 ** (ovr - crewAvg))));
}
export const keeperPrice = (value) => Math.min(MAX_DEAL, roundHalf(value * 1.2));

// Week of the season for a new game (only games made since bowls started count).
export const weekGames = (db, season) => (db.games || []).filter((g) => g.week && String(g.season) === String(season));
export const nextWeek = (db, season) => weekGames(db, season).length + 1;

// Everything the screens and the rules need to know about the offseason right now.
// teams: the two season teams; ovr: { playerId: OVR }; at: ISO time "now".
export function faState(db, { ovr = {}, at = new Date().toISOString() } = {}) {
  const os = db.settings?.offseason || null;
  const teams = (db.settings?.teams || []).filter((t) => t.players?.length || t.coachId);
  const active = (db.players || []).filter((p) => p.active !== false).map((p) => p.id);
  const activeSet = new Set(active);
  const coachIds = new Set(teams.map((t) => t.coachId).filter((id) => id && activeSet.has(id)));
  const season = db.settings?.season;
  const bowl = (db.games || []).find((g) => g.bowl && String(g.season) === String(os?.season ?? season)) || null;
  const phase = os ? os.phase : 'season';
  const crewAvg = active.length ? active.reduce((t, id) => t + (ovr[id] ?? 70), 0) / active.length : 70;
  const value = (pid) => marketValue(ovr[pid] ?? 70, crewAvg);
  const keepers = os?.keepers || {};
  const signings = os?.signings || [];
  const signedTo = new Map(signings.map((s) => [s.playerId, s]));
  const keptBy = new Map();
  for (const [tid, k] of Object.entries(keepers)) for (const x of k.players || []) keptBy.set(x.id, { teamId: tid, amount: x.amount });
  const rosterMax = Math.max(1, Math.ceil(active.length / Math.max(1, teams.length)));
  const teamInfo = teams.map((t) => {
    const coachId = coachIds.has(t.coachId) ? t.coachId : null;
    const kept = (keepers[t.id]?.players || []).filter((x) => activeSet.has(x.id));
    const signed = signings.filter((s) => s.teamId === t.id && activeSet.has(s.playerId));
    const capUsed = kept.reduce((s, x) => s + x.amount, 0) + signed.reduce((s, x) => s + x.amount, 0);
    const roster = [...(coachId ? [coachId] : []), ...kept.map((x) => x.id), ...signed.map((s) => s.playerId)];
    return {
      id: t.id, name: t.name, color: t.color, coachId, kept, signed, roster,
      locked: !!keepers[t.id]?.locked,
      capUsed: Math.round(capUsed * 10) / 10,
      capSpace: Math.round((CAP - capUsed) * 10) / 10,
      rosterOpen: rosterMax - roster.length,
      // keepers are picked from this season's roster
      eligibleKeepers: (t.players || []).filter((pid) => activeSet.has(pid) && pid !== coachId),
    };
  });
  const isFreeAgent = (pid) => activeSet.has(pid) && !coachIds.has(pid) && !keptBy.has(pid) && !signedTo.has(pid);
  const freeAgents = phase === 'season' ? [] : active.filter(isFreeAgent);
  const offers = (os?.offers || []).filter((o) => isFreeAgent(o.playerId));
  const endsAt = os?.endsAt || null;
  return {
    os, phase, season, bowl, teams: teamInfo, rosterMax, value, crewAvg,
    freeAgents, offers, signings, keptBy, signedTo, coachIds, isFreeAgent,
    offersFor: (pid) => offers.filter((o) => o.playerId === pid),
    teamOf: (tid) => teamInfo.find((t) => t.id === tid) || null,
    endsAt, msLeft: endsAt ? Date.parse(endsAt) - Date.parse(at) : null,
    over: phase === 'frenzy' && endsAt && Date.parse(at) >= Date.parse(endsAt),
    week: nextWeek(db, season),
  };
}

// Why a team can't make (or a player can't sign) this deal right now, or null if it's fine.
export function dealProblem(st, teamId, playerId, amount) {
  const t = st.teamOf(teamId);
  if (!t) return 'unknown team';
  if (st.phase !== 'frenzy') return st.phase === 'closed' ? 'Free agency is over' : "Free agency isn't open yet";
  if (st.over) return 'Free agency is over';
  if (!st.isFreeAgent(playerId)) return "He's not a free agent";
  if (!(amount >= MIN_DEAL)) return `The smallest contract is ${money(MIN_DEAL)}`;
  if (amount > MAX_DEAL) return `The biggest contract is ${money(MAX_DEAL)}`;
  if (amount > t.capSpace) return `${t.name} only has ${money(Math.max(0, t.capSpace))} of cap space`;
  if (t.rosterOpen <= 0) return `${t.name}'s roster is full (${st.rosterMax} players)`;
  return null;
}

// "5d 4h", "3h 12m", "45m", "0m"
export function timeLeft(ms) {
  if (!(ms > 0)) return '0m';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export const frenzyEnd = (fromISO) => new Date(Date.parse(fromISO) + FRENZY_DAYS * DAY).toISOString();
