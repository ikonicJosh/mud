/**
 * Drafting: comments, connection notes, and replies.
 *
 * Every draft must name the concrete observation it was built on. That `hook`
 * isn't decoration — governor/rules.ts blocks any draft that comes back without
 * one, so "write something specific" is a constraint the system enforces rather
 * than a hope the prompt expresses. Generic outreach is the thing that makes
 * this channel worthless, so it's cheaper to send nothing.
 *
 * Drafts are also linted against the mechanical voice rules and retried once.
 * If the second attempt still trips a blocking finding, the draft is abandoned
 * and Josh sees it in the brief rather than the prospect seeing it in their inbox.
 */

import { CONFIG } from '../config/config.js';
import type { Prospect } from '../types.js';
import { askJson } from './client.js';
import { draftingSystemPrompt, isBlockingFinding, lintVoice, type LintFinding } from './voice.js';
import type { StoredMessage } from '../memory/threads.js';

export interface Draft {
  text: string;
  /** The specific thing this draft is built on. Empty means don't send. */
  hook: string;
  /** Model's own read on whether it had enough to say something useful. */
  confident: boolean;
  lint: LintFinding[];
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'hook', 'confident'],
  properties: {
    text: { type: 'string', maxLength: 2000 },
    hook: {
      type: 'string',
      maxLength: 300,
      description:
        'The specific, concrete detail this draft is built on. Empty string if there was nothing specific to work with.',
    },
    confident: {
      type: 'boolean',
      description: 'False if you had to reach, guess, or write something that could apply to anyone.',
    },
  },
} as const;

const MAX_ATTEMPTS = 2;

/** A comment on someone's post. One to three sentences, adds something real. */
export async function draftComment(input: {
  prospect: Prospect;
  postBody: string;
  postAuthor: string;
}): Promise<Draft> {
  return generate(
    `Write a comment on this LinkedIn post.

Author: ${input.postAuthor}${input.prospect.headline ? ` — ${input.prospect.headline}` : ''}
${input.prospect.company ? `Company: ${input.prospect.company}` : ''}

Post:
"""
${input.postBody.slice(0, 3000)}
"""

Add something genuinely useful — a practical observation from running a shop, a specific question
worth asking, or a detail they'd find interesting. One to three sentences.

Do not pitch. Do not mention Ikonic's services. Do not compliment the post. If you have nothing
substantive to add, set confident to false and leave the hook empty.`,
  );
}

/** A connection request note. Under 300 characters — LinkedIn's hard limit. */
export async function draftConnectionNote(input: {
  prospect: Prospect;
  recentPosts?: string[];
  sharedContext?: string;
}): Promise<Draft> {
  const posts = (input.recentPosts ?? []).slice(0, 3);
  return generate(
    `Write a LinkedIn connection request note to this person.

Name: ${input.prospect.fullName}
Headline: ${input.prospect.headline ?? 'unknown'}
Company: ${input.prospect.company ?? 'unknown'}
Location: ${input.prospect.location ?? 'unknown'}
${input.sharedContext ? `Shared context: ${input.sharedContext}` : ''}

${posts.length ? `Their recent posts:\n${posts.map((p, i) => `${i + 1}. ${p.slice(0, 400)}`).join('\n')}` : 'No recent posts found.'}

Hard limit: 300 characters including spaces. Reference something specific about them or their
business. Do not pitch anything — this is an introduction, not a sale. Do not ask for a meeting.

If you have nothing specific to reference, set confident to false and leave the hook empty.`,
    { maxChars: 300 },
  );
}

/** A reply in an ongoing DM thread. */
export async function draftReply(input: {
  prospect: Prospect;
  messages: StoredMessage[];
  /** What the classifier made of the thread, so the reply matches the situation. */
  threadContext: string;
}): Promise<Draft> {
  const transcript = input.messages
    .slice(-15)
    .map((m) => `${m.sender === 'them' ? input.prospect.fullName : 'Josh'}: ${m.body}`)
    .join('\n');

  return generate(
    `Write Josh's next reply in this LinkedIn conversation.

Them: ${input.prospect.fullName}${input.prospect.headline ? ` — ${input.prospect.headline}` : ''}
${input.prospect.company ? `Company: ${input.prospect.company}` : ''}
Thread read: ${input.threadContext}

Conversation so far:
"""
${transcript}
"""

Answer what they actually asked. Move the conversation forward by being useful, not by pushing.

If it's the right moment to suggest talking, say Josh would be glad to and ask what their week
looks like — never propose or confirm a specific time. Never state a specific price; if they ask
what something costs, you may mention that wraps generally land in the ${CONFIG.pricing.wrapRange} range
and offer to get them a real number, nothing more precise.

The hook is the specific thing in their message you're responding to.`,
  );
}

/**
 * Shared generation path: draft, lint, retry once with the findings fed back.
 */
async function generate(userPrompt: string, opts: { maxChars?: number } = {}): Promise<Draft> {
  let lastDraft: Draft | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryNote =
      attempt === 1 || !lastDraft
        ? ''
        : `\n\nYour previous attempt broke Ikonic's style rules:\n${lastDraft.lint
            .map((f) => `- ${f.detail}`)
            .join('\n')}\n\nPrevious attempt was:\n"""\n${lastDraft.text}\n"""\n\nRewrite it. Keep what worked, fix the flagged issues.`;

    const result = await askJson<{ text: string; hook: string; confident: boolean }>({
      system: draftingSystemPrompt(),
      user: userPrompt + retryNote,
      effort: CONFIG.model.draftEffort,
      schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2_000,
    });

    const text = result.text.trim();
    const lint = lintVoice(text);
    const draft: Draft = {
      text,
      hook: result.hook.trim(),
      confident: Boolean(result.confident) && result.hook.trim().length > 0,
      lint,
    };

    if (opts.maxChars && text.length > opts.maxChars) {
      draft.lint = [
        ...lint,
        { rule: 'too_long', detail: `${text.length} chars, limit is ${opts.maxChars}` },
      ];
      lastDraft = draft;
      continue;
    }

    if (!lint.some(isBlockingFinding)) return draft;
    lastDraft = draft;
  }

  // Both attempts tripped a blocking rule. Return it anyway with the findings
  // attached — the caller checks `usable()` and routes it to Josh, so the work
  // isn't lost, it's just not sent automatically.
  return lastDraft!;
}

/** Whether a draft is safe to send without Josh looking at it first. */
export function usable(draft: Draft, opts: { maxChars?: number } = {}): { ok: boolean; reason: string } {
  if (!draft.confident) {
    return { ok: false, reason: 'model was not confident it had anything specific to say' };
  }
  if (!draft.hook) return { ok: false, reason: 'no concrete hook — would read as a template' };
  if (!draft.text.trim()) return { ok: false, reason: 'empty draft' };
  if (opts.maxChars && draft.text.length > opts.maxChars) {
    return { ok: false, reason: `draft is ${draft.text.length} chars, limit ${opts.maxChars}` };
  }
  const blocking = draft.lint.filter(isBlockingFinding);
  if (blocking.length) {
    return { ok: false, reason: `voice violations: ${blocking.map((f) => f.detail).join('; ')}` };
  }
  return { ok: true, reason: 'clean' };
}
