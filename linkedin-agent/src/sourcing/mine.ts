/**
 * Engagement mining.
 *
 * Harvests people who are already commenting on posts in Ikonic's world. Highest
 * signal in the system — someone arguing about condenser pricing in a comment
 * thread is demonstrably an active operator, not a dormant profile — and the
 * lowest footprint, because reading a public feed is what a normal user does all
 * day.
 */

import type { Page } from 'playwright';
import { MINING_FEEDS } from '../config/icp.js';
import { harvestFeed, type FeedPost } from '../actions/engage.js';
import { SELECTORS, anyOf, publicIdFromUrl } from '../browser/selectors.js';
import { goto } from '../browser/session.js';
import { upsertProspect } from '../memory/prospects.js';
import { findByPublicId } from '../memory/prospects.js';

export interface MiningResult {
  feed: string;
  postsSeen: number;
  peopleFound: number;
  newPeople: number;
}

/** Mine every configured feed. */
export async function mineAll(page: Page, opts: { postsPerFeed?: number } = {}): Promise<MiningResult[]> {
  const results: MiningResult[] = [];
  for (const feed of MINING_FEEDS) {
    results.push(await mineFeed(page, feed.url, feed.label, opts.postsPerFeed ?? 10));
  }
  return results;
}

export async function mineFeed(
  page: Page,
  feedUrl: string,
  label: string,
  postLimit = 10,
): Promise<MiningResult> {
  const posts = await harvestFeed(page, feedUrl, postLimit);
  const result: MiningResult = { feed: label, postsSeen: posts.length, peopleFound: 0, newPeople: 0 };

  // Post authors are prospects in their own right.
  for (const post of posts) {
    if (!post.authorPublicId || !post.authorName) continue;
    result.peopleFound += 1;
    if (!findByPublicId(post.authorPublicId)) result.newPeople += 1;
    upsertProspect({
      publicId: post.authorPublicId,
      profileUrl: `https://www.linkedin.com/in/${post.authorPublicId}/`,
      fullName: post.authorName,
      source: 'engagement_mining',
    });
  }

  // So are the people commenting on those posts.
  for (const post of posts.slice(0, 5)) {
    const commenters = await harvestCommenters(page, post);
    for (const c of commenters) {
      result.peopleFound += 1;
      if (!findByPublicId(c.publicId)) result.newPeople += 1;
      upsertProspect({
        publicId: c.publicId,
        profileUrl: `https://www.linkedin.com/in/${c.publicId}/`,
        fullName: c.name,
        source: 'engagement_mining',
      });
    }
  }

  return result;
}

interface Commenter {
  publicId: string;
  name: string;
}

async function harvestCommenters(page: Page, post: FeedPost): Promise<Commenter[]> {
  try {
    await goto(page, post.url);
    await page.waitForTimeout(2_000);

    const links = await page.locator(anyOf(SELECTORS.feed.commenterLinks)).all();
    const out: Commenter[] = [];
    const seen = new Set<string>();

    for (const link of links.slice(0, 15)) {
      const href = await link.getAttribute('href').catch(() => null);
      const publicId = href ? publicIdFromUrl(href) : null;
      if (!publicId || seen.has(publicId)) continue;

      const name = (await link.innerText().catch(() => ''))?.trim();
      if (!name || /linkedin member/i.test(name)) continue;

      seen.add(publicId);
      out.push({ publicId, name });
    }
    return out;
  } catch {
    // A post that won't load is not worth failing the whole mining pass over.
    return [];
  }
}
