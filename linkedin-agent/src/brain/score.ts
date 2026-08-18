/**
 * Prospect scoring, 0-100.
 *
 * Adapted from the ghl-hot-leads-outreach model to LinkedIn signals. The four
 * components and the >= 20 cutoff carry over directly from Josh's existing
 * scoring so a LinkedIn lead and a GHL lead mean the same thing when they sit
 * next to each other in the pipeline.
 *
 * Deterministic parts (industry match, fleet size, title) are computed in code.
 * Only the genuinely judgement-shaped part — reading a headline and a few posts
 * to gauge whether this person is a real decision maker who's active — goes to
 * the model, and it goes at low effort because it's high volume and low stakes.
 */

import { CONFIG } from '../config/config.js';
import {
  ADJACENT_INDUSTRIES,
  CORE_INDUSTRIES,
  EXCLUDE_TITLES,
  FIRMOGRAPHICS,
  TARGET_TITLES,
} from '../config/icp.js';
import type { Prospect } from '../types.js';
import { askJson } from './client.js';

export interface ScoreBreakdown {
  icpFit: number; // max 30
  engagementSignal: number; // max 25
  relationshipStage: number; // max 25
  recency: number; // max 20
  total: number;
  rationale: string;
}

export interface ScoringSignals {
  /** Recent post activity from their profile, newest first. */
  recentPosts?: string[];
  /** Have they interacted with us at all? */
  hasReplied?: boolean;
  hasViewedProfile?: boolean;
  lastActivityAt?: string | null;
}

/** ICP fit, 0-30. Pure function of firmographics — no model call. */
export function scoreIcpFit(p: Prospect): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;
  const haystack = `${p.industry ?? ''} ${p.headline ?? ''} ${p.company ?? ''}`.toLowerCase();

  const core = CORE_INDUSTRIES.find((i) => haystack.includes(i.toLowerCase()));
  const adjacent = ADJACENT_INDUSTRIES.find((i) => haystack.includes(i.toLowerCase()));
  if (core) {
    score += 15;
    notes.push(`core industry (${core})`);
  } else if (adjacent) {
    score += 8;
    notes.push(`adjacent industry (${adjacent})`);
  } else {
    notes.push('industry not matched to ICP');
  }

  // Fleet presence is the single strongest signal for a wrap sale.
  if (p.fleetSize != null) {
    const { ideal, min, max } = FIRMOGRAPHICS.fleetSize;
    if (p.fleetSize >= ideal.min && p.fleetSize <= ideal.max) {
      score += 10;
      notes.push(`fleet of ${p.fleetSize} is in the sweet spot`);
    } else if (p.fleetSize >= min && p.fleetSize <= max) {
      score += 6;
      notes.push(`fleet of ${p.fleetSize} is in range`);
    } else {
      notes.push(`fleet of ${p.fleetSize} is outside target range`);
    }
  }

  const title = (p.headline ?? '').toLowerCase();
  if (EXCLUDE_TITLES.some((t) => title.includes(t))) {
    notes.push('title suggests an employee, not a decision maker');
  } else if (TARGET_TITLES.some((t) => title.includes(t))) {
    score += 5;
    notes.push('decision-maker title');
  }

  if (p.employeeCount != null) {
    const { min, max } = FIRMOGRAPHICS.employeeCount;
    if (p.employeeCount >= min && p.employeeCount <= max) {
      notes.push(`headcount ${p.employeeCount} fits`);
    } else {
      score = Math.max(0, score - 3);
      notes.push(`headcount ${p.employeeCount} is outside target`);
    }
  }

  return { score: Math.min(30, score), notes };
}

/** Relationship stage, 0-25. Derived from where they sit in the funnel. */
export function scoreRelationshipStage(p: Prospect): number {
  switch (p.state) {
    case 'conversing':
    case 'hot':
      return 25;
    case 'connected':
      return 18;
    case 'connect_sent':
      return 12;
    case 'engaged':
      return 8;
    case 'scored':
    case 'sourced':
      return 3;
    default:
      return 0;
  }
}

