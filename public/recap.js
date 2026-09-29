// "HFL Center": the SportsCenter-style recap that appears the moment a game goes final.
// buildRecap is pure and seeded by the game id, so every phone shows the same recap.
// recapToPngBlob draws it as a shareable image (browser only).
import { EVENT_TYPES, impactOf, totalTDs, blankStats } from './engine.js';

function seeded(str) {
  let h = 2166136261;
  for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const PLAY_WEIGHT = { pick_six: 5, pass_td: 4, rush_td: 4, int: 3, sack: 2 };

export function describePlay(ev, name) {
  const a = name(ev.p1);
  const b = ev.p2 ? name(ev.p2) : '';
  return {
    pick_six: b ? `${a} jumps the route on ${b} and takes it to the house` : `${a} takes it to the house`,
    pass_td: `${a} finds ${b} for six`,
    rush_td: `${a} takes it in himself`,
    int: b ? `${a} picks off ${b}` : `${a} with the pick`,
    sack: b ? `${a} gets home and puts ${b} on the turf` : `${a} with the sack`,
  }[ev.type] || EVENT_TYPES[ev.type]?.label || '';
}

// name(id) → display name; statLine(stats) → "3/5, 2 TD"; extra: { milestones, potw }
export function buildRecap(game, info, { name, statLine = () => '', milestones = [] } = {}) {
  const rand = seeded(game.id);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const { score, stats, winner } = info.summary;
  const team = (side) => game.teamNames?.[side] || (side === 'A' ? 'Team A' : 'Team B');
  const W = winner === 'B' ? 'B' : 'A';
  const L = W === 'A' ? 'B' : 'A';
  const margin = Math.abs(score.A - score.B);
  const upset = winner !== 'tie' && info.winProbA != null && (W === 'A' ? info.winProbA : 1 - info.winProbA) < 0.4;

  let headline;
  if (winner === 'tie') headline = pick([`Nobody blinks: ${team('A')} and ${team('B')} split it ${score.A}–${score.B}`, `A tie. Somewhere a referee is crying. ${score.A}–${score.B}`]);
  else if (upset) headline = pick([`UPSET ALERT: ${team(W)} shock ${team(L)}`, `Nobody gave ${team(W)} a chance. ${team(W)} didn't care`]);
  else if (margin >= 18) headline = pick([`${team(W)} run ${team(L)} off the field`, `Mercy rule, please: ${team(W)} bury ${team(L)}`, `${team(W)} put on a clinic. ${team(L)} took notes`]);
  else if (margin <= 6) headline = pick([`${team(W)} survive ${team(L)} in a nail-biter`, `Down to the wire: ${team(W)} edge ${team(L)}`, `${team(W)} hang on. ${team(L)} will be up all night about this one`]);
  else headline = pick([`${team(W)} take care of business against ${team(L)}`, `${team(W)} handle ${team(L)}`, `${team(W)} too much for ${team(L)}`]);

  const ids = [...(game.teams?.A || []), ...(game.teams?.B || [])];
  const impact = Object.fromEntries(ids.map((id) => [id, impactOf(stats[id] || blankStats())]));
  const byImpact = [...ids].sort((a, b) => impact[b] - impact[a]);
  const goatId = info.mvp?.winner || (impact[byImpact[0]] > 0 ? byImpact[0] : null);
  const goat = goatId && {
    id: goatId,
    crowd: !!info.mvp?.winner,
    line: statLine(stats[goatId]),
    blurb: pick([`${name(goatId)} was the best player on the field and it wasn't close.`, `Put ${name(goatId)}'s tape in the Louvre.`, `${name(goatId)} woke up and chose violence.`, `Everybody else was playing football. ${name(goatId)} was playing a different sport.`]),
  };

  const topPlays = game.events
    .map((ev, i) => ({ ev, i, w: PLAY_WEIGHT[ev.type] || 0 }))
    .filter((x) => x.w)
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, 3)
    .map(({ ev }) => ({ type: ev.type, emoji: EVENT_TYPES[ev.type].emoji, label: EVENT_TYPES[ev.type].label, text: describePlay(ev, name) }));

  const dropper = ids.filter((id) => stats[id]?.drops).sort((a, b) => stats[b].drops - stats[a].drops)[0];
  const worstDrop = dropper
    ? { id: dropper, n: stats[dropper].drops, text: pick([
      `${name(dropper)} dropped ${stats[dropper].drops === 1 ? 'a perfect ball' : `${stats[dropper].drops} of them`}. The ball did nothing wrong.`,
      `${name(dropper)} had it. Then ${name(dropper)} didn't have it.`,
      `Somebody check ${name(dropper)}'s gloves for butter. ${stats[dropper].drops} drop${stats[dropper].drops > 1 ? 's' : ''}.`,
    ]) }
    : null;

  // Roast: the guy who had the roughest day.
  const victim = [...ids].sort((a, b) => impact[a] - impact[b])[0];
  let roast = null;
  if (victim && ids.length > 1) {
    const s = stats[victim] || blankStats();
    const n = name(victim);
    const lines = [];
    if (s.intThrown) lines.push(`${n} threw ${s.intThrown} pick${s.intThrown > 1 ? 's' : ''}. Wrong jersey color, bro.`);
    if (s.sacked) lines.push(`${n} got sacked ${s.sacked} time${s.sacked > 1 ? 's' : ''}. Pocket presence of a folding chair.`);
    if (s.drops && victim !== dropper) lines.push(`${n} added ${s.drops} drop${s.drops > 1 ? 's' : ''} of his own. Two-man butter factory.`);
    if (!totalTDs(s) && !s.passTD && !s.defInt && !s.sacks) lines.push(`${n} was technically on the field. Allegedly.`, `Milk carton alert: has anyone seen ${n}? Last spotted near the sideline.`);
    if (!lines.length) lines.push(`${n} had the quietest day of anyone out there. The silence was loud.`);
    roast = { id: victim, text: pick(lines) };
  }

  return {
    gameId: game.id, date: game.date, headline,
    teams: { A: team('A'), B: team('B') }, score, winner,
    goat, topPlays, worstDrop, roast,
    milestones: milestones.filter((m) => m.gameId === game.id),
  };
}

