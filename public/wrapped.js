// HFL Wrapped: a Spotify-Wrapped-style season story for each player, built entirely from
// the plays already logged. buildWrapped is pure; wrappedToPngBlob draws the share card.
import { EVENT_TYPES, blankStats, addStats, totalTDs, impactOf, sortGames, seasonTable, eloToOvr, ATTR_KEYS, ATTRS, qbRating } from './engine.js';
import { weekOf } from './awards.js';
import { winProbSeries, clutchTable, typicalPlays } from './insights.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

// Every season that has at least one finished game, oldest first.
export function wrappedSeasons(db) {
  return [...new Set(sortGames(db.games || []).filter((g) => g.status === 'final').map((g) => g.season))];
}

// A season is "wrapped" once a newer season has started.
export const seasonOver = (db, season) => String(season) !== String(db.settings?.season);

// What this player did on a play, from their side: { verb, weight } or null.
function myPlay(ev, id, name) {
  const t = EVENT_TYPES[ev.type];
  if (!t) return null;
  const other = (pid) => (pid ? name(pid) : 'somebody');
  if (ev.type === 'pass_td' && ev.p1 === id) return { text: `TD pass to ${other(ev.p2)}`, weight: 4 };
  if (ev.type === 'pass_td' && ev.p2 === id) return { text: `TD catch from ${other(ev.p1)}`, weight: 4 };
  if (ev.type === 'rush_td' && ev.p1 === id) return { text: 'TD run', weight: 4 };
  if (ev.type === 'pick_six' && ev.p1 === id) return { text: `Pick six${ev.p2 ? ` off ${name(ev.p2)}` : ''}`, weight: 5 };
  if (ev.type === 'int' && ev.p1 === id) return { text: `Interception${ev.p2 ? ` off ${name(ev.p2)}` : ''}`, weight: 3 };
  if (ev.type === 'sack' && ev.p1 === id) return { text: `Sack${ev.p2 ? ` on ${name(ev.p2)}` : ''}`, weight: 2 };
  if (ev.type === 'catch' && ev.p2 === id) return { text: `Catch from ${other(ev.p1)}`, weight: 1 };
  return null;
}

