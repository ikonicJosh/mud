/**
 * The hard never-dos.
 *
 * These are Josh's explicit guardrails, enforced as code rather than as prompt
 * instructions. A prompt can be talked out of a rule by a persuasive message; a
 * regex over the finished draft cannot. Both layers run — the classifier labels
 * the thread, and these rules inspect the actual text about to be sent — because
 * each catches things the other misses.
 *
 * Every rule returns `escalate` or `block`, never a silent drop. If the agent
 * won't handle something, Josh finds out about it in the daily brief.
 */

import { CONFIG } from '../config/config.js';
import type {
  DraftedAction,
  EscalationReason,
  Prospect,
  ThreadClassification,
} from '../types.js';

export interface RuleContext {
  prospect: Prospect | null;
  threadClassification: ThreadClassification | null;
  /** ISO timestamp of our last message to this person, if any. */
  lastMessageAt: string | null;
  /** ISO timestamp of our last comment on this person's posts, if any. */
  lastCommentAt: string | null;
  now: Date;
}

export interface RuleVerdict {
  action: 'allow' | 'escalate' | 'block';
  rule: string;
  reason: string;
  escalationReason?: EscalationReason;
}

const ALLOW: RuleVerdict = { action: 'allow', rule: 'none', reason: 'no rule triggered' };

const DAY_MS = 86_400_000;

/**
 * Language that commits to a meeting. The agent may express interest and float
 * that Josh has availability; it may not agree to a slot. Josh's calendar is his.
 */
