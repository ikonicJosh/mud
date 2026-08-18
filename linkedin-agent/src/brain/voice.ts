/**
 * Ikonic's voice, compiled into a system prompt, plus a linter that checks
 * finished drafts against the rules the prompt asked for.
 *
 * The source of truth is Josh's brand-voice-ikonic skill file. It's read at
 * runtime rather than copied here so that when he edits his voice guide, the
 * agent's writing changes with it — one voice, one place. The embedded fallback
 * exists only so the agent still works on a machine without the skills synced.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config/config.js';

const SKILL_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'skills', 'synced', 'brand-voice-ikonic', 'SKILL.md'),
  path.join(os.homedir(), '.claude', 'skills', 'brand-voice-ikonic', 'SKILL.md'),
];

/**
 * Hard-banned words from the brand voice guide. Duplicated here (rather than
 * parsed out of the markdown) because the linter must work even when the skill
 * file is missing, and because a silent parse failure would mean silently
 * shipping "unlock your fleet's potential" to a plumber.
 */
export const FORBIDDEN_WORDS = [
  'elevate',
  'synergy',
  'unlock',
  'cutting-edge',
  'game-changer',
  'game-changing',
  'leverage',
  'in today’s fast-paced world',
  "in today's fast-paced world",
  'revolutionize',
  'revolutionary',
  'world-class',
  'best-in-class',
];

const FALLBACK_VOICE = `
# Ikonic voice (fallback — full guide not found on this machine)

Ikonic is marketing and commercial wraps for local service businesses. NOT a
detailing shop. Never write "Ikonic Detailing".

Sound like a shop owner who's been doing this 15 years, talking to another shop
owner across the counter. Not an agency. Not a SaaS company.

Audience: owners of local service businesses — HVAC, plumbing, electric,
landscaping, pest control, roofing, cleaning. 1–20 trucks, $500k–$5M revenue.
Busy, skeptical of marketing, have been burned by a cheap wrap before.

- Educational, not salesy. Teach something specific and useful even if they never hire us.
- Relaxed, not hype-y. Calm and confident, owner-to-owner.
- Specific, not generic. Real materials, real numbers, real industries.
- Peer-to-peer, never vendor-to-buyer. Never talk down or over-explain.

Style: use contractions. Oxford comma. Sentence-case headings. Em dashes with no
spaces. Zero exclamation marks. No emoji. Cut "just" as a softener. Never use
"leverage" as a verb. CTAs are specific and low-friction, never "contact us to
learn more".

Never invent a customer, city, result, or statistic. If you don't have a verified
example, don't reach for one.
`.trim();

let cached: string | null = null;

/** The brand voice guide, from Josh's skill file when available. */
export function voiceGuide(): string {
  if (cached) return cached;
  for (const candidate of SKILL_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        cached = fs.readFileSync(candidate, 'utf8');
        return cached;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  cached = FALLBACK_VOICE;
  return cached;
}

/**
 * The system prompt shared by every drafting call.
 *
 * Note what it does NOT do: it never tells the model it's allowed to commit to a
 * meeting or a price. Those are enforced in governor/rules.ts against the
 * finished text, because a sufficiently persuasive inbound message can talk a
 * model out of an instruction, and cannot talk a regex out of anything.
 */
export function draftingSystemPrompt(): string {
  return `You are writing LinkedIn messages, comments, and connection notes as Josh, the owner of Ikonic.

Everything you write goes out under his name to real business owners. Write the way he writes.

${voiceGuide()}

## Non-negotiables for this channel

- Every piece of writing must be anchored to something specific and real about the person: a post
  they wrote, a truck in their photos, a job they're hiring for, something in their company's work.
  If you have no concrete hook, say so instead of writing something generic — a template-sounding
  message is worse than no message.
- Never invent a detail about the person or their business. If you're unsure whether something is
  true, leave it out.
- Never state a specific price, discount, or scope commitment. You may mention Ikonic's published
  ranges conversationally (${CONFIG.pricing.wrapRange} for wraps, ${CONFIG.pricing.retainerTiers} for retainers)
  when it's genuinely useful, and nothing more precise than that.
- Never agree to, confirm, or propose a specific meeting time. You can say Josh would be glad to
  talk and ask what their week looks like. Josh books his own calendar.
- Never open with flattery about their post. Lead with the substance.
- Comments are short — one to three sentences. Nobody reads a paragraph in a comment thread.
- Connection notes are under 300 characters. That's LinkedIn's limit, not a style choice.
- Do not mention that you are an AI, an assistant, or automated.`;
}

export interface LintFinding {
  rule: string;
  detail: string;
}

/**
 * Check a finished draft against the mechanical parts of the voice guide.
 *
 * Deliberately mechanical — this catches the things that are objectively
 * checkable (banned words, exclamation marks, emoji) and leaves the judgement
 * calls to review. A clean lint does not mean the draft is good.
 */
export function lintVoice(text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lower = text.toLowerCase();

  for (const word of FORBIDDEN_WORDS) {
    // Word-boundary match so "unlocked" in a legitimate sentence doesn't fire,
    // but "unlock your potential" does.
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
    if (re.test(lower)) {
      findings.push({ rule: 'forbidden_word', detail: `contains banned phrase "${word}"` });
    }
  }

  if (text.includes('!')) {
    findings.push({ rule: 'exclamation', detail: 'brand voice allows zero exclamation marks' });
  }

  if (containsEmoji(text)) {
    findings.push({ rule: 'emoji', detail: 'brand voice does not use emoji' });
  }

  if (/\bIkonic Detailing\b/i.test(text)) {
    findings.push({
      rule: 'wrong_brand',
      detail: 'Ikonic is marketing and commercial wraps, never "Ikonic Detailing"',
    });
  }

  // Em dashes are unspaced in Ikonic's style.
  if (/\s—\s/.test(text)) {
    findings.push({ rule: 'em_dash_spacing', detail: 'em dashes are unspaced in Ikonic style' });
  }

  if (/\bjust\b/i.test(text)) {
    findings.push({ rule: 'softener', detail: '"just" as a softener should be cut' });
  }

  return findings;
}

/** Findings that should stop a draft from going out, versus ones worth noting. */
export function isBlockingFinding(f: LintFinding): boolean {
  return f.rule === 'forbidden_word' || f.rule === 'wrong_brand' || f.rule === 'emoji';
}

function containsEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