// → null when the player didn't play that season, else { season, over, slides, summary }.
export function buildWrapped(db, league, awards, id, season, { name = (x) => x } = {}) {
  season = String(season);
  const games = sortGames(db.games || []).filter((g) => g.status === 'final' && String(g.season) === season);
  const mine = games.filter((g) => g.teams?.A?.includes(id) || g.teams?.B?.includes(id));
  if (!mine.length) return null;
  const table = seasonTable(db, league, season);
  const s = table[id] || blankStats();
  const weeks = [...new Set(games.map((g) => weekOf(g.date)))].sort();
  const weekNo = (g) => weeks.indexOf(weekOf(g.date)) + 1;
  const sideOf = (g) => (g.teams.A.includes(id) ? 'A' : 'B');
  const me = name(id);
  const slides = [];

  slides.push({ kind: 'intro', kicker: `Season ${season}`, big: `${me}'s HFL Wrapped`, line: `${plural(mine.length, 'game')}. ${plural(totalTDs(s), 'touchdown')}. Let's run it back.` });

  // --- showing up + best teammate
  const together = {};
  const wonWith = {};
  for (const g of mine) {
    const side = sideOf(g);
    const won = league.games[g.id]?.summary.winner === side;
    for (const t of g.teams[side]) if (t !== id) { together[t] = (together[t] || 0) + 1; if (won) wonWith[t] = (wonWith[t] || 0) + 1; }
  }
  const buddy = Object.keys(together).sort((a, b) => (wonWith[b] || 0) - (wonWith[a] || 0) || together[b] - together[a])[0];
  const winPct = s.gp ? Math.round(((s.w + s.t / 2) / s.gp) * 100) : 0;
  slides.push({
    kind: 'stat', kicker: 'You showed up', big: `${s.w}-${s.l}${s.t ? `-${s.t}` : ''}`, unit: 'record',
    line: `${plural(s.gp, 'game')}, ${winPct}% of them wins.${buddy ? ` Your ride-or-die: ${name(buddy)}, ${plural(wonWith[buddy] || 0, 'win')} together.` : ''}`,
  });

  // --- the headline numbers, picked by where you rank in the league
  const rankOf = (f) => {
    const vals = Object.values(table).map(f).sort((a, b) => b - a);
    return vals.indexOf(f(s)) + 1;
  };
  const candidates = [
    { v: s.rec, f: (x) => x.rec, big: `You caught ${plural(s.rec, 'pass', 'passes')}` },
    { v: totalTDs(s), f: totalTDs, big: `You scored ${plural(totalTDs(s), 'touchdown')}` },
    { v: s.passTD, f: (x) => x.passTD, big: `You threw ${plural(s.passTD, 'touchdown pass', 'touchdown passes')}`, extra: s.att ? `${s.comp}/${s.att} passing, ${Math.round(qbRating(s) ?? 0)} QB rating.` : '' },
    { v: s.defInt, f: (x) => x.defInt, big: `You picked off ${plural(s.defInt, 'pass', 'passes')}` },
    { v: s.sacks, f: (x) => x.sacks, big: `You got ${plural(s.sacks, 'sack')}` },
  ].filter((c) => c.v > 0).map((c) => ({ ...c, rank: rankOf(c.f) })).sort((a, b) => a.rank - b.rank || b.v - a.v).slice(0, 2);
  for (const c of candidates) {
    slides.push({ kind: 'stat', kicker: 'By the numbers', big: c.big, line: [c.extra, c.rank === 1 ? 'Most in the HFL. Nobody else was close.' : c.rank <= 3 ? `#${c.rank} in the whole league.` : ''].filter(Boolean).join(' ') || 'Put it on the fridge.' });
  }

  // --- favorite connection
  const links = {};
  for (const g of mine) for (const ev of g.events || []) {
    if (!['pass_td', 'catch'].includes(ev.type) || !ev.p2) continue;
    const other = ev.p1 === id ? ev.p2 : ev.p2 === id ? ev.p1 : null;
    if (!other) continue;
    const l = (links[other] ||= { n: 0, td: 0, asQB: ev.p1 === id });
    l.n++; if (ev.type === 'pass_td') l.td++;
  }
  const bestLink = Object.entries(links).sort((a, b) => b[1].n - a[1].n || b[1].td - a[1].td)[0];
  if (bestLink) {
    const [who, l] = bestLink;
    slides.push({ kind: 'person', person: who, kicker: l.asQB ? 'Your favorite target' : 'Your favorite QB', big: name(who), line: `${plural(l.n, 'completion')}${l.td ? `, ${plural(l.td, 'touchdown')}` : ''} together.` });
  }

  // --- nemesis: the guy who did the most damage to you
  const hurt = {};
  const lostTo = {};
  for (const g of mine) {
    const side = sideOf(g);
    const opp = side === 'A' ? 'B' : 'A';
    if (league.games[g.id]?.summary.winner === opp) for (const o of g.teams[opp]) lostTo[o] = (lostTo[o] || 0) + 1;
    for (const ev of g.events || []) {
      if (!ev.p1 || ev.p1 === id) continue;
      if (['int', 'pick_six', 'sack'].includes(ev.type) && ev.p2 === id) {
        const x = (hurt[ev.p1] ||= { picks: 0, sacks: 0 });
        if (ev.type === 'sack') x.sacks++; else x.picks++;
      }
    }
  }
  const pain = (o) => (hurt[o] ? hurt[o].picks * 3 + hurt[o].sacks * 2 : 0) + (lostTo[o] || 0);
  const nemesis = [...new Set([...Object.keys(hurt), ...Object.keys(lostTo)])].filter((o) => pain(o) >= 2).sort((a, b) => pain(b) - pain(a))[0];
  if (nemesis) {
    const x = hurt[nemesis];
    const bits = [];
    if (x?.picks) bits.push(`picked you off ${times(x.picks)}`);
    if (x?.sacks) bits.push(`sacked you ${times(x.sacks)}`);
    if (lostTo[nemesis]) bits.push(`beat you ${times(lostTo[nemesis])}`);
    slides.push({ kind: 'person', person: nemesis, tone: 'bad', kicker: 'Your nemesis', big: name(nemesis), line: `${name(nemesis)} ${bits.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Circle the date.` });
  }

  // --- best play: your play that swung win probability the most your way
  const expected = typicalPlays(db);
  let best = null;
  for (const g of mine) {
    const side = sideOf(g);
    const series = winProbSeries(g, league.games[g.id], { expected });
    for (const pt of series) {
      if (!pt.ev) continue;
      const mp = myPlay(pt.ev, id, name);
      if (!mp) continue;
      const swing = side === 'A' ? pt.delta : -pt.delta;
      const score = Math.max(0, swing) * 100 + mp.weight;
      if (!best || score > best.score) best = { score, swing, g, mp, ev: pt.ev };
    }
  }
  if (best && best.mp.weight >= 2) {
    const sw = Math.round(Math.max(0, best.swing) * 100);
    slides.push({ kind: 'play', kicker: 'Your best play', big: `Week ${weekNo(best.g)}`, emoji: EVENT_TYPES[best.ev.type].emoji, line: `${best.mp.text}.${sw >= 5 ? ` It swung the game ${sw}% your way.` : ''}`, gameId: best.g.id });
  }

  // --- best game
  let top = null;
  for (const g of mine) {
    const st = league.games[g.id]?.summary.stats[id] || blankStats();
    const imp = impactOf(st);
    if (!top || imp > top.imp) top = { g, st, imp };
  }
  if (top && top.imp > 0) {
    const side = sideOf(top.g);
    const sc = league.games[top.g.id].summary.score;
    const res = sc[side] > sc[side === 'A' ? 'B' : 'A'] ? 'W' : sc[side] < sc[side === 'A' ? 'B' : 'A'] ? 'L' : 'T';
    const bits = [];
    if (totalTDs(top.st)) bits.push(plural(totalTDs(top.st), 'TD'));
    if (top.st.passTD) bits.push(plural(top.st.passTD, 'TD pass', 'TD passes'));
    if (top.st.rec) bits.push(plural(top.st.rec, 'catch', 'catches'));
    if (top.st.defInt) bits.push(plural(top.st.defInt, 'pick'));
    if (top.st.sacks) bits.push(plural(top.st.sacks, 'sack'));
    slides.push({ kind: 'stat', kicker: 'Your best game', big: `Week ${weekNo(top.g)}`, line: `${bits.join(', ')}. A ${res} ${sc[side]}–${sc[side === 'A' ? 'B' : 'A']}.`, gameId: top.g.id });
  }

  // --- clutch + heater
  const clutch = clutchTable(db, season)[id];
  let run = 0, heater = 0;
  for (const g of mine) {
    const st = league.games[g.id]?.summary.stats[id] || blankStats();
    run = totalTDs(st) + st.passTD > 0 ? run + 1 : 0;
    heater = Math.max(heater, run);
  }
  if ((clutch && clutch.big) || heater >= 2) {
    const lines = [];
    if (heater >= 2) lines.push(`Longest heater: a TD in ${heater} straight games${heater >= 3 ? ' 🔥' : ''}.`);
    if (clutch?.big) lines.push(`${plural(clutch.big, 'big play')} in crunch time${clutch.chokes ? ` (and ${plural(clutch.chokes, 'choke')})` : ''}.`);
    slides.push({ kind: 'stat', kicker: 'When it mattered', big: clutch ? `${clutch.score > 0 ? '+' : ''}${clutch.score} clutch` : `${heater} straight`, line: lines.join(' ') });
  }

  // --- ratings journey
  const hist = (league.history[id] || []);
  const seasonIds = new Set(mine.map((g) => g.id));
  const firstIdx = hist.findIndex((x) => seasonIds.has(x.gameId));
  let lastIdx = -1;
  hist.forEach((x, i) => { if (seasonIds.has(x.gameId)) lastIdx = i; });
  if (firstIdx > 0 && lastIdx >= firstIdx) {
    const from = eloToOvr(hist[firstIdx - 1].elo);
    const to = eloToOvr(hist[lastIdx].elo);
    const gains = Object.fromEntries(ATTR_KEYS.map((k) => [k, 0]));
    for (const g of mine) for (const k of ATTR_KEYS) gains[k] += league.games[g.id]?.attrChanges?.[id]?.[k] || 0;
    const [bk, bv] = Object.entries(gains).sort((a, b) => b[1] - a[1])[0];
    const label = ATTRS.find((a) => a.key === bk)?.label;
    slides.push({ kind: 'stat', kicker: 'Glow up', big: `${from} → ${to}`, unit: 'OVR', line: `${to > from ? `Up ${to - from}.` : to < from ? `Down ${from - to}. Next year.` : 'Held steady.'}${bv >= 0.5 ? ` Biggest gain: ${label} +${bv.toFixed(1)}.` : ''}` });
  }

  // --- hardware
  const a = awards?.byPlayer?.[id];
  const potw = (a?.potw || []).filter((x) => (x.gameIds || []).some((gid) => games.some((g) => g.id === gid)));
  const seasonAwards = (a?.awards || []).filter((x) => String(x.season) === season);
  const miles = (a?.milestones || []).filter((m) => seasonIds.has(m.gameId));
  if (potw.length || seasonAwards.length || miles.length) {
    const names = { mvp: '👑 Season MVP', improved: '📈 Most Improved', butter: '🧈 Butterfingers' };
    const items = [
      ...seasonAwards.map((x) => names[x.key]),
      ...(potw.length ? [`🔥 Player of the Week ×${potw.length}`] : []),
      ...[...miles].sort((x, y) => y.n - x.n).slice(0, 3).map((m) => `${m.emoji} ${m.label}`),
    ];
    slides.push({ kind: 'list', kicker: 'Hardware', big: `${items.length} for the trophy case`, items });
  }

  // --- the roast
  if (s.drops >= 2 || s.intThrown >= 2) {
    slides.push({
      kind: 'stat', tone: 'bad', kicker: 'We have to talk about it',
      big: s.drops >= s.intThrown ? `${s.drops} drops 🧈` : `${s.intThrown} picks thrown`,
      line: s.drops >= s.intThrown ? 'The ball is not your enemy. The ball wants to be caught.' : 'Wrong jersey color. Every time.',
    });
  }

  const summary = {
    name: me, season, record: `${s.w}-${s.l}${s.t ? `-${s.t}` : ''}`, gp: s.gp,
    tds: totalTDs(s), rec: s.rec, passTD: s.passTD, ints: s.defInt, sacks: s.sacks,
    headline: candidates[0]?.big || `${plural(s.gp, 'game')} played`,
    nemesis: nemesis ? name(nemesis) : null, buddy: buddy ? name(buddy) : null,
    bestPlay: best && best.mp.weight >= 2 ? `Week ${weekNo(best.g)}: ${best.mp.text}` : null,
    clutch: clutch?.score ?? 0,
  };
  slides.push({ kind: 'summary', kicker: `${season} Wrapped`, big: me, summary });
  return { id, season, over: seasonOver(db, season), slides, summary };
}

