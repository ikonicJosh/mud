/**
 * Governor tests: caps, ramp, pacing, and the kill switch.
 *
 * These run against a temp database so they never touch the real agent.db.
 * Times are injected rather than mocked globally — the point of `now` being a
 * parameter throughout the governor is that this is testable without a fake clock.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { useDatabase, closeDatabase, db } from '../src/memory/db.js';
import { effectiveCaps, rampWeek, rampMultiplier, dailyWriteBudget } from '../src/governor/ramp.js';
import { budgetUnlockedByNow, canActNow, withinWorkingHours } from '../src/governor/pacing.js';
import { startOfDay, startOfWeek } from '../src/governor/index.js';
import { TARGET_CAPS } from '../src/config/caps.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-agent-test-'));
  useDatabase(path.join(tmpDir, 'test.db'));
});

after(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM actions; DELETE FROM interactions; DELETE FROM prospects;');
});

describe('ramp schedule', () => {
  const start = new Date('2026-03-01T09:00:00Z');

  test('week 1 starts on day 0', () => {
    assert.equal(rampWeek(new Date('2026-03-01T10:00:00Z'), start), 1);
    assert.equal(rampWeek(new Date('2026-03-07T23:00:00Z'), start), 1);
  });

  test('rolls into later weeks', () => {
    assert.equal(rampWeek(new Date('2026-03-08T10:00:00Z'), start), 2);
    assert.equal(rampWeek(new Date('2026-03-15T10:00:00Z'), start), 3);
    assert.equal(rampWeek(new Date('2026-03-22T10:00:00Z'), start), 4);
  });

  test('holds at the final multiplier after week 4', () => {
    assert.equal(rampMultiplier(new Date('2026-06-01T10:00:00Z'), start), 1);
    assert.equal(rampMultiplier(new Date('2027-01-01T10:00:00Z'), start), 1);
  });

  test('week 1 caps are a fraction of target, week 4 reaches it', () => {
    const wk1 = effectiveCaps('connect', new Date('2026-03-02T10:00:00Z'), start);
    const wk4 = effectiveCaps('connect', new Date('2026-03-25T10:00:00Z'), start);

    assert.ok(wk1.daily < wk4.daily, 'week 1 should be below week 4');
    assert.equal(wk4.daily, TARGET_CAPS.connect.daily);
  });

  test('never zeroes an action type out entirely', () => {
    for (const type of ['connect', 'comment', 'like', 'message', 'search'] as const) {
      const caps = effectiveCaps(type, new Date('2026-03-02T10:00:00Z'), start);
      assert.ok(caps.daily >= 1, `${type} daily cap should be at least 1`);
    }
  });

  test('week 1 total write budget lands near 10/day, not 50', () => {
    const budget = dailyWriteBudget(new Date('2026-03-02T10:00:00Z'), start);
    assert.ok(budget >= 6 && budget <= 14, `expected roughly 10, got ${budget}`);
  });

  test('week 4 total write budget reaches the ~45 target', () => {
    const budget = dailyWriteBudget(new Date('2026-03-25T10:00:00Z'), start);
    assert.ok(budget >= 40, `expected at least 40, got ${budget}`);
  });
});

describe('pacing', () => {
  test('working hours honour the configured window', () => {
    assert.equal(withinWorkingHours(atLocalHour(9)), true);
    assert.equal(withinWorkingHours(atLocalHour(7)), false);
    assert.equal(withinWorkingHours(atLocalHour(19)), false);
  });

  test('budget unlocks gradually across the day', () => {
    const early = budgetUnlockedByNow(12, atLocalHour(8, 30));
    const midday = budgetUnlockedByNow(12, atLocalHour(13));
    const late = budgetUnlockedByNow(12, atLocalHour(17, 30));

    assert.ok(early < midday, `early ${early} should be under midday ${midday}`);
    assert.ok(midday < late, `midday ${midday} should be under late ${late}`);
    assert.ok(early <= 4, `should not unlock the whole day at 8:30, got ${early}`);
    assert.equal(late, 12);
  });

  test('nothing unlocks before the working day', () => {
    assert.equal(budgetUnlockedByNow(12, atLocalHour(6)), 0);
  });

  test('everything is unlocked after the working day', () => {
    assert.equal(budgetUnlockedByNow(12, atLocalHour(22)), 12);
  });

  test('Sunday is a quiet day', () => {
    // 2026-03-08 is a Sunday.
    const sunday = new Date(2026, 2, 8, 10, 0, 0);
    assert.equal(canActNow(sunday).ok, false);
  });

  test('a weekday inside the window is allowed', () => {
    // 2026-03-10 is a Tuesday.
    const tuesday = new Date(2026, 2, 10, 10, 0, 0);
    assert.equal(canActNow(tuesday).ok, true);
  });
});

describe('period boundaries', () => {
  test('startOfDay is midnight local, formatted for SQLite', () => {
    const s = startOfDay(new Date(2026, 2, 10, 15, 30, 0));
    assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('startOfWeek anchors to Monday', () => {
    // Wednesday 2026-03-11 -> Monday 2026-03-09
    const wed = new Date(2026, 2, 11, 12, 0, 0);
    const mon = new Date(2026, 2, 9, 12, 0, 0);
    assert.equal(startOfWeek(wed), startOfWeek(mon));
  });

  test('Sunday belongs to the week that just ended, not the next one', () => {
    const sun = new Date(2026, 2, 15, 12, 0, 0); // Sunday
    const mon = new Date(2026, 2, 9, 12, 0, 0); // preceding Monday
    assert.equal(startOfWeek(sun), startOfWeek(mon));
  });
});

/** Build a Date at a given local hour on a fixed weekday (Tuesday). */
function atLocalHour(hour: number, minute = 0): Date {
  return new Date(2026, 2, 10, hour, minute, 0);
}