const MEETING_COMMITMENT = [
  /\b(?:that|this)\s+(?:works|time works|day works|slot works)\b/i,
  /\b(?:works for me|sounds good, see you|see you (?:then|on|at)|i'?ll see you)\b/i,
  /\b(?:i'?ve )?(?:booked|scheduled|confirmed|locked (?:it )?in|put (?:it|you) (?:on|in))\b/i,
  /\b(?:let'?s do|how about)\s+(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /\b(?:i'?m|i am)\s+(?:free|available)\s+(?:at|on)\s+\d/i,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b.*\b(?:works|good|perfect|confirmed)\b/i,
  /\b(?:calendar invite|invite sent|sending (?:an|the) invite)\b/i,
];

/**
 * Anything that reads as a quote, a discount, or a scope commitment.
 *
 * Josh did not select "never quote prices" as a guardrail, but his own
 * brand-voice rules require his confirmation on specific pricing. The split:
 * published ranges may be mentioned conversationally, specific numbers may not.
 */
const PRICING_COMMITMENT = [
  /\b(?:i can do|we can do|i'?ll do|we'?ll do|do it for|for you at)\s*\$?\d/i,
  /\b(?:discount|knock off|take off|come down to|special price|deal for you)\b/i,
  /\b(?:quote|price) (?:is|would be|comes to|works out to)\b/i,
  /\b(?:includes|covers|guarantee[sd]?)\b.*\b(?:install|design|removal|warranty)\b.*\$/i,
  /\bno charge\b|\bfree (?:wrap|install|design)\b/i,
];

/** Thread classifications the agent never replies to on its own. */
const HANDS_OFF_CLASSIFICATIONS: ThreadClassification[] = ['negative', 'client'];

/** Words that mark a thread as a complaint or legal matter regardless of label. */
const NEGATIVE_SIGNALS = [
  /\b(?:lawyer|attorney|legal action|sue|lawsuit|court|subpoena|cease and desist)\b/i,
  /\b(?:refund|chargeback|dispute|complaint|scam|fraud|ripped me off)\b/i,
  /\b(?:unacceptable|furious|disgusted|worst|never again)\b/i,
  /\b(?:stop (?:messaging|contacting)|leave me alone|remove me|unsubscribe|not interested)\b/i,
];

/**
 * Evaluate one drafted action against every rule. First non-allow verdict wins,
 * and the order matters: exclusions before content checks, because we shouldn't
 * even be reading a client's thread closely enough to critique the draft.
 */
export function evaluate(action: DraftedAction, ctx: RuleContext): RuleVerdict {
  const text = action.body ?? '';

  // 1. Known clients and open deals are Josh's relationships. Permanent skip.
  if (ctx.prospect?.state === 'excluded') {
    return {
      action: 'block',
      rule: 'excluded_prospect',
      reason: ctx.prospect.excludedReason ?? 'prospect is excluded from outreach',
    };
  }
  if (ctx.threadClassification === 'client') {
    return {
      action: 'block',
      rule: 'known_client',
      reason: 'thread is with an existing client — Josh handles these personally',
      escalationReason: 'known_client',
    };
  }

  // 2. Negative, complaint, dispute, or legal threads: never answered by the agent.
  if (ctx.threadClassification && HANDS_OFF_CLASSIFICATIONS.includes(ctx.threadClassification)) {
    return {
      action: 'escalate',
      rule: 'negative_thread',
      reason: `thread classified ${ctx.threadClassification} — routed to Josh unanswered`,
      escalationReason: 'negative_thread',
    };
  }
  const negativeHit = firstMatch(NEGATIVE_SIGNALS, text);
  if (negativeHit) {
    return {
      action: 'escalate',
      rule: 'negative_language',
      reason: `draft or context contains complaint/legal language (${negativeHit})`,
      escalationReason: 'negative_thread',
    };
  }

  // 3. Meetings: the agent never confirms a time.
  const meetingHit = firstMatch(MEETING_COMMITMENT, text);
  if (meetingHit) {
    return {
      action: 'escalate',
      rule: 'meeting_commitment',
      reason: `draft commits to a meeting time (${meetingHit}) — Josh confirms his own calendar`,
      escalationReason: 'meeting_request',
    };
  }

  // 4. Pricing: ranges yes, specific quotes and commitments no.
  const pricingVerdict = checkPricing(text);
  if (pricingVerdict) return pricingVerdict;

  // 5 & 6. Cooldowns.
  if (action.actionType === 'message' && ctx.lastMessageAt) {
    const days = daysSince(ctx.lastMessageAt, ctx.now);
    if (days < CONFIG.cooldowns.messageSamePersonDays) {
      return {
        action: 'block',
        rule: 'message_cooldown',
        reason: `messaged ${days.toFixed(1)}d ago, cooldown is ${CONFIG.cooldowns.messageSamePersonDays}d`,
      };
    }
  }
  if (action.actionType === 'comment' && ctx.lastCommentAt) {
    const days = daysSince(ctx.lastCommentAt, ctx.now);
    if (days < CONFIG.cooldowns.commentSamePersonDays) {
      return {
        action: 'block',
        rule: 'comment_cooldown',
        reason: `commented ${days.toFixed(1)}d ago, cooldown is ${CONFIG.cooldowns.commentSamePersonDays}d`,
      };
    }
  }

  // 7. A draft with no concrete hook is generic, and generic is spam.
  if (needsHook(action.actionType) && !action.hook?.trim()) {
    return {
      action: 'block',
      rule: 'no_hook',
      reason: 'draft has no specific observation behind it — would read as a template',
    };
  }

  return ALLOW;
}

function needsHook(type: DraftedAction['actionType']): boolean {
  return type === 'comment' || type === 'connect' || type === 'message';
}

/**
 * Pricing check. Published ranges are allowed to appear; any other dollar figure,
 * or any commitment phrasing, escalates.
 */
function checkPricing(text: string): RuleVerdict | null {
  const commitmentHit = firstMatch(PRICING_COMMITMENT, text);
  if (commitmentHit) {
    return {
      action: 'escalate',
      rule: 'pricing_commitment',
      reason: `draft commits to price or scope (${commitmentHit}) — Josh confirms all quotes`,
      escalationReason: 'pricing_request',
    };
  }

  const amounts = extractDollarAmounts(text);
  if (amounts.length === 0) return null;

  if (!CONFIG.pricing.allowRangeMentions) {
    return {
      action: 'escalate',
      rule: 'pricing_mention',
      reason: 'draft mentions a dollar figure and range mentions are disabled',
      escalationReason: 'pricing_request',
    };
  }

  const allowed = allowedAmounts();
  const stray = amounts.find((a) => !allowed.has(a));
  if (stray !== undefined) {
    return {
      action: 'escalate',
      rule: 'unpublished_price',
      reason: `draft names $${stray}, which is not one of Ikonic's published figures`,
      escalationReason: 'pricing_request',
    };
  }
  return null;
}

/** Normalised dollar figures from the published ranges in config. */
function allowedAmounts(): Set<number> {
  const raw = `${CONFIG.pricing.wrapRange} ${CONFIG.pricing.retainerTiers}`;
  return new Set(extractDollarAmounts(raw));
}

/**
 * Pull dollar figures out of text, normalising "$3K" to 3000 so the published
 * range matches whichever way the model chose to write it.
 */
export function extractDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const base = Number(m[1]!.replace(/,/g, ''));
    if (Number.isNaN(base)) continue;
    out.push(m[2] ? base * 1000 : base);
  }
  return out;
}

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

function daysSince(iso: string, now: Date): number {
  // SQLite datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const normalised = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  return (now.getTime() - new Date(normalised).getTime()) / DAY_MS;
}
