/**
 * Daily and weekly ceilings per action type.
 *
 * TARGET_CAPS is where the agent lands at ramp week 4 — roughly 50 actions/day,
 * which is what Josh asked for. RAMP_SCHEDULE scales those targets down for the
 * first three weeks; see governor/ramp.ts for why that matters.
 */

import type { ActionType } from '../types.js';

export interface Caps {
  daily: number;
  weekly: number;
}

/** Steady-state caps, reached at ramp week 4+. */
export const TARGET_CAPS: Record<ActionType, Caps> = {
  // LinkedIn's documented soft ceiling is around 100 connection requests/week.
  // 12/day * 6 active days = 72/week, which leaves real headroom under it.
  connect: { daily: 12, weekly: 72 },
  comment: { daily: 10, weekly: 60 },
  like: { daily: 15, weekly: 90 },
  // Outbound proactive messages. Replies to inbound are counted separately
  // and are not capped — not answering someone who wrote to you is worse
  // behaviour than answering, and it is not what gets accounts flagged.
  message: { daily: 8, weekly: 48 },
  profile_view: { daily: 40, weekly: 240 },
  // Search is the most-detected behaviour of the set, so it gets the hardest cap.
  search: { daily: 6, weekly: 30 },
};

/**
 * Multiplier applied to TARGET_CAPS by week of operation.
 * Week 1 lands near 10 actions/day, week 2 near 20, week 3 near 35, week 4 at target.
 */
export const RAMP_SCHEDULE: Array<{ week: number; multiplier: number }> = [
  { week: 1, multiplier: 0.2 },
  { week: 2, multiplier: 0.4 },
  { week: 3, multiplier: 0.7 },
  { week: 4, multiplier: 1.0 },
];

/** Reply-to-inbound is exempt from caps; tracked for reporting only. */
export const UNCAPPED_REPLY_TO_INBOUND = true;
