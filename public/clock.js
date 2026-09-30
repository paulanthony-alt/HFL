// Optional game clock. Stored on the game as game.clock = { startedAt, pausedAt, quarter }:
// the clock reads (pausedAt or now) − startedAt, so every phone works out the same time
// from the same two timestamps without anyone having to push ticks. Resuming moves
// startedAt forward by however long it sat paused. No clock (null) means it's hidden.

export const CLOCK_ACTIONS = ['start', 'pause', 'resume', 'next-quarter', 'reset', 'off'];
export const MAX_QUARTER = 8; // Q1–Q4, then up to four overtimes

const ms = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();

export const isRunning = (c) => !!c?.startedAt && !c.pausedAt;

// Milliseconds on the clock at time `now` (ms). Never negative, even if a phone's
// own clock is a little behind the phone that started it.
export function clockElapsed(c, now) {
  if (!c?.startedAt) return 0;
  const end = c.pausedAt ? ms(c.pausedAt) : now;
  return Math.max(0, end - ms(c.startedAt));
}

// 0 → "0:00", 754000 → "12:34", 3723000 → "1:02:03"
export function formatClock(t) {
  const s = Math.floor(Math.max(0, t) / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export const quarterLabel = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);

// The next clock after `action` at time nowIso. Throws Error(message) for moves that
// don't make sense (pausing a paused clock...), so two phones tapping at once can't
// knock it into a weird state.
export function applyClock(c, action, nowIso) {
  const now = ms(nowIso);
  if (!Number.isFinite(now)) throw new Error('bad time');
  switch (action) {
    case 'start':
      if (c?.startedAt) throw new Error('the clock is already on');
      return { startedAt: iso(now), pausedAt: null, quarter: 1 };
    case 'pause':
      if (!isRunning(c)) throw new Error("the clock isn't running");
      return { ...c, pausedAt: iso(now) };
    case 'resume':
      if (!c?.startedAt || !c.pausedAt) throw new Error("the clock isn't paused");
      return { ...c, startedAt: iso(ms(c.startedAt) + (now - ms(c.pausedAt))), pausedAt: null };
    case 'next-quarter':
      if (!c?.startedAt) throw new Error('start the clock first');
      if ((c.quarter || 1) >= MAX_QUARTER) throw new Error('that is a lot of overtime');
      // new quarter starts at 0:00, paused until someone taps start
      return { startedAt: iso(now), pausedAt: iso(now), quarter: (c.quarter || 1) + 1 };
    case 'reset':
      if (!c?.startedAt) throw new Error('start the clock first');
      return { startedAt: iso(now), pausedAt: iso(now), quarter: c.quarter || 1 };
    case 'off':
      return null;
    default:
      throw new Error('unknown clock action');
  }
}
