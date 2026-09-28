// Demo league so a fresh install has something to look at. Loaded from Settings
// (or the first-run screen) and only into an empty league.
import { balanceTeams, computeLeague } from './public/engine.js';

const CREW = [
  ['Marcus Hill', 'Slingshot', 'QB', 84, '🎯', '#ff6b1a', 7],
  ['Devon Price', 'Glue Hands', 'WR', 81, '🧤', '#35c7ff', 11],
  ['Tyler Brooks', 'The Wall', 'WR', 72, '🧱', '#9aa4b2', 55],
  ['Andre Coleman', 'Jet', 'WR', 86, '⚡', '#ffd23f', 1],
  ['Chris Nguyen', 'Ball Hawk', 'DB', 80, '🦅', '#7cff6b', 24],
  ['Jake Morales', 'Butterfingers', 'WR', 63, '🧈', '#f7a8ff', 88],
  ['Sam Okafor', 'Blitz', 'RUSH', 78, '💥', '#ff4d6d', 99],
  ['Ryan Walsh', 'Grandpa', 'QB', 70, '👴', '#c0a080', 12],
  ['Luis Ortega', 'Spin Cycle', 'RB', 76, '🌀', '#00e0c6', 22],
  ['Ben Carter', 'Cleats', 'LB', 68, '👟', '#a78bfa', 50],
  ['Nate Kim', 'Wheels', 'ATH', 74, '🛞', '#fb923c', 3],
  ['Omar Haddad', 'Mr. Clutch', 'DB', 79, '🧊', '#60a5fa', 21],
];