/** Recency, 0-20. How fresh is the last signal from them. */
export function scoreRecency(lastActivityAt: string | null | undefined, now = new Date()): number {
  if (!lastActivityAt) return 0;
  const normalised = lastActivityAt.includes('T')
    ? lastActivityAt
    : `${lastActivityAt.replace(' ', 'T')}Z`;
  const days = (now.getTime() - new Date(normalised).getTime()) / 86_400_000;
  if (Number.isNaN(days)) return 0;
  if (days <= 7) return 20;
  if (days <= 21) return 15;
  if (days <= 45) return 10;
  if (days <= 90) return 5;
  return 0;
}

const ENGAGEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['engagementSignal', 'rationale'],
  properties: {
    engagementSignal: {
      type: 'integer',
      minimum: 0,
      maximum: 25,
      description:
        'How active and reachable this person looks on LinkedIn, and how likely they are to be the person who decides on marketing spend.',
    },
    rationale: { type: 'string', maxLength: 400 },
  },
} as const;

/** Engagement signal, 0-25. The judgement-shaped part. */
export async function scoreEngagement(
  p: Prospect,
  signals: ScoringSignals,
): Promise<{ score: number; rationale: string }> {
  // Direct interaction beats anything the model could infer.
  if (signals.hasReplied) return { score: 25, rationale: 'has replied to us directly' };

  const posts = (signals.recentPosts ?? []).slice(0, 5);
  if (posts.length === 0 && !signals.hasViewedProfile) {
    return { score: 0, rationale: 'no visible activity or interaction' };
  }

  const result = await askJson<{ engagementSignal: number; rationale: string }>({
    system:
      'You score B2B prospects for a commercial vehicle wrap and marketing company that sells to owners of local service businesses. Answer only with the requested JSON.',
    user: `Rate this LinkedIn prospect's engagement signal from 0 to 25.

Name: ${p.fullName}
Headline: ${p.headline ?? 'unknown'}
Company: ${p.company ?? 'unknown'}
Viewed our profile: ${signals.hasViewedProfile ? 'yes' : 'no'}

Recent posts:
${posts.length ? posts.map((t, i) => `${i + 1}. ${t.slice(0, 500)}`).join('\n') : '(none found)'}

Score higher when the person posts regularly in their own voice, clearly runs the business, and
talks about operations, hiring, trucks, or growth. Score lower when the account is dormant, the
posts are all reshared corporate content, or the person appears to be an employee rather than an
owner.`,
    effort: CONFIG.model.scoreEffort,
    schema: ENGAGEMENT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1_000,
  });

  return {
    score: clamp(result.engagementSignal, 0, 25),
    rationale: result.rationale,
  };
}

/** Full score for one prospect. */
export async function scoreProspect(
  p: Prospect,
  signals: ScoringSignals = {},
  now = new Date(),
): Promise<ScoreBreakdown> {
  const icp = scoreIcpFit(p);
  const stage = scoreRelationshipStage(p);
  const recency = scoreRecency(signals.lastActivityAt, now);
  const engagement = await scoreEngagement(p, signals);

  const total = clamp(icp.score + engagement.score + stage + recency, 0, 100);

  return {
    icpFit: icp.score,
    engagementSignal: engagement.score,
    relationshipStage: stage,
    recency,
    total,
    rationale: [
      `ICP ${icp.score}/30 (${icp.notes.join('; ')})`,
      `engagement ${engagement.score}/25 (${engagement.rationale})`,
      `stage ${stage}/25 (${p.state})`,
      `recency ${recency}/20`,
    ].join(' · '),
  };
}

/** Below the threshold, a prospect goes to nurture and gets no active outreach. */
export function qualifiesForOutreach(total: number): boolean {
  return total >= CONFIG.scoring.activeOutreachThreshold;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
