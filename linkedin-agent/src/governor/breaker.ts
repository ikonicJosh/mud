/**
 * The circuit breaker.
 *
 * Trips on any sign that LinkedIn has noticed — a checkpoint, a CAPTCHA, an
 * unusual-activity interstitial — or that the page changed under us and the
 * selectors no longer mean what they meant.
 *
 * When it trips it stops everything and tells Josh. It does not try to solve a
 * CAPTCHA, wait one out, or route around a checkpoint. Getting past a challenge
 * is the line this build doesn't cross: the point of the breaker is to fail
 * loudly at exactly the moment the alternative is to start evading.
 */

import { setState, getState } from '../memory/db.js';
import { escalate } from '../memory/audit.js';
import { pause } from './killswitch.js';

export type TripReason =
  | 'checkpoint'
  | 'captcha'
  | 'unusual_activity'
  | 'login_required'
  | 'rate_limited'
  | 'selector_missing'
  | 'repeated_failures';

const STATE_KEY = 'breaker.tripped';

/** Signals in page content or URL that mean stop immediately. */
const PAGE_SIGNALS: Array<{ reason: TripReason; test: RegExp }> = [
  { reason: 'checkpoint', test: /\/checkpoint\/|security\s+verification|verify\s+it'?s\s+you/i },
  { reason: 'captcha', test: /captcha|are\s+you\s+a\s+human|puzzle\s+to\s+verify/i },
  { reason: 'unusual_activity', test: /unusual\s+activity|automated\s+(?:activity|behavior)|restricted\s+your\s+account/i },
  { reason: 'login_required', test: /\/uas\/login|\/login\?|sign\s+in\s+to\s+linkedin/i },
  { reason: 'rate_limited', test: /you'?ve\s+reached\s+the\s+(?:weekly|monthly)\s+(?:invitation|limit)|try\s+again\s+later/i },
];

export interface BreakerTrip {
  reason: TripReason;
  detail: string;
  at: string;
}

/**
 * Inspect a page's URL and visible text. Returns the trip if one fired, so the
 * caller can abandon the current action before doing anything else.
 */
export function inspectPage(url: string, bodyText: string): BreakerTrip | null {
  const haystack = `${url}\n${bodyText.slice(0, 20_000)}`;
  for (const signal of PAGE_SIGNALS) {
    if (signal.test.test(haystack)) {
      return trip(signal.reason, `matched ${signal.test} on ${url}`);
    }
  }
  return null;
}

export function trip(reason: TripReason, detail: string): BreakerTrip {
  const record: BreakerTrip = { reason, detail, at: new Date().toISOString() };
  setState(STATE_KEY, JSON.stringify(record));
  escalate({
    prospectId: null,
    reason: 'breaker_tripped',
    detail: `circuit breaker tripped: ${reason} — ${detail}`,
  });
  pause(`circuit breaker: ${reason} — ${detail}`);
  return record;
}

export function isTripped(): BreakerTrip | null {
  const raw = getState(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BreakerTrip;
  } catch {
    return null;
  }
}

/** Clear the breaker. Deliberately separate from `resume` so Josh has to look at it. */
export function reset(): void {
  setState(STATE_KEY, '');
}

/**
 * Consecutive-failure tracker. Repeated action failures usually mean LinkedIn
 * changed the DOM, which is a stop-and-look situation rather than a retry loop.
 */
let consecutiveFailures = 0;
const FAILURE_LIMIT = 3;

export function noteFailure(detail: string): BreakerTrip | null {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_LIMIT) {
    const t = trip('repeated_failures', `${consecutiveFailures} consecutive failures — ${detail}`);
    consecutiveFailures = 0;
    return t;
  }
  return null;
}

export function noteSuccess(): void {
  consecutiveFailures = 0;
}

export function failureCount(): number {
  return consecutiveFailures;
}
