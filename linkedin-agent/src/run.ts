/**
 * The run loop.
 *
 * One pass, in a fixed order chosen so the highest-value and lowest-risk work
 * happens first and the account-sensitive work happens last against a budget
 * that may already be partly spent:
 *
 *   1. import   — Clay lists off disk (no LinkedIn contact at all)
 *   2. inbox    — read everything, reply where it's safe (people who wrote to us come first)
 *   3. mine     — harvest feeds for new prospects and engageable posts
 *   4. score    — rank whoever is new
 *   5. engage   — like and comment
 *   6. connect  — invitations with notes
 *   7. search   — gap-fill, hardest capped, last
 *   8. sync     — push to GHL
 *   9. brief    — write the daily brief
 *
 * Every stage is individually skippable so Josh can run one piece, and every
 * stage catches its own errors — a broken mining pass shouldn't cost him the
 * inbox triage.
 */

import type { Page } from 'playwright';
import { SEARCH_QUERIES } from './config/icp.js';
import { newPage, requireLogin, closeSession, BreakerTrippedError } from './browser/session.js';
import { isPaused, pauseReason, PausedError, assertNotPaused } from './governor/killswitch.js';
import { pauseBetweenActions } from './governor/pacing.js';
import { importAll } from './sourcing/import.js';
import { mineAll } from './sourcing/mine.js';
import { searchPeople } from './actions/search.js';
import { captureProfile, readRecentPosts } from './actions/profile.js';
import { harvestFeed, likePost, commentOnPost } from './actions/engage.js';
import { listThreads, captureThread, sendReply } from './actions/inbox.js';
import { sendConnectionRequest, checkConnectionAccepted, NOTE_MAX_CHARS } from './actions/connect.js';
import { classifyThread, agentMayReply } from './brain/classify.js';
import { draftComment, draftConnectionNote, draftReply, usable } from './brain/draft.js';
import { scoreProspect, qualifiesForOutreach } from './brain/score.js';
import { upsertProspect, listByState, setScore, transition, findByPublicId } from './memory/prospects.js';
import { findByConversationId, classify as classifyStored } from './memory/threads.js';
import { escalate } from './memory/audit.js';
import { unengaged } from './memory/posts.js';
import { runSync } from './crm/sync.js';
import { buildBrief } from './report/brief.js';

export type Stage =
  | 'import'
  | 'inbox'
  | 'mine'
  | 'score'
  | 'engage'
  | 'connect'
  | 'search'
  | 'sync'
  | 'brief';

export const ALL_STAGES: Stage[] = [
  'import',
  'inbox',
  'mine',
  'score',
  'engage',
  'connect',
  'search',
  'sync',
  'brief',
];

export interface RunOptions {
  stages?: Stage[];
  dryRun?: boolean;
  /** Cap work per stage, mostly for testing and first runs. */
  limit?: number;
  log?: (msg: string) => void;
}

export interface RunReport {
  stagesRun: Stage[];
  imported: number;
  threadsRead: number;
  repliesSent: number;
  peopleFound: number;
  scored: number;
  likes: number;
  comments: number;
  invitations: number;
  searchHits: number;
  errors: string[];
  halted: string | null;
}

export async function run(opts: RunOptions = {}): Promise<RunReport> {
  const stages = opts.stages ?? ALL_STAGES;
  const log = opts.log ?? ((m: string) => console.log(m));
  const limit = opts.limit ?? 10;
  const dryRun = Boolean(opts.dryRun);

  const report: RunReport = {
    stagesRun: [],
    imported: 0,
    threadsRead: 0,
    repliesSent: 0,
    peopleFound: 0,
    scored: 0,
    likes: 0,
    comments: 0,
    invitations: 0,
    searchHits: 0,
    errors: [],
    halted: null,
  };

  if (isPaused()) {
    report.halted = `kill switch active: ${pauseReason()}`;
    log(report.halted);
    return report;
  }

  // Stage 1 touches no browser, so it runs before we open one.
  if (stages.includes('import')) {
    report.stagesRun.push('import');
    for (const summary of importAll()) {
      report.imported += summary.imported;
      log(`import ${summary.file}: ${summary.imported} in, ${summary.skipped} skipped`);
      for (const r of summary.reasons.slice(0, 5)) log(`  - ${r}`);
    }
  }

  const needsBrowser = stages.some((s) =>
    (['inbox', 'mine', 'score', 'engage', 'connect', 'search'] as Stage[]).includes(s),
  );

  let page: Page | null = null;
  try {
    if (needsBrowser) {
      page = await newPage();
      await requireLogin(page);
      log('session ok');
    }

    if (page && stages.includes('inbox')) {
      report.stagesRun.push('inbox');
      await stageInbox(page, report, { dryRun, limit, log });
    }
    if (page && stages.includes('mine')) {
      report.stagesRun.push('mine');
      await stageMine(page, report, { log });
    }
    if (page && stages.includes('score')) {
      report.stagesRun.push('score');
      await stageScore(page, report, { limit, log });
    }
    if (page && stages.includes('engage')) {
      report.stagesRun.push('engage');
      await stageEngage(page, report, { dryRun, limit, log });
    }
    if (page && stages.includes('connect')) {
      report.stagesRun.push('connect');
      await stageConnect(page, report, { dryRun, limit, log });
    }
    if (page && stages.includes('search')) {
      report.stagesRun.push('search');
      await stageSearch(page, report, { dryRun, log });
    }
  } catch (err) {
    if (err instanceof BreakerTrippedError) {
      report.halted = err.message;
      log(`HALTED — ${err.message}`);
    } else if (err instanceof PausedError) {
      report.halted = err.message;
      log(`HALTED — ${err.message}`);
    } else {
      report.errors.push((err as Error).message);
      log(`error: ${(err as Error).message}`);
    }
  } finally {
    if (page) await closeSession().catch(() => undefined);
  }

  if (stages.includes('sync')) {
    report.stagesRun.push('sync');
    try {
      const s = await runSync();
      if (s.skipped) {
        log('sync skipped — GHL_API_KEY not set');
      } else {
        log(
          `sync: ${s.contactsSynced} contacts, ${s.opportunitiesCreated} opportunities, ${s.excluded} excluded as clients`,
        );
        report.errors.push(...s.errors);
      }
    } catch (err) {
      report.errors.push(`sync: ${(err as Error).message}`);
    }
  }

  if (stages.includes('brief')) {
    report.stagesRun.push('brief');
    try {
      buildBrief();
      log('brief written');
    } catch (err) {
      report.errors.push(`brief: ${(err as Error).message}`);
    }
  }

  return report;
}

