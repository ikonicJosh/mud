/**
 * The inbox: reading threads and sending replies.
 *
 * Reading is unconditional — the agent always knows what's in there, because the
 * daily brief is only useful if it's complete. Replying is the most restricted
 * action in the system: classified first, rule-checked second, and only sent when
 * both agree it's safe. Everything else is Josh's.
 */

import type { Page } from 'playwright';
import { goto, guard } from '../browser/session.js';
import { SELECTORS, anyOf, publicIdFromUrl } from '../browser/selectors.js';
import { request, settle } from '../governor/index.js';
import { noteFailure, noteSuccess } from '../governor/breaker.js';
import { recordInteraction } from '../memory/audit.js';
import { addMessages, markAnswered, upsertThread, type StoredMessage } from '../memory/threads.js';
import { upsertProspect } from '../memory/prospects.js';
import type { DraftedAction, Prospect, ThreadClassification } from '../types.js';

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

export interface InboxThread {
  conversationId: string;
  conversationUrl: string;
  participantName: string;
  participantPublicId: string | null;
  unread: boolean;
}

/** List conversations. Read-only. */
export async function listThreads(page: Page, limit = 25): Promise<InboxThread[]> {
  await goto(page, MESSAGING_URL);
  await page.waitForTimeout(2_500);

  const items = await page.locator(anyOf(SELECTORS.messaging.conversationItem)).all();
  const out: InboxThread[] = [];

  for (const item of items.slice(0, limit)) {
    const link = await item
      .locator(anyOf(SELECTORS.messaging.conversationLink))
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (!link) continue;

    const conversationId = threadIdFromHref(link);
    if (!conversationId) continue;

    const name = await item
      .locator(anyOf(SELECTORS.messaging.participantName))
      .first()
      .innerText()
      .catch(() => null);

    const unread = await item
      .locator(anyOf(SELECTORS.messaging.conversationUnread))
      .first()
      .count()
      .then((n) => n > 0)
      .catch(() => false);

    out.push({
      conversationId,
      conversationUrl: new URL(link, 'https://www.linkedin.com').toString(),
      participantName: name?.trim() ?? 'unknown',
      participantPublicId: null,
      unread,
    });
  }

  return out;
}

/** Read one thread's messages. Read-only. */
export async function readThread(page: Page, thread: InboxThread): Promise<StoredMessage[]> {
  await goto(page, thread.conversationUrl);
  await page.waitForTimeout(2_500);

  const bubbles = await page.locator(anyOf(SELECTORS.messaging.messageBubble)).all();
  const messages: StoredMessage[] = [];
  // LinkedIn only labels the sender on the first message of a run, so the last
  // seen name carries forward through the group.
  let currentSender: 'them' | 'us' = 'them';

  for (const bubble of bubbles) {
    const senderName = await bubble
      .locator(anyOf(SELECTORS.messaging.messageSender))
      .first()
      .innerText()
      .catch(() => null);
    if (senderName?.trim()) {
      currentSender = isUs(senderName.trim(), thread.participantName) ? 'us' : 'them';
    }

    const body = await bubble
      .locator(anyOf(SELECTORS.messaging.messageBody))
      .first()
      .innerText()
      .catch(() => null);
    if (!body?.trim()) continue;

    const ts = await bubble
      .locator(anyOf(SELECTORS.messaging.messageTimestamp))
      .first()
      .getAttribute('datetime')
      .catch(() => null);

    messages.push({
      sender: currentSender,
      body: body.replace(/\s+/g, ' ').trim(),
      sentAt: ts ?? new Date().toISOString(),
    });
  }

  return messages;
}

/**
 * Read a thread and persist it, creating a lightweight prospect for whoever is
 * on the other end so inbound conversations join the same pipeline as outbound.
 */
