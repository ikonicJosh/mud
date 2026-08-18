/**
 * The governor.
 *
 * Every write to LinkedIn goes through `request()`. Action modules never touch
 * Playwright directly — they draft, they ask, and they execute only what comes
 * back allowed. That single chokepoint is what makes the safety properties
 * checkable: there is one function to read to know everything the agent will and
 * won't do.
 *
 * Order of checks is deliberate — cheapest and most absolute first, so a paused
 * agent never burns a model call or a page load deciding whether it's allowed.
 */

import { CONFIG } from '../config/config.js';
import { UNCAPPED_REPLY_TO_INBOUND } from '../config/caps.js';
import type {
  AuditRecord,
  DraftedAction,
  GovernorDecision,
  Prospect,
  ThreadClassification,
} from '../types.js';
import { WRITE_ACTIONS } from '../types.js';
import { countActionsSince, escalate, lastOutbound, recordAction } from '../memory/audit.js';
import { db } from '../memory/db.js';
import { isPaused, pauseReason } from './killswitch.js';
import { isTripped } from './breaker.js';
import { canActNow, budgetUnlockedByNow } from './pacing.js';
import { effectiveCaps } from './ramp.js';
import { evaluate, type RuleContext } from './rules.js';

export interface RequestContext {
  prospect: Prospect | null;
  threadClassification?: ThreadClassification | null;
  /** Replies to someone who wrote to us are exempt from caps and pacing. */
  isReplyToInbound?: boolean;
  now?: Date;
  /** Dry runs evaluate everything and execute nothing. */
  dryRun?: boolean;
}

export interface GovernorResult extends GovernorDecision {
  /** Audit row id, so the caller can attach the outcome after executing. */
  auditId: number;
}

/**
 * Decide whether one drafted action may execute, and record the decision.
 *
 * Returns `allow` only when every check passes. The audit row is written here,
 * before execution, so an action that crashes mid-flight still leaves a trace.
 */
export function request(action: DraftedAction, ctx: RequestContext): GovernorResult {
  const now = ctx.now ?? new Date();
  const decision = decide(action, ctx, now);

  // An allowed action is logged as 'deferred' until it actually runs and the
  // caller calls settle(). Logging it as 'success' up front would let a crash
  // mid-action inflate the cap counters against work that never happened.
  const outcome: AuditRecord['outcome'] =
    decision.decision === 'block'
      ? 'blocked'
      : decision.decision === 'defer'
        ? 'deferred'
        : ctx.dryRun
          ? 'dry_run'
          : 'deferred';

  const auditId = recordAction({ action, decision, outcome });
  return { ...decision, auditId };
}

function decide(action: DraftedAction, ctx: RequestContext, now: Date): GovernorDecision {
  // 1. Kill switch. Absolute, checked before anything else.
  if (isPaused()) {
    return { decision: 'block', reason: `kill switch active: ${pauseReason() ?? 'unknown'}` };
  }

  // 2. Circuit breaker.
  const tripped = isTripped();
  if (tripped) {
    return { decision: 'block', reason: `circuit breaker tripped (${tripped.reason})` };
  }

  const isWrite = WRITE_ACTIONS.includes(action.actionType);

  // 3. Master write switch and per-phase rollout.
  if (isWrite) {
    if (!CONFIG.writesEnabled) {
      return { decision: 'block', reason: 'writes disabled (LINKEDIN_AGENT_WRITES is not set)' };
    }
    const enabled = CONFIG.enabledWriteActions as string[];
    if (!enabled.includes(action.actionType)) {
      return {
        decision: 'block',
        reason: `${action.actionType} not in enabledWriteActions [${enabled.join(', ') || 'none'}]`,
      };
    }
  }

  // 4. Hard rules — the never-dos. These run before caps, because a rule
  //    violation should surface to Josh even on a day the budget is spent.
  const ruleCtx: RuleContext = {
    prospect: ctx.prospect,
    threadClassification: ctx.threadClassification ?? null,
    lastMessageAt: ctx.prospect ? lastOutbound(ctx.prospect.id, 'message') : null,
    lastCommentAt: ctx.prospect ? lastOutbound(ctx.prospect.id, 'comment') : null,
    now,
  };
  const verdict = evaluate(action, ruleCtx);
  if (verdict.action !== 'allow') {
    if (verdict.escalationReason) {
      escalate({
        prospectId: ctx.prospect?.id ?? null,
        reason: verdict.escalationReason,
        detail: `${verdict.rule}: ${verdict.reason}`,
        draft: action.body,
        targetUrl: action.targetUrl,
      });
    }
    return { decision: 'block', reason: `rule ${verdict.rule}: ${verdict.reason}` };
  }

  // Replies to inbound skip pacing and caps. Leaving someone who wrote to you on
  // read is worse behaviour than answering, and it isn't what gets accounts flagged.
  const exemptFromLimits =
    Boolean(ctx.isReplyToInbound) && UNCAPPED_REPLY_TO_INBOUND && action.actionType === 'message';
  if (exemptFromLimits) {
    return { decision: 'allow', reason: 'reply to inbound — exempt from caps and pacing' };
  }

  // 5. Working hours and quiet days.
  const timing = canActNow(now);
  if (!timing.ok) {
    return { decision: 'defer', reason: timing.reason };
  }

  // 6. Caps, ramped.
  const caps = effectiveCaps(action.actionType, now);
  const usedToday = countActionsSince(action.actionType, startOfDay(now));
  if (usedToday >= caps.daily) {
    return {
      decision: 'defer',
      reason: `daily cap reached for ${action.actionType} (${usedToday}/${caps.daily})`,
    };
  }
  const usedThisWeek = countActionsSince(action.actionType, startOfWeek(now));
  if (usedThisWeek >= caps.weekly) {
    return {
      decision: 'defer',
      reason: `weekly cap reached for ${action.actionType} (${usedThisWeek}/${caps.weekly})`,
    };
  }

  // 7. Spread the day's budget across the day rather than spending it at 9am.
  const unlocked = budgetUnlockedByNow(caps.daily, now);
  if (usedToday >= unlocked) {
    return {
      decision: 'defer',
      reason: `pacing: ${usedToday}/${unlocked} of today's ${action.actionType} budget unlocked so far`,
    };
  }

  return { decision: 'allow', reason: `allowed (${usedToday + 1}/${caps.daily} today)` };
}

/** Record what actually happened after an allowed action executed. */
export function settle(
  auditId: number,
  outcome: 'success' | 'failed' | 'dry_run',
  error?: string,
): void {
  db()
    .prepare('UPDATE actions SET outcome = ?, error = ? WHERE id = ?')
    .run(outcome, error ?? null, auditId);
}

export function startOfDay(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return toSqliteUtc(d);
}

export function startOfWeek(now: Date): string {
  const d = new Date(now);
  const day = d.getDay();
  // Weeks run Monday-Sunday; Sunday is a quiet day anyway.
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return toSqliteUtc(d);
}

/** SQLite stores datetime('now') as UTC "YYYY-MM-DD HH:MM:SS" with no zone. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
