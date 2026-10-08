// NFL comps: "who would he be in the league?" We match the SHAPE of a player's ratings
// (what he's best and worst at compared with his own average) against NFL players' styles,
// plus position and build. Shape, not level: nobody at the park is rated like a pro, but a
// guy whose best traits are speed and yards after the catch plays like Tyreek Hill no
// matter what his OVR is. The NFL numbers are our own rough style profiles (0–99 scale,
// unlisted ratings count as 55), not official ratings. Heights/weights are approximate.
import { ATTR_KEYS } from './engine.js';

// pos uses the HFL positions (TE → WR/ATH, safeties → DB, edge/DL → RUSH).
export const NFL_COMPS = [
  // QBs
  { name: 'Patrick Mahomes', pos: 'QB', ht: 74, wt: 225, style: 'No-look, off-platform, sidearm: makes every throw from every angle.', a: { thp: 97, tha: 92, sta: 88, acc: 72, spd: 70, bcv: 80, jkm: 66, cod: 70 } },
  { name: 'Josh Allen', pos: 'QB', ht: 77, wt: 237, style: 'Cannon arm and runs people over when he tucks it.', a: { thp: 99, tha: 84, str: 88, spd: 78, btk: 85, car: 78, sta: 90 } },
  { name: 'Lamar Jackson', pos: 'QB', ht: 74, wt: 215, style: 'The fastest guy on the field happens to be the QB.', a: { spd: 96, acc: 96, jkm: 95, cod: 94, bcv: 92, tha: 82, thp: 85, rac: 88 } },
  { name: 'Michael Vick', pos: 'QB', ht: 72, wt: 215, style: 'Rocket arm, track speed, pure chaos.', a: { spd: 97, acc: 97, thp: 95, jkm: 93, cod: 92, tha: 72, bcv: 85 } },
  { name: 'Tom Brady', pos: 'QB', ht: 76, wt: 225, style: 'Surgical and patient. Beats you with his head, not his legs.', a: { tha: 98, thp: 85, sta: 95, spd: 40, acc: 42, jkm: 35 } },
  { name: 'Peyton Manning', pos: 'QB', ht: 77, wt: 230, style: 'Runs the whole offense at the line. Pinpoint on every short and intermediate throw.', a: { tha: 97, thp: 82, sta: 90, spd: 38, acc: 40 } },
  { name: 'Drew Brees', pos: 'QB', ht: 72, wt: 209, style: 'Throws the most accurate ball on the planet, not the hardest.', a: { tha: 99, thp: 78, sta: 88, spd: 45, acc: 55 } },
  { name: 'Aaron Rodgers', pos: 'QB', ht: 74, wt: 225, style: 'Quick release, perfect spirals and a sneaky scramble.', a: { tha: 96, thp: 92, acc: 68, spd: 66, bcv: 72, sta: 85 } },
  { name: 'Joe Burrow', pos: 'QB', ht: 76, wt: 221, style: 'Cool in the pocket, anticipates everything.', a: { tha: 95, thp: 84, sta: 88, acc: 58, spd: 55 } },
  // WRs and tight ends
  { name: 'Tyreek Hill', pos: 'WR', ht: 70, wt: 191, style: 'Blink and he\'s behind the defense.', a: { spd: 99, acc: 99, rac: 94, jkm: 90, cod: 92, rls: 88, rte: 86, cth: 84, str: 45 } },
  { name: 'Justin Jefferson', pos: 'WR', ht: 73, wt: 195, style: 'Gets open on anybody. Catches everything.', a: { rte: 98, cth: 95, rls: 94, spd: 90, acc: 90, cod: 90, rac: 86 } },
  { name: 'Davante Adams', pos: 'WR', ht: 73, wt: 215, style: 'The release is a magic trick. Corners guess wrong.', a: { rls: 99, rte: 97, cth: 93, cod: 88, spd: 84, acc: 86 } },
  { name: 'Jerry Rice', pos: 'WR', ht: 74, wt: 200, style: 'The GOAT route runner who never stopped working.', a: { rte: 99, cth: 96, sta: 99, rac: 88, rls: 92, spd: 86 } },
  { name: 'Randy Moss', pos: 'WR', ht: 76, wt: 210, style: 'Just throw it up. He\'s going to get it.', a: { spd: 97, cth: 94, rls: 85, rte: 80, acc: 92, str: 70 } },
  { name: 'Calvin Johnson', pos: 'WR', ht: 77, wt: 237, style: 'Megatron: too big, too fast, too strong.', a: { str: 90, cth: 94, spd: 90, rls: 88, btk: 82, rte: 85 } },
  { name: 'Julian Edelman', pos: 'WR', ht: 70, wt: 198, style: 'Shifty slot guy who wins with quickness and toughness.', a: { cod: 96, acc: 92, rte: 92, cth: 90, jkm: 88, sta: 92, spd: 78, thp: 60 } },
  { name: 'Cooper Kupp', pos: 'WR', ht: 74, wt: 208, style: 'Always open, always catches it, always gets a few more yards.', a: { rte: 96, cth: 95, rac: 90, bcv: 86, spd: 80, cod: 86 } },
  { name: 'Deebo Samuel', pos: 'WR', ht: 71, wt: 215, style: 'Wide receiver who runs like a running back.', a: { rac: 98, btk: 94, str: 86, bcv: 88, car: 88, spd: 88, cth: 82, rte: 74 } },
  { name: 'Travis Kelce', pos: 'WR', ht: 77, wt: 250, style: 'Big body who finds the soft spot in every zone.', a: { cth: 94, rte: 93, str: 86, bcv: 86, rac: 84, spd: 72 } },
  { name: 'Rob Gronkowski', pos: 'WR', ht: 78, wt: 265, style: 'Human wrecking ball with great hands.', a: { str: 96, btk: 95, cth: 92, car: 88, spd: 68, rte: 76 } },
  // RBs
  { name: 'Christian McCaffrey', pos: 'RB', ht: 71, wt: 210, style: 'Runs it, catches it, runs routes like a receiver.', a: { cth: 90, rte: 88, bcv: 94, cod: 92, acc: 92, spd: 90, rac: 92, jkm: 86, sta: 92 } },
  { name: 'Barry Sanders', pos: 'RB', ht: 68, wt: 203, style: 'Nobody has ever made more people miss.', a: { jkm: 99, cod: 99, acc: 98, bcv: 94, spd: 92, btk: 80 } },
  { name: 'Derrick Henry', pos: 'RB', ht: 75, wt: 247, style: 'Stiff-arms linebackers into next week.', a: { str: 97, btk: 98, car: 94, spd: 90, bcv: 86, sta: 94, cth: 50 } },
  { name: 'Marshawn Lynch', pos: 'RB', ht: 71, wt: 215, style: 'Beast Mode: you have to bring friends to tackle him.', a: { btk: 99, str: 92, car: 92, bcv: 88, sta: 90, spd: 80 } },
  { name: 'Saquon Barkley', pos: 'RB', ht: 72, wt: 233, style: 'Home-run hitter with a hurdle in his pocket.', a: { spd: 95, acc: 94, jkm: 90, btk: 88, bcv: 90, str: 86 } },
  { name: 'Alvin Kamara', pos: 'RB', ht: 70, wt: 215, style: 'Slippery in space, great hands out of the backfield.', a: { jkm: 94, cod: 93, cth: 88, rac: 94, bcv: 90, btk: 86 } },
  { name: 'Darren Sproles', pos: 'RB', ht: 66, wt: 190, style: 'Tiny, quick, and gone before you blink.', a: { acc: 97, cod: 96, jkm: 94, cth: 88, rac: 92, str: 40 } },
  // DBs
  { name: 'Deion Sanders', pos: 'DB', ht: 73, wt: 195, style: 'Prime Time: shuts down half the field, then scores.', a: { mcv: 98, spd: 99, acc: 98, cod: 95, bcv: 90, jkm: 90, tak: 50 } },
  { name: 'Darrelle Revis', pos: 'DB', ht: 71, wt: 198, style: 'Revis Island: the best receiver disappears.', a: { mcv: 99, cod: 94, acc: 90, spd: 88, tak: 80, sta: 90 } },
  { name: 'Jalen Ramsey', pos: 'DB', ht: 73, wt: 208, style: 'Physical lockdown corner who talks the whole game.', a: { mcv: 94, str: 86, tak: 86, spd: 90, cod: 88 } },
  { name: 'Ed Reed', pos: 'DB', ht: 71, wt: 200, style: 'Reads the QB\'s mind, then takes it to the house.', a: { mcv: 90, bcv: 95, rac: 92, spd: 88, cth: 88, tak: 82 } },
  { name: 'Troy Polamalu', pos: 'DB', ht: 70, wt: 207, style: 'Everywhere at once. Flies to the ball and hits.', a: { tak: 94, acc: 95, spd: 90, str: 84, mcv: 86, sta: 92 } },
  { name: 'Travis Hunter', pos: 'ATH', ht: 73, wt: 188, style: 'Two-way star: lockdown corner and go-to receiver.', a: { mcv: 94, cth: 94, rte: 90, spd: 92, sta: 99, cod: 92, rls: 86 } },
  // LBs
  { name: 'Ray Lewis', pos: 'LB', ht: 73, wt: 250, style: 'Sideline to sideline, and every hit is a message.', a: { tak: 99, str: 92, sta: 92, spd: 84, mcv: 78 } },
  { name: 'Luke Kuechly', pos: 'LB', ht: 75, wt: 238, style: 'Always in the right spot. Tackles everything, covers too.', a: { tak: 96, mcv: 88, acc: 88, sta: 90, str: 84 } },
  { name: 'Micah Parsons', pos: 'LB', ht: 75, wt: 245, style: 'Linebacker with edge-rusher speed. QBs never feel safe.', a: { acc: 97, spd: 94, tak: 92, str: 90, cod: 86 } },
  // pass rushers
  { name: 'Lawrence Taylor', pos: 'RUSH', ht: 75, wt: 237, style: 'The reason offenses changed. Pure terror off the edge.', a: { acc: 98, spd: 92, tak: 97, str: 90, sta: 88 } },
  { name: 'Aaron Donald', pos: 'RUSH', ht: 73, wt: 280, style: 'Too quick for guards, too strong for everybody.', a: { str: 99, acc: 96, tak: 95, cod: 86, sta: 90 } },
  { name: 'T.J. Watt', pos: 'RUSH', ht: 76, wt: 252, style: 'Relentless. Sacks, strips and never takes a play off.', a: { tak: 97, str: 90, acc: 92, sta: 95, spd: 86 } },
  { name: 'Reggie White', pos: 'RUSH', ht: 77, wt: 291, style: 'The Minister of Defense: throws blockers aside.', a: { str: 99, tak: 94, sta: 90, acc: 85 } },
  // do-everything guys
  { name: 'Taysom Hill', pos: 'ATH', ht: 74, wt: 221, style: 'QB, RB, TE, special teams. Whatever you need.', a: { str: 88, btk: 88, thp: 80, tha: 62, car: 86, spd: 82, sta: 90 } },
  { name: 'Cordarrelle Patterson', pos: 'ATH', ht: 74, wt: 220, style: 'Receiver, running back, returner, all speed and power.', a: { spd: 94, btk: 88, rac: 92, bcv: 86, str: 84, car: 84 } },
];

