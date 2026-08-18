/**
 * Reading profiles.
 *
 * Read-only: this module never clicks anything that changes state. Note that
 * merely loading a profile is visible to its owner as a profile view, which is
 * why `profile_view` is a capped action type even though nothing is written.
 */

import type { Page } from 'playwright';
import { goto, textOf, scrollFeed } from '../browser/session.js';
import { SELECTORS, anyOf, publicIdFromUrl } from '../browser/selectors.js';
import { upsertProspect, type NewProspect } from '../memory/prospects.js';
import type { Prospect, ProspectSource } from '../types.js';

export interface ProfileSnapshot {
  publicId: string;
  profileUrl: string;
  fullName: string;
  headline: string | null;
  location: string | null;
  company: string | null;
  recentPosts: string[];
}

export function profileUrlFor(publicId: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
}

export async function readProfile(page: Page, publicId: string): Promise<ProfileSnapshot | null> {
  const url = profileUrlFor(publicId);
  await goto(page, url);

  const fullName = await textOf(page, SELECTORS.profile.name);
  if (!fullName) return null; // profile gone, private, or the DOM moved

  return {
    publicId,
    profileUrl: url,
    fullName,
    headline: await textOf(page, SELECTORS.profile.headline),
    location: await textOf(page, SELECTORS.profile.location),
    company: await textOf(page, SELECTORS.profile.currentCompany),
    recentPosts: [],
  };
}

/**
 * Their recent posts — the raw material for a comment or a connection note
 * that doesn't sound like a template.
 */
export async function readRecentPosts(page: Page, publicId: string, limit = 5): Promise<string[]> {
  await goto(page, `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/recent-activity/all/`);
  await scrollFeed(page, 2);

  const bodies = await page
    .locator(anyOf(SELECTORS.feed.postBody))
    .allInnerTexts()
    .catch(() => [] as string[]);

  return bodies
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 20)
    .slice(0, limit);
}

/** Read a profile and persist it. Returns the stored prospect. */
export async function captureProfile(
  page: Page,
  publicId: string,
  source: ProspectSource,
  opts: { withPosts?: boolean } = {},
): Promise<{ prospect: Prospect; snapshot: ProfileSnapshot } | null> {
  const snapshot = await readProfile(page, publicId);
  if (!snapshot) return null;

  if (opts.withPosts) {
    snapshot.recentPosts = await readRecentPosts(page, publicId);
  }

  const record: NewProspect = {
    publicId: snapshot.publicId,
    profileUrl: snapshot.profileUrl,
    fullName: snapshot.fullName,
    headline: snapshot.headline,
    location: snapshot.location,
    company: snapshot.company,
    source,
  };

  return { prospect: upsertProspect(record), snapshot };
}

export { publicIdFromUrl };
