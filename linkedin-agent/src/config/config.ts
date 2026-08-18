/**
 * Every tunable in the system. Logic files import from here; no magic numbers
 * live in behaviour code, so changing how aggressive the agent is means editing
 * one file rather than auditing the whole tree.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root for the agent package (src/config -> src -> package root). */
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

export const PATHS = {
  data: path.join(PACKAGE_ROOT, 'data'),
  db: path.join(PACKAGE_ROOT, 'data', 'agent.db'),
  chromeProfile: path.join(PACKAGE_ROOT, 'data', 'chrome-profile'),
  logs: path.join(PACKAGE_ROOT, 'data', 'logs'),
  briefs: path.join(PACKAGE_ROOT, 'data', 'briefs'),
  imports: path.join(PACKAGE_ROOT, 'data', 'import'),
  fixtures: path.join(PACKAGE_ROOT, 'data', 'fixtures'),
  /** Presence of this file halts all writes. See governor/killswitch.ts. */
  pause: path.join(PACKAGE_ROOT, 'PAUSE'),
  /** Records the day the agent first ran, which anchors the ramp schedule. */
  firstRun: path.join(PACKAGE_ROOT, 'data', '.first-run'),
};

export interface Config {
  /** Master switch. When false the agent drafts and logs but never writes to LinkedIn. */
  writesEnabled: boolean;
  /**
   * Per-phase rollout. Even with writesEnabled, only the action types listed
   * here can execute — this is what makes the phased build order enforceable
   * rather than aspirational.
   */
  enabledWriteActions: Array<'like' | 'comment' | 'connect' | 'message'>;
  /** Skip the ramp and use target caps immediately. Off by default, deliberately. */
  skipRamp: boolean;
  schedule: {
    /** Local-time hours during which the agent may act, inclusive start, exclusive end. */
    workingHours: { start: number; end: number };
    /** 0 = Sunday. Days the agent stays off entirely. */
    quietDays: number[];
    /** Number of activity windows to spread the daily budget across. */
    windowsPerDay: number;
    /** Randomised gap between individual actions, milliseconds. */
    actionGapMs: { min: number; max: number };
  };
  /** Hard relationship rules, in days. */
  cooldowns: {
    messageSamePersonDays: number;
    commentSamePersonDays: number;
    reconnectAttemptDays: number;
  };
  scoring: {
    /** Below this, a prospect goes to nurture and gets no active outreach. */
    activeOutreachThreshold: number;
    /** At or above this, the prospect is flagged hot in the daily brief. */
    hotThreshold: number;
  };
  model: {
    id: string;
    draftEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    scoreEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTokens: number;
  };
  ghl: {
    locationId: string;
    /** Contacts created by this agent carry this tag, so they're separable in GHL. */
    tag: string;
    apiBase: string;
    apiVersion: string;
    /** Pipeline stage a LinkedIn prospect enters at when it reaches `conversing`. */
    entryStageName: string;
  };
  pricing: {
    /**
     * The agent may reference these ranges conversationally. It may never issue a
     * specific quote, discount, or scope commitment — those escalate to Josh.
     * See governor/rules.ts. Mirrors brand-voice-ikonic.
     */
    wrapRange: string;
    retainerTiers: string;
    allowRangeMentions: boolean;
  };
}

export const CONFIG: Config = {
  // Phase 3 flips this on. Phases 0-2 run entirely read-only.
  writesEnabled: envBool('LINKEDIN_AGENT_WRITES', false),
  enabledWriteActions: envList('LINKEDIN_AGENT_WRITE_ACTIONS', []) as Config['enabledWriteActions'],
  skipRamp: envBool('LINKEDIN_AGENT_SKIP_RAMP', false),

  schedule: {
    workingHours: { start: 8, end: 18 },
    quietDays: [0],
    windowsPerDay: 4,
    actionGapMs: { min: 45_000, max: 240_000 },
  },

  cooldowns: {
    messageSamePersonDays: 7,
    commentSamePersonDays: 14,
    reconnectAttemptDays: 90,
  },

  scoring: {
    activeOutreachThreshold: 20,
    hotThreshold: 70,
  },

  model: {
    id: 'claude-opus-5',
    draftEffort: 'high',
    scoreEffort: 'low',
    maxTokens: 8_000,
  },

  ghl: {
    locationId: process.env.GHL_LOCATION_ID ?? 'DSt3GeDVV0wQXQt9iuGn',
    tag: 'linkedin-agent',
    apiBase: 'https://services.leadconnectorhq.com',
    apiVersion: '2021-07-28',
    entryStageName: 'New Lead',
  },

  pricing: {
    wrapRange: '$3K–$5.2K',
    retainerTiers: '$497 / $797 / $1,297',
    allowRangeMentions: true,
  },
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Create the data directories the agent writes into. Safe to call repeatedly. */
export function ensureDirs(): void {
  for (const dir of [PATHS.data, PATHS.logs, PATHS.briefs, PATHS.imports, PATHS.fixtures]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
