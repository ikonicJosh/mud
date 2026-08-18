/**
 * Reading the feed, and the two engagement writes: like and comment.
 *
 * Both writes ask the governor first and execute only on `allow`. The read path
 * (`harvestFeed`) is separate and unguarded — collecting posts to think about is
 * not an action against anyone's account.
 */

import type { Page } from 'playwright';
import { goto, scrollFeed, guard } from '../browser/session.js';
import { SELECTORS, anyOf, publicIdFromUrl } from '../browser/selectors.js';
import { recordPost, markEngaged, hasEngaged } from '../memory/posts.js';
import { recordInteraction } from '../memory/audit.js';
import { request, settle } from '../governor/index.js';
import { noteFailure, noteSuccess } from '../governor/breaker.js';
import type { DraftedAction, Prospect } from '../types.js';

export interface FeedPost {
  urn: string;
  url: string;
  authorPublicId: string | null;
  authorName: string | null;
  body: string;
}

/**
 * Collect posts from a feed URL (a hashtag page, a company page, or the home
 * feed). Read-only.
 */
export async function harvestFeed(page: Page, feedUrl: string, limit = 20): Promise<FeedPost[]> {
  await goto(page, feedUrl);
  await scrollFeed(page, 3);

  const posts = await page.locator(anyOf(SELECTORS.feed.post)).all();
  const out: FeedPost[] = [];

  for (const post of posts.slice(0, limit)) {
    const urn =
      (await post.getAttribute('data-urn').catch(() => null)) ??
      (await post.getAttribute('data-id').catch(() => null));
    if (!urn) continue;

    const body = await post
      .locator(anyOf(SELECTORS.feed.postBody))
      .first()
      .innerText()
      .catch(() => '');
    if (!body || body.trim().length < 20) continue;

    const authorHref = await post
      .locator(anyOf(SELECTORS.feed.postAuthorLink))
      .first()
      .getAttribute('href')
      .catch(() => null);
    const authorName = await post
      .locator(anyOf(SELECTORS.feed.postAuthorName))
      .first()
      .innerText()
      .catch(() => null);

    const record: FeedPost = {
      urn,
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      authorPublicId: authorHref ? publicIdFromUrl(authorHref) : null,
      authorName: authorName?.trim() ?? null,
      body: body.replace(/\s+/g, ' ').trim(),
    };

    recordPost({
      postUrn: record.urn,
      postUrl: record.url,
      authorPublicId: record.authorPublicId,
      authorName: record.authorName,
      body: record.body,
    });
    out.push(record);
  }

  return out;
}

export interface EngageResult {
  performed: boolean;
  reason: string;
}

/** Like a post. */
export async function likePost(
  page: Page,
  post: FeedPost,
  prospect: Prospect | null,
  opts: { dryRun?: boolean } = {},
): Promise<EngageResult> {
  const action: DraftedAction = {
    actionType: 'like',
    prospectId: prospect?.id ?? null,
    targetUrl: post.url,
    body: null,
    // A like carries no text, so the post itself is the hook.
    hook: post.body.slice(0, 120),
  };

  const decision = request(action, { prospect, dryRun: opts.dryRun });
  if (decision.decision !== 'allow') return { performed: false, reason: decision.reason };
  if (opts.dryRun) {
    settle(decision.auditId, 'dry_run');
    return { performed: false, reason: 'dry run' };
  }

  try {
    await goto(page, post.url);
    const button = page.locator(anyOf(SELECTORS.feed.likeButton)).first();
    if (!(await button.count())) {
      const trip = noteFailure('like button not found');
      settle(decision.auditId, 'failed', 'like button not found');
      return { performed: false, reason: trip ? 'breaker tripped' : 'like button not found' };
    }

    // aria-pressed tells us whether it's already liked; liking twice un-likes.
    const pressed = await button.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') {
      settle(decision.auditId, 'failed', 'already liked');
      return { performed: false, reason: 'already liked' };
    }

    await button.click();
    await page.waitForTimeout(1_500);
    await guard(page);

    noteSuccess();
    settle(decision.auditId, 'success');
    markEngaged(post.urn);
    if (prospect) {
      recordInteraction({
        prospectId: prospect.id,
        direction: 'outbound',
        actionType: 'like',
        targetUrl: post.url,
      });
    }
    return { performed: true, reason: 'liked' };
  } catch (err) {
    const message = (err as Error).message;
    noteFailure(`like failed: ${message}`);
    settle(decision.auditId, 'failed', message);
    return { performed: false, reason: message };
  }
}

/** Comment on a post. `text` has already been drafted, linted, and hooked. */
export async function commentOnPost(
  page: Page,
  post: FeedPost,
  prospect: Prospect | null,
  text: string,
  hook: string,
  opts: { dryRun?: boolean } = {},
): Promise<EngageResult> {
  if (hasEngaged(post.urn)) {
    return { performed: false, reason: 'already engaged with this post' };
  }

  const action: DraftedAction = {
    actionType: 'comment',
    prospectId: prospect?.id ?? null,
    targetUrl: post.url,
    body: text,
    hook,
  };

  const decision = request(action, { prospect, dryRun: opts.dryRun });
  if (decision.decision !== 'allow') return { performed: false, reason: decision.reason };
  if (opts.dryRun) {
    settle(decision.auditId, 'dry_run');
    return { performed: false, reason: 'dry run' };
  }

  try {
    await goto(page, post.url);

    const commentButton = page.locator(anyOf(SELECTORS.feed.commentButton)).first();
    if (await commentButton.count()) {
      await commentButton.click();
      await page.waitForTimeout(1_200);
    }

    const box = page.locator(anyOf(SELECTORS.feed.commentBox)).first();
    if (!(await box.count())) {
      noteFailure('comment box not found');
      settle(decision.auditId, 'failed', 'comment box not found');
      return { performed: false, reason: 'comment box not found' };
    }

    await box.click();
    // Typed rather than pasted so the editor's own handlers fire; the delay is
    // what a person typing looks like to the page's input events.
    await box.type(text, { delay: 30 });
    await page.waitForTimeout(800);

    const submit = page.locator(anyOf(SELECTORS.feed.commentSubmit)).first();
    if (!(await submit.count())) {
      noteFailure('comment submit not found');
      settle(decision.auditId, 'failed', 'comment submit button not found');
      return { performed: false, reason: 'comment submit button not found' };
    }
    await submit.click();
    await page.waitForTimeout(2_000);
    await guard(page);

    noteSuccess();
    settle(decision.auditId, 'success');
    markEngaged(post.urn);
    if (prospect) {
      recordInteraction({
        prospectId: prospect.id,
        direction: 'outbound',
        actionType: 'comment',
        targetUrl: post.url,
        body: text,
      });
    }
    return { performed: true, reason: 'commented' };
  } catch (err) {
    const message = (err as Error).message;
    noteFailure(`comment failed: ${message}`);
    settle(decision.auditId, 'failed', message);
    return { performed: false, reason: message };
  }
}
