/**
 * The audit log and the escalation queue.
 *
 * Every attempted action is recorded here — allowed, deferred, and blocked alike —
 * with the model's draft attached. Nothing the agent does is invisible after the
 * fact, which is the point: if LinkedIn or Josh ever asks what this thing did,
 * the answer is a query, not a guess.
 */

import { db } from './db.js';
import type {
  ActionType,
  AuditRecord,
  DraftedAction,
  Escalation,
  EscalationReason,
  GovernorDecision,
  Interaction,
} from '../types.js';

export function recordAction(input: {
  action: DraftedAction;
  decision: GovernorDecision;
  outcome: AuditRecord['outcome'];
  error?: string | null;
}): number {
  const res = db()
    .prepare(
      `INSERT INTO actions
         (action_type, prospect_id, target_url, draft, decision, decision_reason, outcome, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.action.actionType,
      input.action.prospectId,
      input.action.targetUrl,
      input.action.body,
      input.decision.decision,
      input.decision.reason,
      input.outcome,
      input.error ?? null,
    );
  return Number(res.lastInsertRowid);
}

/** Successful writes count against caps; everything else does not. */
export function countActionsSince(type: ActionType, sinceIso: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM actions
       WHERE action_type = ? AND outcome = 'success' AND occurred_at >= ?`,
    )
    .get(type, sinceIso) as { n: number };
  return row.n;
}

export function recentActions(limit = 50): AuditRecord[] {
  const rows = db()
    .prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    actionType: r.action_type as ActionType,
    prospectId: (r.prospect_id as number | null) ?? null,
    targetUrl: (r.target_url as string | null) ?? null,
    draft: (r.draft as string | null) ?? null,
    decision: r.decision as GovernorDecision['decision'],
    decisionReason: (r.decision_reason as string | null) ?? null,
    outcome: r.outcome as AuditRecord['outcome'],
    error: (r.error as string | null) ?? null,
    occurredAt: r.occurred_at as string,
  }));
}

export function recordInteraction(input: {
  prospectId: number;
  direction: Interaction['direction'];
  actionType: Interaction['actionType'];
  targetUrl?: string | null;
  body?: string | null;
  occurredAt?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO interactions (prospect_id, direction, action_type, target_url, body, occurred_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      input.prospectId,
      input.direction,
      input.actionType,
      input.targetUrl ?? null,
      input.body ?? null,
      input.occurredAt ?? null,
    );
}

/**
 * Most recent outbound touch of a given type for one prospect, used by the
 * cooldown rules. Returns null when we've never touched them that way.
 */
export function lastOutbound(prospectId: number, actionType: ActionType): string | null {
  const row = db()
    .prepare(
      `SELECT occurred_at FROM interactions
       WHERE prospect_id = ? AND direction = 'outbound' AND action_type = ?
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .get(prospectId, actionType) as { occurred_at: string } | undefined;
  return row?.occurred_at ?? null;
}

export function escalate(input: {
  prospectId: number | null;
  reason: EscalationReason;
  detail: string;
  draft?: string | null;
  targetUrl?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO escalations (prospect_id, reason, detail, draft, target_url)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.prospectId,
      input.reason,
      input.detail,
      input.draft ?? null,
      input.targetUrl ?? null,
    );
}

export function openEscalations(limit = 100): Escalation[] {
  const rows = db()
    .prepare('SELECT * FROM escalations WHERE resolved = 0 ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    prospectId: (r.prospect_id as number | null) ?? null,
    reason: r.reason as EscalationReason,
    detail: r.detail as string,
    draft: (r.draft as string | null) ?? null,
    targetUrl: (r.target_url as string | null) ?? null,
    resolved: Boolean(r.resolved),
    createdAt: r.created_at as string,
  }));
}

export function resolveEscalation(id: number): void {
  db().prepare('UPDATE escalations SET resolved = 1 WHERE id = ?').run(id);
}
