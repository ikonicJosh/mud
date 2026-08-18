/**
 * The browser session.
 *
 * A persistent Chromium context against a dedicated profile directory. Josh logs
 * in by hand once (`linkedin-agent login`) and the session lives in that profile
 * across runs — no credentials are stored by this tool, and none are asked for.
 *
 * The launch is deliberately vanilla: default Playwright Chromium, no stealth
 * patches, no fingerprint spoofing, no proxy. If LinkedIn decides to look, what
 * it finds is ordinary automation of Josh's own account.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { PATHS, ensureDirs } from '../config/config.js';
import { anyOf, SELECTORS } from './selectors.js';
import { inspectPage, type BreakerTrip } from '../governor/breaker.js';

export interface SessionOptions {
  headless?: boolean;
  /** Slow motion for watching it work during setup. */
  slowMo?: number;
}

let context: BrowserContext | null = null;

/**
 * Point at a specific Chromium build. Set LINKEDIN_AGENT_CHROME_PATH to use a
 * browser Playwright didn't install — a preinstalled Chromium on a build box, or
 * Josh's own Chrome if he'd rather the agent use the browser he already trusts.
 * Unset, Playwright uses its own managed download.
 */
function executablePath(): string | undefined {
  return process.env.LINKEDIN_AGENT_CHROME_PATH || undefined;
}

export async function openSession(opts: SessionOptions = {}): Promise<BrowserContext> {
  if (context) return context;
  ensureDirs();

  // No stealth args. `--disable-blink-features=AutomationControlled` and friends
  // exist purely to hide navigator.webdriver from detection scripts; this build
  // does not conceal what it is.
  context = await chromium.launchPersistentContext(PATHS.chromeProfile, {
    headless: opts.headless ?? true,
    slowMo: opts.slowMo ?? 0,
    viewport: { width: 1440, height: 900 },
    ...(executablePath() ? { executablePath: executablePath() } : {}),
  });

  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(45_000);
  return context;
}

export async function closeSession(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}

export async function newPage(): Promise<Page> {
  const ctx = await openSession();
  const existing = ctx.pages();
  return existing.length > 0 ? existing[0]! : await ctx.newPage();
}

export class SessionDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionDeadError';
  }
}

export class BreakerTrippedError extends Error {
  readonly trip: BreakerTrip;
  constructor(trip: BreakerTrip) {
    super(`circuit breaker: ${trip.reason} — ${trip.detail}`);
    this.name = 'BreakerTrippedError';
    this.trip = trip;
  }
}

/**
 * Navigate, then check the landing page for trouble before anything reads it.
 *
 * Every navigation goes through here. A checkpoint or CAPTCHA trips the breaker
 * and throws, which unwinds the current action rather than letting the caller
 * scrape a login wall and record it as "no results found".
 */
export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await guard(page);
}

/** Inspect the current page for checkpoint/CAPTCHA/login signals. */
export async function guard(page: Page): Promise<void> {
  const url = page.url();
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const trip = inspectPage(url, body);
  if (trip) throw new BreakerTrippedError(trip);
}

/** True when the session is authenticated. */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const marker = await page
    .locator(anyOf(SELECTORS.authMarker))
    .first()
    .isVisible()
    .catch(() => false);
  return marker;
}

/**
 * Assert we're logged in, or fail loudly. Called at the top of every run so a
 * dead session surfaces as one clear error instead of a dozen empty reads.
 */
export async function requireLogin(page: Page): Promise<void> {
  await goto(page, 'https://www.linkedin.com/feed/');
  if (!(await isLoggedIn(page))) {
    throw new SessionDeadError(
      'not logged in — run `npm run agent -- login` and sign in manually, then re-run',
    );
  }
}

/**
 * Interactive login. Opens a headed browser and waits for Josh to sign in,
 * including whatever 2FA his account uses. Nothing is typed by the agent.
 */
export async function interactiveLogin(timeoutMs = 300_000): Promise<boolean> {
  await closeSession();
  const ctx = await chromium.launchPersistentContext(PATHS.chromeProfile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(executablePath() ? { executablePath: executablePath() } : {}),
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.linkedin.com/login');

  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      ok = true;
      break;
    }
    await page.waitForTimeout(2_000);
  }

  // Give the session cookies a moment to flush to the profile directory.
  await page.waitForTimeout(2_000);
  await ctx.close();
  context = null;
  return ok;
}

/** Read the first matching element's trimmed text, or null. */
export async function textOf(page: Page, candidates: readonly string[]): Promise<string | null> {
  const loc = page.locator(anyOf(candidates)).first();
  if (!(await loc.count())) return null;
  const text = await loc.innerText().catch(() => null);
  return text?.trim() || null;
}

/** Human-ish scroll to load lazily-rendered content. */
export async function scrollFeed(page: Page, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 1200 + Math.floor(Math.random() * 600));
    await page.waitForTimeout(800 + Math.floor(Math.random() * 900));
  }
}
