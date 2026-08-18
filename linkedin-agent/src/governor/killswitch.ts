/**
 * The kill switch.
 *
 * `touch linkedin-agent/PAUSE` stops the agent inside one action. It is a file
 * rather than a config flag or a signal on purpose: Josh can stop this thing from
 * his phone over SSH, from Finder, or from a script, without knowing anything
 * about how it works, and it survives a crash and restart.
 */

import fs from 'node:fs';
import { PATHS } from '../config/config.js';

export function isPaused(): boolean {
  return fs.existsSync(PATHS.pause);
}

export function pause(reason: string): void {
  fs.writeFileSync(PATHS.pause, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
}

export function resume(): void {
  if (fs.existsSync(PATHS.pause)) fs.unlinkSync(PATHS.pause);
}

export function pauseReason(): string | null {
  if (!isPaused()) return null;
  try {
    return fs.readFileSync(PATHS.pause, 'utf8').trim();
  } catch {
    return 'paused (reason unreadable)';
  }
}

/** Thrown to unwind the run loop immediately when the switch flips mid-run. */
export class PausedError extends Error {
  constructor(reason: string) {
    super(`agent paused: ${reason}`);
    this.name = 'PausedError';
  }
}

export function assertNotPaused(): void {
  if (isPaused()) throw new PausedError(pauseReason() ?? 'unknown');
}
