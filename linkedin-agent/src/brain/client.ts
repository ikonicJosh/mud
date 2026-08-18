/**
 * Anthropic client wrapper.
 *
 * One place that knows about the model, so effort and thinking settings don't
 * drift between the scoring path (cheap, high volume) and the drafting path
 * (expensive, low volume, quality matters).
 */

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config/config.js';

let client: Anthropic | null = null;

/**
 * Zero-arg construction on purpose: the SDK resolves ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. Passing a key
 * explicitly would break the profile path for no benefit.
 */
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface AskOptions {
  system: string;
  user: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  /** JSON Schema. When present the response is constrained and parsed. */
  schema?: Record<string, unknown>;
  /** Cache the system prompt — it's identical across every call in a run. */
  cacheSystem?: boolean;
}

/** Free-text completion. Streams, so long drafts don't hit the HTTP timeout. */
export async function ask(opts: AskOptions): Promise<string> {
  const stream = anthropic().messages.stream({
    model: CONFIG.model.id,
    max_tokens: opts.maxTokens ?? CONFIG.model.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? CONFIG.model.draftEffort },
    system: systemBlocks(opts.system, opts.cacheSystem !== false),
    messages: [{ role: 'user', content: opts.user }],
  });

  const message = await stream.finalMessage();
  return textOf(message);
}

/** Structured completion, validated server-side against the supplied schema. */
export async function askJson<T>(opts: AskOptions & { schema: Record<string, unknown> }): Promise<T> {
  const stream = anthropic().messages.stream({
    model: CONFIG.model.id,
    max_tokens: opts.maxTokens ?? CONFIG.model.maxTokens,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: opts.effort ?? CONFIG.model.draftEffort,
      format: { type: 'json_schema', schema: opts.schema },
    },
    system: systemBlocks(opts.system, opts.cacheSystem !== false),
    messages: [{ role: 'user', content: opts.user }],
  });

  const message = await stream.finalMessage();
  const raw = textOf(message);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`model returned unparseable JSON: ${(err as Error).message}\n${raw.slice(0, 800)}`);
  }
}

/**
 * The voice prompt is stable across every call in a run and runs to a few
 * thousand tokens, so it earns a cache breakpoint. Volatile per-prospect context
 * always goes in the user turn, after the breakpoint.
 */
function systemBlocks(system: string, cache: boolean) {
  return [
    {
      type: 'text' as const,
      text: system,
      ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    },
  ];
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