/** Read every thread, classify it, reply only where it's clearly safe. */
async function stageInbox(
  page: Page,
  report: RunReport,
  o: { dryRun: boolean; limit: number; log: (m: string) => void },
): Promise<void> {
  const threads = await listThreads(page, Math.max(o.limit, 20));
  o.log(`inbox: ${threads.length} conversations`);

  for (const thread of threads) {
    assertNotPaused();
    const captured = await captureThread(page, thread);
    if (!captured) continue;
    report.threadsRead += 1;

    const { prospect, messages } = captured;
    const last = messages.at(-1);
    if (!last || last.sender !== 'them') continue; // nothing to answer

    const stored = findByConversationId(thread.conversationId);
    const classification = await classifyThread(messages, {
      name: prospect.fullName,
      headline: prospect.headline,
      company: prospect.company,
    });
    if (stored) classifyStored(stored.id, classification.label, classification.rationale);

    const permitted = agentMayReply(classification);
    if (!permitted.ok) {
      escalate({
        prospectId: prospect.id,
        reason: classification.label === 'negative' ? 'negative_thread' : 'low_confidence_draft',
        detail: `${permitted.reason} — "${last.body.slice(0, 200)}"`,
        targetUrl: thread.conversationUrl,
      });
      o.log(`  ${prospect.fullName}: escalated (${permitted.reason})`);
      continue;
    }

    const draft = await draftReply({
      prospect,
      messages,
      threadContext: `${classification.label}: ${classification.rationale}`,
    });
    const check = usable(draft);
    if (!check.ok) {
      escalate({
        prospectId: prospect.id,
        reason: 'low_confidence_draft',
        detail: `draft not usable: ${check.reason}`,
        draft: draft.text,
        targetUrl: thread.conversationUrl,
      });
      o.log(`  ${prospect.fullName}: draft held back (${check.reason})`);
      continue;
    }

    const result = await sendReply(
      page,
      thread,
      prospect,
      draft.text,
      draft.hook,
      classification.label,
      { dryRun: o.dryRun, threadDbId: stored?.id },
    );
    if (result.performed) {
      report.repliesSent += 1;
      if (prospect.state !== 'hot') transition(prospect.id, 'conversing');
      o.log(`  ${prospect.fullName}: replied`);
    } else {
      o.log(`  ${prospect.fullName}: ${result.reason}`);
    }
    await pauseBetweenActions(o.dryRun);
  }
}

async function stageMine(page: Page, report: RunReport, o: { log: (m: string) => void }): Promise<void> {
  const results = await mineAll(page, { postsPerFeed: 8 });
  for (const r of results) {
    report.peopleFound += r.newPeople;
    o.log(`mine ${r.feed}: ${r.postsSeen} posts, ${r.newPeople} new people`);
  }
}

