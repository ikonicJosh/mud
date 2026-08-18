/**
 * The daily brief — the second-brain half of this tool.
 *
 * The agent handles the channel; the brief is how Josh stays the one running it.
 * Answers four questions in order of how much they matter: what needs you, who's
 * hot, who moved, what did it do. Written as markdown so it reads fine in a
 * terminal, in an editor, or pasted into a message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PATHS, ensureDirs } from '../config/config.js';
import { db } from '../memory/db.js';
import { openEscalations, recentActions } from '../memory/audit.js';
import { countByState, findById, listHot } from '../memory/prospects.js';
import { awaitingReply } from '../memory/threads.js';
import { effectiveCaps, rampWeek } from '../governor/ramp.js';
import { isPaused, pauseReason } from '../governor/killswitch.js';
import { isTripped } from '../governor/breaker.js';
import { startOfDay } from '../governor/index.js';
import type { ActionType } from '../types.js';

export interface BriefOptions {
  now?: Date;
  /** Write the file to disk as well as returning it. */
  persist?: boolean;
}

export function buildBrief(opts: BriefOptions = {}): string {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# LinkedIn brief — ${today}`, '');

  // Status first: if the agent is stopped, nothing else on the page matters.
  const tripped = isTripped();
  if (tripped) {
    lines.push(
      `> **STOPPED — circuit breaker.** ${tripped.reason}: ${tripped.detail}`,
      '>',
      '> Nothing has run since. Look at the account in a browser before resuming.',
      '',
    );
  } else if (isPaused()) {
    lines.push(`> **PAUSED.** ${pauseReason() ?? 'no reason recorded'}`, '');
  }

  // 1. What needs Josh.
  const escalations = openEscalations(25);
  lines.push('## Needs you', '');
  if (escalations.length === 0) {
    lines.push('_Nothing waiting._', '');
  } else {
    for (const e of escalations) {
      const who = e.prospectId ? (findById(e.prospectId)?.fullName ?? `#${e.prospectId}`) : '—';
      lines.push(`- **${labelFor(e.reason)}** · ${who}`);
      lines.push(`  - ${e.detail}`);
      if (e.targetUrl) lines.push(`  - ${e.targetUrl}`);
      if (e.draft) lines.push(`  - Draft it didn't send: "${truncate(e.draft, 240)}"`);
    }
    lines.push('');
  }

  // 2. Unanswered inbound.
  const waiting = awaitingReply(20);
  lines.push('## Waiting on a reply', '');
  if (waiting.length === 0) {
    lines.push('_Inbox is clear._', '');
  } else {
    for (const t of waiting) {
      const p = findById(t.prospectId);
      lines.push(
        `- ${p?.fullName ?? `#${t.prospectId}`}${p?.company ? ` (${p.company})` : ''} — last message ${t.lastMessageAt ?? 'unknown'}${
          t.classification ? ` · ${t.classification}` : ''
        }`,
      );
    }
    lines.push('');
  }

  // 3. Who's hot.
  const hot = listHot(CONFIG.scoring.hotThreshold, 10);
  lines.push('## Hot', '');
  if (hot.length === 0) {
    lines.push(`_Nobody above ${CONFIG.scoring.hotThreshold} yet._`, '');
  } else {
    for (const p of hot) {
      lines.push(`- **${p.fullName}** (${p.score}) — ${p.headline ?? 'no headline'} · ${p.state}`);
      if (p.scoreRationale) lines.push(`  - ${truncate(p.scoreRationale, 200)}`);
      lines.push(`  - ${p.profileUrl}`);
    }
    lines.push('');
  }

  // 4. What the agent did today.
  lines.push('## Activity today', '');
  const counts = actionCountsToday(now);
  const week = rampWeek(now);
  if (Object.keys(counts).length === 0) {
    lines.push('_No actions today._', '');
  } else {
    for (const [type, n] of Object.entries(counts)) {
      const cap = effectiveCaps(type as ActionType, now).daily;
      lines.push(`- ${type}: ${n}/${cap}`);
    }
    lines.push('');
  }
  lines.push(`Ramp week ${week}${CONFIG.skipRamp ? ' (ramp disabled)' : ''}.`, '');

  // 5. Pipeline shape.
  lines.push('## Pipeline', '');
  const states = countByState();
  const order = [
    'sourced',
    'scored',
    'engaged',
    'connect_sent',
    'connected',
    'conversing',
    'hot',
    'handed_off',
    'nurture',
    'excluded',
  ];
  for (const s of order) {
    if (states[s]) lines.push(`- ${s}: ${states[s]}`);
  }
  lines.push('');

  // 6. Anything that failed, so problems don't hide.
  const failures = recentActions(60).filter((a) => a.outcome === 'failed');
  if (failures.length > 0) {
    lines.push('## Failures', '');
    for (const f of failures.slice(0, 10)) {
      lines.push(`- ${f.actionType} — ${f.error ?? 'unknown error'}`);
    }
    lines.push('');
  }

  const text = lines.join('\n');

  if (opts.persist !== false) {
    ensureDirs();
    fs.writeFileSync(path.join(PATHS.briefs, `${today}.md`), text, 'utf8');
  }
  return text;
}

function actionCountsToday(now: Date): Record<string, number> {
  const rows = db()
    .prepare(
      `SELECT action_type, COUNT(*) AS n FROM actions
       WHERE outcome = 'success' AND occurred_at >= ?
       GROUP BY action_type`,
    )
    .all(startOfDay(now)) as Array<{ action_type: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.action_type, r.n]));
}

function labelFor(reason: string): string {
  const map: Record<string, string> = {
    meeting_request: 'Wants to meet',
    negative_thread: 'Negative / complaint',
    pricing_request: 'Asked about price',
    known_client: 'Existing client',
    breaker_tripped: 'Circuit breaker',
    low_confidence_draft: 'Low-confidence draft',
  };
  return map[reason] ?? reason;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}
