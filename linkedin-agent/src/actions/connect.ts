/**
 * Connection requests.
 *
 * A connection request with a note is the highest-leverage single action in this
 * system and also the one LinkedIn counts most carefully — hence the hardest cap
 * and the note requirement. A request with no note is a request that gets ignored,
 * so a draft without a hook doesn't get sent at all.
 */

import type { Page } from 'playwright';
import { goto, guard } from '../browser/session.js';
import { SELECTORS, anyOf } from '../browser/selectors.js';
import { profileUrlFor } from './profile.js';
import { request, settle } from '../governor/index.js';
import { noteFailure, noteSuccess } from '../governor/breaker.js';
import { recordInteraction } from '../memory/audit.js';
import { transition } from '../memory/prospects.js';
import type { DraftedAction, Prospect } from '../types.js';

/** LinkedIn's hard limit on invitation notes. */
export const NOTE_MAX_CHARS = 300;

export interface ConnectResult {
  performed: boolean;
  reason: string;
}

export async function sendConnectionRequest(
  page: Page,
  prospect: Prospect,
  note: string,
  hook: string,
  opts: { dryRun?: boolean } = {},
): Promise<ConnectResult> {
  if (note.length > NOTE_MAX_CHARS) {
    return { performed: false, reason: `note is ${note.length} chars, limit ${NOTE_MAX_CHARS}` };
  }

  const action: DraftedAction = {
    actionType: 'connect',
    prospectId: prospect.id,
    targetUrl: prospect.profileUrl || profileUrlFor(prospect.publicId),
    body: note,
    hook,
  };

  const decision = request(action, { prospect, dryRun: opts.dryRun });
  if (decision.decision !== 'allow') return { performed: false, reason: decision.reason };
  if (opts.dryRun) {
    settle(decision.auditId, 'dry_run');
    return { performed: false, reason: 'dry run' };
  }

  try {
    await goto(page, action.targetUrl!);

    const connectButton = await findConnectButton(page);
    if (!connectButton) {
      // Usually means already connected or already invited — not a failure worth
      // tripping the breaker over, so it's recorded and skipped.
      settle(decision.auditId, 'failed', 'connect button not available');
      return { performed: false, reason: 'connect button not available (already connected or pending?)' };
    }

    await connectButton.click();
    await page.waitForTimeout(1_500);

    const addNote = page.locator(anyOf(SELECTORS.profile.addNoteButton)).first();
    if (await addNote.count()) {
      await addNote.click();
      await page.waitForTimeout(800);
      const textarea = page.locator(anyOf(SELECTORS.profile.noteTextarea)).first();
      if (await textarea.count()) {
        await textarea.fill(note);
        await page.waitForTimeout(500);
      }
    }

    const send = page.locator(anyOf(SELECTORS.profile.sendInviteButton)).first();
    if (!(await send.count())) {
      noteFailure('send invitation button not found');
      settle(decision.auditId, 'failed', 'send invitation button not found');
      return { performed: false, reason: 'send invitation button not found' };
    }
    await send.click();
    await page.waitForTimeout(2_000);
    await guard(page);

    noteSuccess();
    settle(decision.auditId, 'success');
    recordInteraction({
      prospectId: prospect.id,
      direction: 'outbound',
      actionType: 'connect',
      targetUrl: action.targetUrl,
      body: note,
    });
    transition(prospect.id, 'connect_sent');
    return { performed: true, reason: 'invitation sent' };
  } catch (err) {
    const message = (err as Error).message;
    noteFailure(`connect failed: ${message}`);
    settle(decision.auditId, 'failed', message);
    return { performed: false, reason: message };
  }
}

/**
 * The Connect button hides under "More" on some profile layouts, so check the
 * primary position first and fall back to the overflow menu.
 */
async function findConnectButton(page: Page) {
  const direct = page.locator(anyOf(SELECTORS.profile.connectButton)).first();
  if (await direct.count()) return direct;

  const more = page.locator(anyOf(SELECTORS.profile.moreButton)).first();
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(800);
    const inMenu = page.locator('div[role="menu"] span:text-is("Connect")').first();
    if (await inMenu.count()) return inMenu;
  }
  return null;
}

/**
 * Detect accepted invitations by checking whether the Message button is now
 * available where Connect used to be. Cheap, and it's how the funnel advances
 * from connect_sent to connected without a separate notifications scrape.
 */
export async function checkConnectionAccepted(page: Page, prospect: Prospect): Promise<boolean> {
  await goto(page, prospect.profileUrl || profileUrlFor(prospect.publicId));
  const connect = page.locator(anyOf(SELECTORS.profile.connectButton)).first();
  const message = page.locator(anyOf(SELECTORS.profile.messageButton)).first();
  const hasConnect = (await connect.count()) > 0;
  const hasMessage = (await message.count()) > 0;

  if (hasMessage && !hasConnect) {
    transition(prospect.id, 'connected');
    recordInteraction({
      prospectId: prospect.id,
      direction: 'inbound',
      actionType: 'connection_accepted',
      targetUrl: prospect.profileUrl,
    });
    return true;
  }
  return false;
}