// ---------------------------------------------------------------------------
// Image export (1080×1350, the Instagram/iMessage-friendly portrait size)

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

const loadImage = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

// opts: { name(id), dateLabel, goatPhoto (url/dataURL), crew }
export async function recapToPngBlob(r, { name, dateLabel = '', goatPhoto = null, goatColor = '#ffc53d', goatInitial = '', crew = 'HFL' } = {}) {
  const W = 1080, H = 1350, P = 72;
  const D = '"Big Shoulders Display", Impact, sans-serif';
  const Lb = '"Barlow Condensed", "Arial Narrow", sans-serif';
  const B = 'Barlow, Arial, sans-serif';
  try {
    await Promise.all([`900 80px ${D}`, `700 30px ${Lb}`, `600 30px ${B}`].map((f) => document.fonts.load(f)));
  } catch { /* fall back to system fonts */ }
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c = canvas.getContext('2d');

  // background: night game
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#12161d'); bg.addColorStop(1, '#05070a');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W * 0.15, -60, 10, W * 0.15, -60, 700);
  glow.addColorStop(0, 'rgba(255,200,140,0.22)'); glow.addColorStop(1, 'rgba(255,200,140,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,255,255,0.03)'; c.lineWidth = 2;
  for (let y = 120; y < H; y += 96) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

  // header bar
  c.save(); c.translate(P, 70); c.transform(1, 0, -0.2, 1, 0, 0);
  const hdr = c.createLinearGradient(0, 0, 360, 0); hdr.addColorStop(0, '#ff5a1f'); hdr.addColorStop(1, '#ff8b2b');
  c.fillStyle = hdr; c.fillRect(0, 0, 330, 70); c.restore();
  c.fillStyle = '#0b0b0b'; c.font = `900 56px ${D}`; c.textBaseline = 'middle';
  c.fillText('HFL CENTER', P + 16, 107);
  c.fillStyle = '#8b929e'; c.font = `700 28px ${Lb}`; c.textAlign = 'right';
  c.fillText(`${dateLabel}`.toUpperCase(), W - P, 107);
  c.textAlign = 'left';

  // scoreboard
  let y = 210;
  c.fillStyle = '#0a0d12'; c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 2;
  c.beginPath(); c.roundRect(P, y, W - P * 2, 190, 24); c.fill(); c.stroke();
  const side = (label, s, x, align, color, win) => {
    c.textAlign = align;
    c.fillStyle = color; c.font = `800 30px ${Lb}`;
    c.fillText(label.toUpperCase().slice(0, 18), x, y + 46);
    c.fillStyle = win ? '#fff8e6' : 'rgba(255,255,255,0.55)'; c.font = `900 118px ${D}`;
    c.fillText(String(s), x, y + 130);
  };
  side(r.teams.A, r.score.A, P + 40, 'left', '#ff5a1f', r.winner === 'A' || r.winner === 'tie');
  side(r.teams.B, r.score.B, W - P - 40, 'right', '#36c8ff', r.winner === 'B' || r.winner === 'tie');
  c.textAlign = 'center'; c.fillStyle = '#ffc53d'; c.font = `800 28px ${Lb}`; c.fillText('FINAL', W / 2, y + 100);
  c.textAlign = 'left';

  // headline
  y += 240;
  c.fillStyle = '#f5f2ea'; c.font = `900 70px ${D}`;
  for (const line of wrap(c, r.headline.toUpperCase(), W - P * 2).slice(0, 3)) { c.fillText(line, P, y); y += 68; }

  // goat
  y += 10;
  const section = (label, color) => {
    c.fillStyle = color; c.fillRect(P, y - 14, 8, 30);
    c.font = `800 30px ${Lb}`; c.fillText(label, P + 22, y + 2);
    y += 48;
  };
  if (r.goat) {
    section('GOAT OF THE DAY', '#ffc53d');
    const img = await loadImage(goatPhoto);
    const R = 62, cx = P + R, cy = y + R - 10;
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.closePath();
    if (img) {
      c.clip();
      const s = Math.max((R * 2) / img.width, (R * 2) / img.height);
      c.drawImage(img, cx - (img.width * s) / 2, cy - R - (img.height * s - R * 2) * 0.15, img.width * s, img.height * s);
    } else {
      c.fillStyle = goatColor; c.fill();
      c.fillStyle = '#111'; c.font = `900 64px ${D}`; c.textAlign = 'center';
      c.fillText(goatInitial || name(r.goat.id).slice(0, 1).toUpperCase(), cx, cy + 4);
      c.textAlign = 'left';
    }
    c.restore();
    c.strokeStyle = '#ffc53d'; c.lineWidth = 5; c.beginPath(); c.arc(cx, cy, R + 4, 0, Math.PI * 2); c.stroke();
    const tx = P + R * 2 + 30;
    c.fillStyle = '#ffe3a0'; c.font = `900 60px ${D}`; c.fillText(name(r.goat.id).toUpperCase(), tx, y + 10);
    c.fillStyle = '#cfcabf'; c.font = `600 30px ${B}`; c.fillText(r.goat.line || (r.goat.crowd ? 'Crowd MVP' : ''), tx, y + 62);
    y += 156;
  }

  if (r.topPlays.length) {
    section('TOP PLAYS', '#ff5a1f');
    c.font = `600 32px ${B}`;
    r.topPlays.forEach((pl, i) => {
      c.fillStyle = '#ff8b2b'; c.font = `900 40px ${D}`; c.fillText(String(i + 1), P, y + 6);
      c.fillStyle = '#f5f2ea'; c.font = `600 32px ${B}`;
      const lines = wrap(c, `${pl.emoji} ${pl.text}`, W - P * 2 - 50).slice(0, 2);
      lines.forEach((l, j) => c.fillText(l, P + 50, y + 4 + j * 38));
      y += 18 + lines.length * 38;
    });
    y += 10;
  }

  if (r.worstDrop) {
    section('WORST DROP 🧈', '#ff3d5e');
    c.fillStyle = '#f5f2ea'; c.font = `600 32px ${B}`;
    for (const l of wrap(c, r.worstDrop.text, W - P * 2).slice(0, 2)) { c.fillText(l, P, y); y += 40; }
    y += 16;
  }

  if (r.roast && y < H - 150) {
    c.fillStyle = 'rgba(255,255,255,0.05)';
    const lines = (c.font = `italic 600 30px ${B}`, wrap(c, `“${r.roast.text}”`, W - P * 2 - 60).slice(0, Math.max(1, Math.floor((H - 110 - y) / 40))));
    const hgt = 40 + lines.length * 40;
    c.beginPath(); c.roundRect(P, y - 10, W - P * 2, hgt, 18); c.fill();
    c.fillStyle = '#cfcabf';
    lines.forEach((l, i) => c.fillText(l, P + 30, y + 30 + i * 40));
  }

  // footer
  c.fillStyle = '#5a626e'; c.font = `700 26px ${Lb}`; c.textAlign = 'center';
  c.fillText(!crew || crew.toUpperCase() === 'HFL' ? 'HFL' : `${crew.toUpperCase()} · HFL`, W / 2, H - 48);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}
