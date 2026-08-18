/**
 * Inbox triage.
 *
 * The `negative` and `client` labels feed straight into governor/rules.ts, which
 * is why this runs before any reply is drafted: classification is cheap, and
 * drafting a warm reply to an angry message is exactly the failure this build
 * is meant to make impossible.
 */

import type { ThreadClassification } from '../types.js';
import { askJson } from './client.js';
import type { StoredMessage } from '../memory/threads.js';

export interface Classification {
  label: ThreadClassification;
  rationale: string;
  /** 0-1. Low confidence routes to Josh rather than to a reply. */
  confidence: number;
  /** True when they asked something that needs Josh personally. */
  needsJosh: boolean;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'rationale', 'confidence', 'needsJosh'],
  properties: {
    label: {
      type: 'string',
      enum: ['hot_lead', 'networking', 'recruiter', 'spam', 'negative', 'client'],
    },
    rationale: { type: 'string', maxLength: 400 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsJosh: { type: 'boolean' },
  },
} as const;

const SYSTEM = `You triage the LinkedIn inbox of Josh, who owns Ikonic — a company selling marketing
services and commercial vehicle wraps to local service businesses (HVAC, plumbing, electrical,
landscaping, roofing, pest control, cleaning).

Classify each conversation into exactly one label:

- hot_lead: someone who might buy. They've asked about wraps, marketing, pricing, timelines, or
  described a need Ikonic solves.
- networking: a genuine peer conversation with no near-term buying intent.
- recruiter: someone recruiting Josh or pitching staffing services.
- spam: bulk outreach, crypto, SEO spam, obvious templates, anything selling to Josh.
- negative: any complaint, dispute, refund request, legal matter, angry tone, or a request to stop
  being contacted. When in doubt between negative and anything else, choose negative.
- client: an existing Ikonic customer or someone with an active deal in progress.

Set needsJosh to true whenever the conversation involves pricing specifics, scheduling, a
commitment, a complaint, or anything where being wrong would cost Josh money or a relationship.

Be conservative. A false 'negative' costs a few minutes of Josh's time. A false 'hot_lead' on an
angry message costs him the relationship.`;

export async function classifyThread(
  messages: StoredMessage[],
  context: { name: string; headline?: string | null; company?: string | null },
): Promise<Classification> {
  const transcript = messages
    .slice(-20)
    .map((m) => `${m.sender === 'them' ? context.name : 'Josh'}: ${m.body}`)
    .join('\n');

  const result = await askJson<Classification>({
    system: SYSTEM,
    user: `Conversation with ${context.name}${context.headline ? ` (${context.headline})` : ''}${
      context.company ? ` at ${context.company}` : ''
    }:

${transcript}

Classify it.`,
    effort: 'medium',
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1_000,
  });

  return {
    label: result.label,
    rationale: result.rationale,
    confidence: Math.max(0, Math.min(1, result.confidence)),
    needsJosh: Boolean(result.needsJosh),
  };
}

/**
 * Whether the agent should answer this thread itself.
 *
 * The bar is deliberately high: the agent replies to clearly-safe categories at
 * clear confidence, and everything else goes to Josh. An unanswered message he
 * sees in the morning brief is recoverable; a wrong answer sent at 2am is not.
 */
export function agentMayReply(c: Classification): { ok: boolean; reason: string } {
  if (c.needsJosh) return { ok: false, reason: 'classifier flagged this as needing Josh' };
  if (c.confidence < 0.7) {
    return { ok: false, reason: `classification confidence ${c.confidence.toFixed(2)} below 0.7` };
  }
  if (c.label === 'negative') return { ok: false, reason: 'negative thread — never auto-answered' };
  if (c.label === 'client') return { ok: false, reason: 'existing client — Josh handles personally' };
  if (c.label === 'spam') return { ok: false, reason: 'spam — no reply' };
  if (c.label === 'recruiter') return { ok: false, reason: 'recruiter — no reply' };
  return { ok: true, reason: `${c.label} at confidence ${c.confidence.toFixed(2)}` };
}