// Small seeded RNG so the demo looks the same every time.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function buildDemo(newId, season) {
  const rand = rng(20260928);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const ts = (d, min) => new Date(Date.parse(`${d}T18:00:00Z`) + min * 60000).toISOString();

  const players = CREW.map(([name, nickname, position, startOvr, emoji, color, number]) => ({
    id: newId(), name, nickname, position, startOvr, emoji, color, number, active: true,
    createdAt: '2026-08-01T12:00:00.000Z',
  }));
  const P = Object.fromEntries(players.map((p) => [p.nickname, p.id]));
  const db = { players, games: [], posts: [], plays: [], fame: [] };

  const qbOf = (team) => team.find((id) => players.find((p) => p.id === id).position === 'QB') || team[0];
  const dates = ['2026-09-06', '2026-09-13', '2026-09-20'];
  dates.forEach((date, gi) => {
    const roster = players.slice(0).sort(() => rand() - 0.5).slice(0, 10);
    const league = computeLeague(db);
    const split = balanceTeams(roster.map((p) => ({ id: p.id, elo: league.elo[p.id], position: p.position })), { random: rand });
    const teams = { A: split.A, B: split.B };
    const events = [];
    let min = 0; // minutes after kickoff
    const add = (type, p1, p2, team) => events.push({ id: newId(), type, p1, p2: p2 || null, team, ts: ts(date, (min += 2)), by: null });
    for (let drive = 0; drive < 14; drive++) {
      const off = drive % 2 ? 'B' : 'A';
      const def = off === 'A' ? 'B' : 'A';
      const qb = qbOf(teams[off]);
      const targets = teams[off].filter((id) => id !== qb);
      const skill = (id) => players.find((p) => p.id === id).startOvr;
      for (let play = 0; play < 3; play++) {
        const r = rand();
        const t = pick(targets);
        if (r < 0.45) add('catch', qb, t, off);
        else if (r < 0.6) add('incomplete', qb, t, off);
        else if (r < 0.66 + (skill(t) < 70 ? 0.1 : 0)) add('drop', t, qb, off);
        else if (r < 0.74) add('sack', pick(teams[def]), qb, def);
        else if (r < 0.8) { add(rand() < 0.2 ? 'pick_six' : 'int', pick(teams[def]), qb, def); break; }
        else if (r < 0.95) {
          if (rand() < 0.8) add('pass_td', qb, t, off); else add('rush_td', t, null, off);
          add(rand() < 0.6 ? 'pat1' : 'pat2', t, null, off);
          break;
        }
      }
    }
    const mvpVotes = {};
    const all = [...teams.A, ...teams.B];
    for (const voter of all) {
      if (rand() < 0.3) continue;
      const choice = pick(all.filter((id) => id !== voter));
      mvpVotes[voter] = rand() < 0.5 ? (qbOf(teams.A) !== voter ? qbOf(teams.A) : choice) : choice;
    }
    db.games.push({
      id: newId(), date, time: '18:00', location: 'Riverside Park', season,
      teamNames: [{ A: 'Shirts', B: 'Skins' }, { A: 'Dogs', B: 'Cats' }, { A: 'Mud Hens', B: 'Sharks' }][gi],
      status: 'final', rsvps: Object.fromEntries(roster.map((p) => [p.id, 'in'])), teams, events, mvpVotes,
      createdAt: ts(date, 0), startedAt: ts(date, 0), endedAt: ts(date, 59),
    });
  });

  // Next week's game with RSVPs rolling in
  const rsvps = {};
  players.forEach((p, i) => { if (i < 9) rsvps[p.id] = 'in'; else if (i === 9) rsvps[p.id] = 'out'; });
  db.games.push({
    id: newId(), date: '2026-10-04', time: '18:00', location: 'Riverside Park', season,
    teamNames: { A: 'Shirts', B: 'Skins' }, status: 'scheduled', rsvps, teams: { A: [], B: [] },
    events: [], mvpVotes: {}, createdAt: '2026-09-27T12:00:00.000Z',
  });

  const lastGame = db.games[2];
  const post = (who, text, min, gameId = lastGame.id) =>
    db.posts.push({ id: newId(), authorId: P[who], text, gameId, reactions: {}, createdAt: ts('2026-09-20', min) });
  post('Jet', 'Somebody tell Butterfingers the ball is supposed to stay IN your hands 🧈', 70);
  post('Butterfingers', 'Sun was in my eyes. At 7pm. In September. Leave me alone.', 72);
  post('Slingshot', 'Arm feels great. Receivers feel... present.', 75);
  post('Blitz', 'Grandpa got sacked so many times he asked for his pension early', 78);
  db.posts[0].reactions = { '😂': [P.Slingshot, P.Blitz, P.Wheels], '🔥': [P['Ball Hawk']] };
  db.posts[3].reactions = { '💀': [P.Jet, P['Glue Hands'], P.Cleats, P.Butterfingers] };

  const wr = (id, label, x, y, color) => ({ id, label, side: 'O', x, y, color });
  db.plays.push({
    id: newId(), name: 'Mesh Madness', formation: 'spread', authorId: P.Slingshot,
    notes: 'H and Y cross underneath at 5 yards. X runs a post to clear the middle. Z is the check-down on the out.',
    players: [
      wr('o1', 'QB', 50, 86, '#ffffff'), wr('o2', 'X', 8, 80, '#ff6b1a'), wr('o3', 'H', 30, 81, '#35c7ff'),
      wr('o4', 'Y', 70, 81, '#ffd23f'), wr('o5', 'Z', 92, 80, '#7cff6b'),
    ],
    routes: [
      { id: 'r1', pid: 'o2', style: 'route', points: [[8, 80], [8, 60], [34, 40]] },
      { id: 'r2', pid: 'o3', style: 'route', points: [[30, 81], [36, 74], [80, 72]] },
      { id: 'r3', pid: 'o4', style: 'route', points: [[70, 81], [64, 75], [20, 73]] },
      { id: 'r4', pid: 'o5', style: 'route', points: [[92, 80], [92, 68], [99, 68]] },
    ],
    createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z',
  });
  db.plays.push({
    id: newId(), name: 'Jet Sweep Double Move', formation: 'trips', authorId: P.Jet,
    notes: 'Motion Jet across, fake the sweep, he runs a wheel. Slingshot pump fakes the flat.',
    players: [
      wr('o1', 'QB', 50, 86, '#ffffff'), wr('o2', 'J', 8, 80, '#ffd23f'), wr('o3', 'H', 62, 81, '#35c7ff'),
      wr('o4', 'Y', 77, 81, '#ff6b1a'), wr('o5', 'Z', 92, 80, '#7cff6b'),
    ],
    routes: [
      { id: 'r1', pid: 'o2', style: 'motion', points: [[8, 80], [40, 84]] },
      { id: 'r2', pid: 'o2', style: 'route', points: [[40, 84], [58, 86], [72, 72], [74, 22]] },
      { id: 'r3', pid: 'o3', style: 'route', points: [[62, 81], [62, 62], [50, 54]] },
      { id: 'r4', pid: 'o4', style: 'route', points: [[77, 81], [77, 66], [88, 58]] },
      { id: 'r5', pid: 'o5', style: 'route', points: [[92, 80], [92, 40]] },
    ],
    createdAt: '2026-09-14T12:00:00.000Z', updatedAt: '2026-09-14T12:00:00.000Z',
  });

  const fame = (category, title, description, who, votes, gameId = lastGame.id) =>
    db.fame.push({ id: newId(), category, title, description, playerIds: who.map((n) => P[n]), gameId, eventId: null,
      authorId: P.Jet, votes: votes.map((n) => P[n]), image: null, createdAt: ts('2026-09-20', 80) });
  fame('best', 'The One-Handed Snag', 'Glue Hands laid out full extension, one hand, fingertips, somehow got a foot down by the cone. Nobody has recovered.', ['Glue Hands'], ['Jet', 'Slingshot', 'Blitz', 'Wheels']);
  fame('drop', 'Wide Open. End Zone. Nope.', 'Butterfingers was so open the defense went to get water. Ball hit him in both hands and the facemask he wasn\'t wearing.', ['Butterfingers'], ['Jet', 'Blitz', 'Cleats', 'Ball Hawk', 'Grandpa']);
  fame('dumb', 'Celebrated at the 5', 'Spin Cycle started the TD dance at the 5-yard line. Got two-hand touched at the 2. Dance was fire though.', ['Spin Cycle'], ['Slingshot', 'Mr. Clutch']);

  return db;
}
