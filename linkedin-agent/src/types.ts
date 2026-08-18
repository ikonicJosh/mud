/**
 * Shared domain types.
 *
 * Kept in one place because the governor, the brain, and the action modules all
 * need to agree on what an "action" is — that agreement is the whole safety model.
 */

/** Every write the agent can perform against LinkedIn. Read paths are not actions. */
export type ActionType =
  | 'like'
  | 'comment'
  | 'connect'
  | 'message'
  | 'profile_view'
  | 'search';

export const ACTION_TYPES: ActionType[] = [
  'like',
  'comment',
  'connect',
  'message',
  'profile_view',
  'search',
];

/** Action types that put content into the world under Josh's name. */
export const WRITE_ACTIONS: ActionType[] = ['like', 'comment', 'connect', 'message'];

/**
 * Where a prospect sits in the funnel. Transitions are enforced in
 * memory/prospects.ts — a prospect never skips forward.
 */
export type ProspectState =
  | 'sourced'
  | 'scored'
  | 'engaged'
  | 'connect_sent'
  | 'connected'
  | 'conversing'
  | 'hot'
  | 'handed_off'
  | 'nurture'
  | 'excluded';

export const PROSPECT_FLOW: ProspectState[] = [
  'sourced',
  'scored',
  'engaged',
  'connect_sent',
  'connected',
  'conversing',
  'hot',
  'handed_off',
];

/** Terminal-ish states that sit outside the linear flow. */
export const PROSPECT_SIDE_STATES: ProspectState[] = ['nurture', 'excluded'];

export interface Prospect {
  id: number;
  /** LinkedIn public identifier, e.g. "jane-smith-hvac". Unique. */
  publicId: string;
  profileUrl: string;
  fullName: string;
  headline: string | null;
  company: string | null;
  companyDomain: string | null;
  location: string | null;
  industry: string | null;
  /** Best-effort fleet size; a strong ICP signal for wraps. */
  fleetSize: number | null;
  employeeCount: number | null;
  source: ProspectSource;
  score: number | null;
  scoreRationale: string | null;
  state: ProspectState;
  /** Set when the prospect is a known GHL client or open deal — never engaged. */
  excludedReason: string | null;
  ghlContactId: string | null;
  ghlOpportunityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProspectSource = 'clay_import' | 'engagement_mining' | 'linkedin_search' | 'inbound';

/** A single touch, in either direction. */
export interface Interaction {
  id: number;
  prospectId: number;
  direction: 'outbound' | 'inbound';
  actionType: ActionType | 'reply_received' | 'connection_accepted';
  /** The post/thread/profile the interaction attached to. */
  targetUrl: string | null;
  body: string | null;
  occurredAt: string;
}

export interface Thread {
  id: number;
  prospectId: number;
  /** LinkedIn conversation URN. */
  conversationId: string;
  classification: ThreadClassification | null;
  classificationRationale: string | null;
  lastMessageAt: string | null;
  lastMessageFrom: 'them' | 'us' | null;
  awaitingReply: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ThreadClassification =
  | 'hot_lead'
  | 'networking'
  | 'recruiter'
  | 'spam'
  | 'negative'
  | 'client';

/** Full audit row. One per attempted action, written before the next action starts. */
export interface AuditRecord {
  id: number;
  actionType: ActionType;
  prospectId: number | null;
  targetUrl: string | null;
  /** What the model produced, verbatim, even when the action was blocked. */
  draft: string | null;
  decision: GovernorDecision['decision'];
  decisionReason: string | null;
  outcome: 'success' | 'failed' | 'blocked' | 'deferred' | 'dry_run';
  error: string | null;
  occurredAt: string;
}

export interface Escalation {
  id: number;
  prospectId: number | null;
  reason: EscalationReason;
  detail: string;
  /** The draft that would have gone out, so Josh can send it himself if he wants. */
  draft: string | null;
  targetUrl: string | null;
  resolved: boolean;
  createdAt: string;
}

export type EscalationReason =
  | 'meeting_request'
  | 'negative_thread'
  | 'pricing_request'
  | 'known_client'
  | 'breaker_tripped'
  | 'low_confidence_draft';

export interface GovernorDecision {
  decision: 'allow' | 'defer' | 'block';
  reason: string;
}

/** A drafted action awaiting governor approval. */
export interface DraftedAction {
  actionType: ActionType;
  prospectId: number | null;
  targetUrl: string | null;
  body: string | null;
  /** The concrete observation the draft is built on. Empty means reject. */
  hook: string | null;
}