const DEFAULT = 55;
const full = (a) => Object.fromEntries(ATTR_KEYS.map((k) => [k, a[k] ?? DEFAULT]));
const shape = (a) => {
  const v = ATTR_KEYS.map((k) => a[k]);
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return v.map((x) => x - m);
};
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

const GROUP = { QB: 'qb', WR: 'skill', RB: 'skill', DB: 'def', LB: 'def', RUSH: 'def', ATH: 'ath' };
function positionFit(mine, theirs) {
  if (mine === theirs) return 0.25;
  const a = GROUP[mine] || 'ath', b = GROUP[theirs] || 'ath';
  if (a === 'ath' || b === 'ath') return 0.12;
  return a === b ? 0.12 : 0;
}

// → { flat, comps: [{ name, pos, style, match (50–99), shared: [attrKey, attrKey] }] }
export function nflComps(attrs, { position = 'ATH', heightIn = null, weightLb = null } = {}, n = 3) {
  const mine = shape(full(attrs));
  const size = norm(mine);
  const flat = size < 6; // everything within a couple points of average: no real shape yet
  const scored = NFL_COMPS.map((c) => {
    const theirs = shape(full(c.a));
    const cos = flat ? 0 : mine.reduce((s, x, i) => s + x * theirs[i], 0) / (size * norm(theirs));
    let score = cos + positionFit(position || 'ATH', c.pos);
    if (heightIn) score -= Math.min(0.2, Math.abs(heightIn - c.ht) / 40);
    if (weightLb) score -= Math.min(0.2, Math.abs(weightLb - c.wt) / 300);
    // the traits that make them alike: both well above their own average
    const shared = ATTR_KEYS.map((k, i) => [k, Math.min(mine[i], theirs[i])]).filter(([, v]) => v > 1).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k);
    return { name: c.name, pos: c.pos, style: c.style, score, shared };
  }).sort((x, y) => y.score - x.score);
  const comps = scored.slice(0, n).map((c) => ({ ...c, match: Math.max(50, Math.min(99, Math.round(60 + c.score * 30))) }));
  return { flat, comps };
}
