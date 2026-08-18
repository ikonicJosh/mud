/**
 * LinkedIn people search.
 *
 * Gap-filling only. Search is the most-detected behaviour in this system, so it
 * carries the hardest cap in config/caps.ts and runs last in the sourcing order —
 * Clay imports and engagement mining fill the list first, and search only covers
 * what they missed.
 */

import type { Page } from 'playwright';
import { goto, scrollFeed } from '../browser/session.js';
import { SELECTORS, anyOf, publicIdFromUrl } from '../browser/selectors.js';
import { request, settle } from '../governor/index.js';
import type { DraftedAction } from '../types.js';

export interface SearchHit {
  publicId: string;
  profileUrl: string;
  fullName: string;
  headline: string | null;
  location: string | null;
}

export function buildSearchUrl(query: string, page = 1): string {
  const params = new URLSearchParams({
    keywords: query,
    origin: 'GLOBAL_SEARCH_HEADER',
    ...(page > 1 ? { page: String(page) } : {}),
  });
  return `https://www.linkedin.com/search/results/people/?${params.toString()}`;
}

/**
 * Run one search query. Counts against the `search` cap via the governor, since
 * it's the action type LinkedIn watches most closely.
 */
export async function searchPeople(
  page: Page,
  query: string,
  opts: { pages?: number; dryRun?: boolean } = {},
): Promise<SearchHit[]> {
  const action: DraftedAction = {
    actionType: 'search',
    prospectId: null,
    targetUrl: buildSearchUrl(query),
    body: query,
    hook: query,
  };

  const decision = request(action, { prospect: null, dryRun: opts.dryRun });
  if (decision.decision !== 'allow') return [];
  if (opts.dryRun) {
    settle(decision.auditId, 'dry_run');
    return [];
  }

  const hits: SearchHit[] = [];
  const pageCount = Math.max(1, Math.min(opts.pages ?? 1, 3));

  try {
    for (let p = 1; p <= pageCount; p++) {
      await goto(page, buildSearchUrl(query, p));
      await scrollFeed(page, 2);

      const items = await page.locator(anyOf(SELECTORS.search.resultItem)).all();
      for (const item of items) {
        const href = await item
          .locator(anyOf(SELECTORS.search.resultLink))
          .first()
          .getAttribute('href')
          .catch(() => null);
        if (!href) continue;

        const publicId = publicIdFromUrl(href);
        if (!publicId) continue;

        const fullName = await item
          .locator(anyOf(SELECTORS.search.resultName))
          .first()
          .innerText()
          .catch(() => null);
        if (!fullName?.trim() || /linkedin member/i.test(fullName)) continue;

        hits.push({
          publicId,
          profileUrl: `https://www.linkedin.com/in/${publicId}/`,
          fullName: fullName.trim(),
          headline: await textIn(item, SELECTORS.search.resultHeadline),
          location: await textIn(item, SELECTORS.search.resultLocation),
        });
      }
    }
    settle(decision.auditId, 'success');
  } catch (err) {
    settle(decision.auditId, 'failed', (err as Error).message);
    throw err;
  }

  return dedupe(hits);
}

async function textIn(
  scope: { locator: (sel: string) => { first: () => { innerText: () => Promise<string> } } },
  candidates: readonly string[],
): Promise<string | null> {
  try {
    const t = await scope.locator(anyOf(candidates)).first().innerText();
    return t.trim() || null;
  } catch {
    return null;
  }
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (seen.has(h.publicId)) return false;
    seen.add(h.publicId);
    return true;
  });
}