export async function captureThread(
  page: Page,
  thread: InboxThread,
): Promise<{ prospect: Prospect; messages: StoredMessage[] } | null> {
  const messages = await readThread(page, thread);
  if (messages.length === 0) return null;

  const publicId =
    thread.participantPublicId ??
    (await page
      .locator(anyOf(SELECTORS.messaging.messageSender))
      .first()
      .getAttribute('href')
      .then((h) => (h ? publicIdFromUrl(h) : null))
      .catch(() => null)) ??
    `thread:${thread.conversationId}`;

  const prospect = upsertProspect({
    publicId,
    profileUrl: publicId.startsWith('thread:')
      ? thread.conversationUrl
      : `https://www.linkedin.com/in/${publicId}/`,
    fullName: thread.participantName,
    source: 'inbound',
  });

  const stored = upsertThread(prospect.id, thread.conversationId);
  addMessages(stored.id, messages);

  const last = messages.at(-1);
  if (last?.sender === 'them') {
    recordInteraction({
      prospectId: prospect.id,
      direction: 'inbound',
      actionType: 'reply_received',
      targetUrl: thread.conversationUrl,
      body: last.body,
    });
  }

  return { prospect, messages };
}

export interface ReplyResult {
  performed: boolean;
  reason: string;
}

/** Send a reply into an open thread. */
export async function sendReply(
  page: Page,
  thread: InboxThread,
  prospect: Prospect,
  text: string,
  hook: string,
  classification: ThreadClassification | null,
  opts: { dryRun?: boolean; threadDbId?: number } = {},
): Promise<ReplyResult> {
  const action: DraftedAction = {
    actionType: 'message',
    prospectId: prospect.id,
    targetUrl: thread.conversationUrl,
    body: text,
    hook,
  };

  const decision = request(action, {
    prospect,
    threadClassification: classification,
    isReplyToInbound: true,
    dryRun: opts.dryRun,
  });
  if (decision.decision !== 'allow') return { performed: false, reason: decision.reason };
  if (opts.dryRun) {
    settle(decision.auditId, 'dry_run');
    return { performed: false, reason: 'dry run' };
  }

  try {
    await goto(page, thread.conversationUrl);
    await page.waitForTimeout(2_000);

    const box = page.locator(anyOf(SELECTORS.messaging.composeBox)).first();
    if (!(await box.count())) {
      noteFailure('compose box not found');
      settle(decision.auditId, 'failed', 'compose box not found');
      return { performed: false, reason: 'compose box not found' };
    }

    await box.click();
    await box.type(text, { delay: 25 });
    await page.waitForTimeout(800);

    const send = page.locator(anyOf(SELECTORS.messaging.sendButton)).first();
    if (!(await send.count()) || !(await send.isEnabled())) {
      noteFailure('send button unavailable');
      settle(decision.auditId, 'failed', 'send button unavailable');
      return { performed: false, reason: 'send button unavailable' };
    }
    await send.click();
    await page.waitForTimeout(2_000);
    await guard(page);

    noteSuccess();
    settle(decision.auditId, 'success');
    recordInteraction({
      prospectId: prospect.id,
      direction: 'outbound',
      actionType: 'message',
      targetUrl: thread.conversationUrl,
      body: text,
    });
    if (opts.threadDbId) markAnswered(opts.threadDbId);
    return { performed: true, reason: 'reply sent' };
  } catch (err) {
    const message = (err as Error).message;
    noteFailure(`reply failed: ${message}`);
    settle(decision.auditId, 'failed', message);
    return { performed: false, reason: message };
  }
}

function threadIdFromHref(href: string): string | null {
  const m = /\/messaging\/thread\/([^/?#]+)/.exec(href);
  return m?.[1] ?? null;
}

/**
 * LinkedIn renders our own messages with Josh's name. Anything that isn't the
 * other participant's name is treated as ours — the safe direction to err, since
 * mislabelling their message as ours means we don't reply, rather than replying
 * to ourselves.
 */
function isUs(senderName: string, participantName: string): boolean {
  return senderName.toLowerCase() !== participantName.toLowerCase();
}
