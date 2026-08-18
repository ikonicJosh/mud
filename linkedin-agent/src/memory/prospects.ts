/**
 * Prospect persistence and the state machine.
 *
 * The state machine is enforced here rather than in calling code so a prospect
 * can never skip a step — an agent that "connects" with someone it never sourced
 * is a bug that would be invisible without this guard.
 */

import { db } from './db.js';
import {
  PROSPECT_FLOW,
  PROSPECT_SIDE_STATES,
  type Prospect,
  type ProspectSource,
  type ProspectState,
} from '../types.js';

interface ProspectRow {
  id: number;
  public_id: string;
  profile_url: string;
  full_name: string;
  headline: string | null;
  company: string | null;
  company_domain: string | null;
  location: string | null;
  industry: string | null;
  fleet_size: number | null;
  employee_count: number | null;
  source: string;
  score: number | null;
  score_rationale: string | null;
  state: string;
  excluded_reason: string | null;
  ghl_contact_id: string | null;
  ghl_opportunity_id: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: ProspectRow): Prospect {
  return {
    id: row.id,
    publicId: row.public_id,
    profileUrl: row.profile_url,
    fullName: row.full_name,
    headline: row.headline,
    company: row.company,
    companyDomain: row.company_domain,
    location: row.location,
    industry: row.industry,
    fleetSize: row.fleet_size,
    employeeCount: row.employee_count,
    source: row.source as ProspectSource,
    score: row.score,
    scoreRationale: row.score_rationale,
    state: row.state as ProspectState,
    excludedReason: row.excluded_reason,
    ghlContactId: row.ghl_contact_id,
    ghlOpportunityId: row.ghl_opportunity_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewProspect {
  publicId: string;
  profileUrl: string;
  fullName: string;
  headline?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  location?: string | null;
  industry?: string | null;
  fleetSize?: number | null;
  employeeCount?: number | null;
  source: ProspectSource;
}

/**
 * Insert, or fill in blanks on an existing record. Never downgrades a known
 * value to null — a thin engagement-mining hit shouldn't wipe rich Clay data.
 */
export function upsertProspect(p: NewProspect): Prospect {
  const existing = findByPublicId(p.publicId);
  if (!existing) {
    db()
      .prepare(
        `INSERT INTO prospects
           (public_id, profile_url, full_name, headline, company, company_domain,
            location, industry, fleet_size, employee_count, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.publicId,
        p.profileUrl,
        p.fullName,
        p.headline ?? null,
        p.company ?? null,
        p.companyDomain ?? null,
        p.location ?? null,
        p.industry ?? null,
        p.fleetSize ?? null,
        p.employeeCount ?? null,
        p.source,
      );
    return findByPublicId(p.publicId)!;
  }

  db()
    .prepare(
      `UPDATE prospects SET
         profile_url    = COALESCE(?, profile_url),
         full_name      = COALESCE(?, full_name),
         headline       = COALESCE(?, headline),
         company        = COALESCE(?, company),
         company_domain = COALESCE(?, company_domain),
         location       = COALESCE(?, location),
         industry       = COALESCE(?, industry),
         fleet_size     = COALESCE(?, fleet_size),
         employee_count = COALESCE(?, employee_count),
         updated_at     = datetime('now')
       WHERE public_id = ?`,
    )
    .run(
      p.profileUrl || null,
      p.fullName || null,
      p.headline ?? null,
      p.company ?? null,
      p.companyDomain ?? null,
      p.location ?? null,
      p.industry ?? null,
      p.fleetSize ?? null,
      p.employeeCount ?? null,
      p.publicId,
    );
  return findByPublicId(p.publicId)!;
}

export function findByPublicId(publicId: string): Prospect | null {
  const row = db().prepare('SELECT * FROM prospects WHERE public_id = ?').get(publicId) as
    | ProspectRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function findById(id: number): Prospect | null {
  const row = db().prepare('SELECT * FROM prospects WHERE id = ?').get(id) as
    | ProspectRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function listByState(state: ProspectState, limit = 100): Prospect[] {
  const rows = db()
    .prepare('SELECT * FROM prospects WHERE state = ? ORDER BY score DESC NULLS LAST, id ASC LIMIT ?')
    .all(state, limit) as ProspectRow[];
  return rows.map(hydrate);
}

export function listHot(threshold: number, limit = 50): Prospect[] {
  const rows = db()
    .prepare(
      `SELECT * FROM prospects
       WHERE score >= ? AND state NOT IN ('excluded','handed_off')
       ORDER BY score DESC LIMIT ?`,
    )
    .all(threshold, limit) as ProspectRow[];
  return rows.map(hydrate);
}

export function setScore(id: number, score: number, rationale: string): void {
  db()
    .prepare(
      `UPDATE prospects SET score = ?, score_rationale = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(score, rationale, id);
}

/**
 * Move a prospect forward. Throws on a backwards or skipping transition so the
 * bug surfaces at the point of error rather than as strange behaviour later.
 * Side states (nurture, excluded) are reachable from anywhere.
 */
export function transition(id: number, next: ProspectState): void {
  const current = findById(id);
  if (!current) throw new Error(`transition: no prospect ${id}`);
  if (current.state === next) return;

  if (!PROSPECT_SIDE_STATES.includes(next)) {
    const from = PROSPECT_FLOW.indexOf(current.state);
    const to = PROSPECT_FLOW.indexOf(next);
    if (to === -1) throw new Error(`transition: unknown state ${next}`);
    // Coming back from a side state re-enters the flow wherever it makes sense.
    if (from !== -1 && to < from) {
      throw new Error(`transition: refusing to move ${current.publicId} backwards ${current.state} -> ${next}`);
    }
  }

  db()
    .prepare(`UPDATE prospects SET state = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next, id);
}

/** Permanently take someone out of scope — existing clients, opt-outs, bad fits. */
export function exclude(id: number, reason: string): void {
  db()
    .prepare(
      `UPDATE prospects SET state = 'excluded', excluded_reason = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(reason, id);
}

export function setGhlIds(id: number, contactId: string | null, opportunityId: string | null): void {
  db()
    .prepare(
      `UPDATE prospects SET ghl_contact_id = COALESCE(?, ghl_contact_id),
         ghl_opportunity_id = COALESCE(?, ghl_opportunity_id), updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(contactId, opportunityId, id);
}

export function countByState(): Record<string, number> {
  const rows = db()
    .prepare('SELECT state, COUNT(*) AS n FROM prospects GROUP BY state')
    .all() as Array<{ state: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}