// ---------------------------------------------------------------------------
// Share card (1080×1920, story-sized)

export async function wrappedToPngBlob(sum, { photo = null, color = '#ff5a1f', initial = '' } = {}) {
  const W = 1080, H = 1920, P = 84;
  const D = '"Big Shoulders Display", Impact, sans-serif';
  const Lb = '"Barlow Condensed", "Arial Narrow", sans-serif';
  const B = 'Barlow, Arial, sans-serif';
  try { await Promise.all([`900 80px ${D}`, `700 30px ${Lb}`, `600 30px ${B}`].map((f) => document.fonts.load(f))); } catch { /* system fonts */ }
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c = canvas.getContext('2d');
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2a0d3d'); bg.addColorStop(0.45, '#12081f'); bg.addColorStop(1, '#3a1206');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  for (const [x, y, r, col] of [[W * 0.9, 200, 520, 'rgba(255,90,31,0.35)'], [0, H * 0.7, 600, 'rgba(160,110,255,0.3)'], [W, H, 500, 'rgba(255,197,61,0.22)']]) {
    const g = c.createRadialGradient(x, y, 10, x, y, r); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
  c.textBaseline = 'alphabetic';
  c.fillStyle = '#ffc53d'; c.font = `800 38px ${Lb}`; c.fillText(`HFL WRAPPED · SEASON ${sum.season}`.toUpperCase(), P, 150);

  // avatar
  const R = 110, cx = W - P - R, cy = 300;
  const img = photo ? await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = photo; }) : null;
  c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.closePath();
  if (img) { c.clip(); const sc = Math.max((R * 2) / img.width, (R * 2) / img.height); c.drawImage(img, cx - (img.width * sc) / 2, cy - R - (img.height * sc - R * 2) * 0.15, img.width * sc, img.height * sc); }
  else { c.fillStyle = color; c.fill(); c.fillStyle = '#111'; c.font = `900 110px ${D}`; c.textAlign = 'center'; c.fillText(initial || sum.name[0], cx, cy + 38); c.textAlign = 'left'; }
  c.restore();
  c.strokeStyle = '#ffc53d'; c.lineWidth = 8; c.beginPath(); c.arc(cx, cy, R + 6, 0, Math.PI * 2); c.stroke();

  c.fillStyle = '#fff8e6'; c.font = `900 150px ${D}`;
  const nm = sum.name.toUpperCase();
  let fs = 150; while (c.measureText(nm).width > W - P * 2 - R * 2 - 40 && fs > 70) { fs -= 8; c.font = `900 ${fs}px ${D}`; }
  c.fillText(nm, P, 340);
  c.fillStyle = '#cfcabf'; c.font = `600 44px ${B}`; c.fillText(sum.headline, P, 430);

  const cells = [['RECORD', sum.record], ['TDS', sum.tds], ['CATCHES', sum.rec], ['TD PASSES', sum.passTD], ['INTS', sum.ints], ['CLUTCH', `${sum.clutch > 0 ? '+' : ''}${sum.clutch}`]];
  const cw = (W - P * 2 - 40) / 3;
  cells.forEach(([label, v], i) => {
    const x = P + (i % 3) * (cw + 20), y = 520 + Math.floor(i / 3) * 250;
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 2;
    c.beginPath(); c.roundRect(x, y, cw, 220, 28); c.fill(); c.stroke();
    c.fillStyle = '#fff8e6'; c.font = `900 110px ${D}`; c.textAlign = 'center'; c.fillText(String(v), x + cw / 2, y + 130);
    c.fillStyle = '#ffc53d'; c.font = `800 30px ${Lb}`; c.fillText(label, x + cw / 2, y + 185); c.textAlign = 'left';
  });

  let y = 1110;
  const row = (label, value, col) => {
    if (!value) return;
    c.fillStyle = col; c.font = `800 34px ${Lb}`; c.fillText(label, P, y);
    c.fillStyle = '#f5f2ea'; c.font = `900 72px ${D}`;
    let t = String(value).toUpperCase(); while (c.measureText(t).width > W - P * 2 && t.length > 4) t = t.slice(0, -2);
    c.fillText(t, P, y + 76); y += 170;
  };
  row('RIDE-OR-DIE', sum.buddy, '#2fd57b');
  row('NEMESIS', sum.nemesis, '#ff3d5e');
  row('BEST PLAY', sum.bestPlay, '#36c8ff');

  c.fillStyle = 'rgba(255,255,255,0.45)'; c.font = `800 30px ${Lb}`; c.textAlign = 'center';
  c.fillText('HAVEMEYER FOOTBALL LEAGUE', W / 2, H - 80); c.textAlign = 'left';
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}
