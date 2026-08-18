/**
 * Timing: when the agent is allowed to act, and how far apart actions sit.
 *
 * This is load-shaping, not concealment. The agent does a day's work spread
 * across the working day instead of firing a day's budget in ninety seconds,
 * which is both what a person does and what keeps from hammering LinkedIn.
 */

import { CONFIG } from '../config/config.js';

export function withinWorkingHours(now: Date = new Date()): boolean {
  const { start, end } = CONFIG.schedule.workingHours;
  const hour = now.getHours();
  return hour >= start && hour < end;
}

export function isQuietDay(now: Date = new Date()): boolean {
  return CONFIG.schedule.quietDays.includes(now.getDay());
}

export function canActNow(now: Date = new Date()): { ok: boolean; reason: string } {
  if (isQuietDay(now)) return { ok: false, reason: `quiet day (day ${now.getDay()})` };
  if (!withinWorkingHours(now)) {
    const { start, end } = CONFIG.schedule.workingHours;
    return { ok: false, reason: `outside working hours ${start}:00-${end}:00 (now ${now.getHours()}:00)` };
  }
  return { ok: true, reason: 'within working window' };
}

/**
 * How many of today's budget should have been spent by now, so a run that
 * starts at 9am doesn't burn the whole day's allowance before lunch.
 */
export function budgetUnlockedByNow(dailyBudget: number, now: Date = new Date()): number {
  const { start, end } = CONFIG.schedule.workingHours;
  const windows = Math.max(1, CONFIG.schedule.windowsPerDay);
  const hour = now.getHours() + now.getMinutes() / 60;

  if (hour < start) return 0;
  if (hour >= end) return dailyBudget;

  const elapsed = (hour - start) / (end - start);
  const windowIndex = Math.floor(elapsed * windows) + 1;
  return Math.min(dailyBudget, Math.ceil((dailyBudget * windowIndex) / windows));
}

export function randomGapMs(rand: () => number = Math.random): number {
  const { min, max } = CONFIG.schedule.actionGapMs;
  return Math.floor(min + rand() * (max - min));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pause between actions. Skipped entirely in dry runs. */
export async function pauseBetweenActions(dryRun = false): Promise<void> {
  if (dryRun) return;
  await sleep(randomGapMs());
}
