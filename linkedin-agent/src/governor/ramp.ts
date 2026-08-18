/**
 * The ramp schedule.
 *
 * Caps are a function of how long the agent has been running against this
 * account, not a constant. Opening at the target 50 actions/day on day one is the
 * most reliable way to get an account flagged; ramping reaches the same place in
 * a month with a behaviour curve that looks like someone who got more active.
 *
 * Josh can override with LINKEDIN_AGENT_SKIP_RAMP=1. It ramps by default.
 */

import fs from 'node:fs';
import { CONFIG, PATHS, ensureDirs } from '../config/config.js';
import { RAMP_SCHEDULE, TARGET_CAPS, type Caps } from '../config/caps.js';
import type { ActionType } from '../types.js';

const MS_PER_DAY = 86_400_000;

/**
 * The date the agent first ran, anchoring the ramp. Stored on disk rather than
 * in the DB so that blowing away agent.db during development doesn't silently
 * reset the ramp back to week 1 — or, worse, leave it at week 4 on a fresh account.
 */
export function firstRunDate(now: Date = new Date()): Date {
  ensureDirs();
  if (fs.existsSync(PATHS.firstRun)) {
    const raw = fs.readFileSync(PATHS.firstRun, 'utf8').trim();
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  fs.writeFileSync(PATHS.firstRun, now.toISOString(), 'utf8');
  return now;
}

/** 1-indexed week of operation. Week 1 is the first seven days. */
export function rampWeek(now: Date = new Date(), start?: Date): number {
  const from = start ?? firstRunDate(now);
  const days = Math.floor((now.getTime() - from.getTime()) / MS_PER_DAY);
  return Math.max(1, Math.floor(days / 7) + 1);
}

export function rampMultiplier(now: Date = new Date(), start?: Date): number {
  if (CONFIG.skipRamp) return 1;
  const week = rampWeek(now, start);
  const last = RAMP_SCHEDULE[RAMP_SCHEDULE.length - 1]!;
  if (week >= last.week) return last.multiplier;
  const entry = RAMP_SCHEDULE.find((r) => r.week === week);
  return entry?.multiplier ?? last.multiplier;
}

/**
 * Effective caps for right now. Always at least 1 for any capped type, so a
 * heavy multiplier never silently zeroes out an action type entirely.
 */
export function effectiveCaps(type: ActionType, now: Date = new Date(), start?: Date): Caps {
  const target = TARGET_CAPS[type];
  const m = rampMultiplier(now, start);
  return {
    daily: Math.max(1, Math.floor(target.daily * m)),
    weekly: Math.max(1, Math.floor(target.weekly * m)),
  };
}

/** Total daily write budget across all types — what shows up in `status`. */
export function dailyWriteBudget(now: Date = new Date(), start?: Date): number {
  return (['like', 'comment', 'connect', 'message'] as ActionType[])
    .map((t) => effectiveCaps(t, now, start).daily)
    .reduce((a, b) => a + b, 0);
}