/** Score anyone newly sourced, then push them to scored or nurture. */
async function stageScore(
  page: Page,
  report: RunReport,
  o: { limit: number; log: (m: string) => void },
): Promise<void> {
  const pending = listByState('sourced', o.limit);
  o.log(`score: ${pending.length} to rank`);

  for (const p of pending) {
    assertNotPaused();
    try {
      // Fill in the profile if the prospect arrived thin (mining gives us a name
      // and a URL and not much else).
      let prospect = p;
      if (!p.headline) {
        const captured = await captureProfile(page, p.publicId, p.source);
        if (captured) prospect = captured.prospect;
      }

      const posts = await readRecentPosts(page, prospect.publicId, 5).catch(() => []);
      const breakdown = await scoreProspect(prospect, { recentPosts: posts });
      setScore(prospect.id, breakdown.total, breakdown.rationale);
      transition(prospect.id, qualifiesForOutreach(breakdown.total) ? 'scored' : 'nurture');
      report.scored += 1;
      o.log(`  ${prospect.fullName}: ${breakdown.total}`);
    } catch (err) {
      report.errors.push(`score ${p.publicId}: ${(err as Error).message}`);
    }
  }
}

/** Like and comment on posts from people worth engaging. */
async function stageEngage(
  page: Page,
  report: RunReport,
  o: { dryRun: boolean; limit: number; log: (m: string) => void },
): Promise<void> {
  // Fresh posts from the mining pass, plus anything we saw but didn't act on.
  const candidates = unengaged(o.limit * 3);
  o.log(`engage: ${candidates.length} candidate posts`);

  let done = 0;
  for (const post of candidates) {
    if (done >= o.limit) break;
    assertNotPaused();
    if (!post.authorPublicId || !post.body) continue;

    const prospect = findByPublicId(post.authorPublicId);
    if (!prospect || prospect.state === 'excluded' || prospect.state === 'nurture') continue;

    const feedPost = {
      urn: post.postUrn,
      url: post.postUrl,
      authorPublicId: post.authorPublicId,
      authorName: post.authorName,
      body: post.body,
    };

    // A like is cheap and warms the ground for the comment.
    const liked = await likePost(page, feedPost, prospect, { dryRun: o.dryRun });
    if (liked.performed) report.likes += 1;

    const draft = await draftComment({
      prospect,
      postBody: post.body,
      postAuthor: post.authorName ?? prospect.fullName,
    });
    const check = usable(draft);
    if (!check.ok) {
      o.log(`  ${prospect.fullName}: no comment (${check.reason})`);
      continue;
    }

    const commented = await commentOnPost(
      page,
      feedPost,
      prospect,
      draft.text,
      draft.hook,
      { dryRun: o.dryRun },
    );
    if (commented.performed) {
      report.comments += 1;
      done += 1;
      if (prospect.state === 'scored') transition(prospect.id, 'engaged');
      o.log(`  ${prospect.fullName}: commented`);
    } else {
      o.log(`  ${prospect.fullName}: ${commented.reason}`);
    }
    await pauseBetweenActions(o.dryRun);
  }
}

/** Send invitations to engaged prospects, and check on ones already sent. */
async function stageConnect(
  page: Page,
  report: RunReport,
  o: { dryRun: boolean; limit: number; log: (m: string) => void },
): Promise<void> {
  // Promote anyone whose invitation was accepted since last run.
  for (const p of listByState('connect_sent', 20)) {
    assertNotPaused();
    try {
      if (await checkConnectionAccepted(page, p)) o.log(`  ${p.fullName}: accepted`);
    } catch {
      // A profile that won't load isn't worth failing the stage over.
    }
  }

  const candidates = listByState('engaged', o.limit);
  o.log(`connect: ${candidates.length} candidates`);

  for (const p of candidates) {
    assertNotPaused();
    const posts = await readRecentPosts(page, p.publicId, 3).catch(() => []);
    const draft = await draftConnectionNote({ prospect: p, recentPosts: posts });
    const check = usable(draft, { maxChars: NOTE_MAX_CHARS });
    if (!check.ok) {
      o.log(`  ${p.fullName}: no note (${check.reason})`);
      continue;
    }

    const result = await sendConnectionRequest(page, p, draft.text, draft.hook, {
      dryRun: o.dryRun,
    });
    if (result.performed) {
      report.invitations += 1;
      o.log(`  ${p.fullName}: invited`);
    } else {
      o.log(`  ${p.fullName}: ${result.reason}`);
    }
    await pauseBetweenActions(o.dryRun);
  }
}

/** Gap-fill the list with search. Last, and hardest capped. */
async function stageSearch(
  page: Page,
  report: RunReport,
  o: { dryRun: boolean; log: (m: string) => void },
): Promise<void> {
  for (const query of SEARCH_QUERIES) {
    assertNotPaused();
    const hits = await searchPeople(page, query, { pages: 1, dryRun: o.dryRun });
    if (hits.length === 0) continue;

    for (const hit of hits) {
      upsertProspect({
        publicId: hit.publicId,
        profileUrl: hit.profileUrl,
        fullName: hit.fullName,
        headline: hit.headline,
        location: hit.location,
        source: 'linkedin_search',
      });
    }
    report.searchHits += hits.length;
    o.log(`search "${query}": ${hits.length} hits`);
    await pauseBetweenActions(o.dryRun);
  }
}
