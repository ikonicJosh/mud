#!/usr/bin/env node
/**
 * Command line interface.
 *
 * `status` and `brief` are the two Josh will actually use day to day. Everything
 * else exists so a stage can be run, inspected, and trusted on its own before it
 * gets folded into the scheduled run.
 */

import { Command } from 'commander';
import { CONFIG, PATHS } from './config/config.js';
import { ALL_STAGES, run, type Stage } from './run.js';
import { buildBrief } from './report/brief.js';
import { isPaused, pause, pauseReason, resume } from './governor/killswitch.js';
import { isTripped, reset as resetBreaker } from './governor/breaker.js';
import { dailyWriteBudget, effectiveCaps, rampWeek } from './governor/ramp.js';
import { canActNow } from './governor/pacing.js';
import { countByState } from './memory/prospects.js';
import { openEscalations, recentActions, resolveEscalation } from './memory/audit.js';
import { interactiveLogin, closeSession } from './browser/session.js';
import { ghlConfigured } from './crm/ghl.js';
import { ACTION_TYPES } from './types.js';

const program = new Command();

program
  .name('linkedin-agent')
  .description('Autonomous LinkedIn prospecting agent for Ikonic')
  .version('0.1.0');

program
  .command('login')
  .description('Open a browser so you can sign in to LinkedIn once. Nothing is typed for you.')
  .action(async () => {
    console.log('Opening a browser. Sign in, finish any 2FA, then leave it — it closes on its own.');
    const ok = await interactiveLogin();
    console.log(ok ? 'Signed in. Session saved to the agent profile.' : 'Timed out without a session.');
    process.exit(ok ? 0 : 1);
  });

program
  .command('run')
  .description('Run one pass')
  .option('-s, --stages <list>', `comma-separated: ${ALL_STAGES.join(',')}`)
  .option('-n, --limit <n>', 'max items per stage', '10')
  .option('--dry-run', 'evaluate and draft everything, execute nothing')
  .action(async (opts: { stages?: string; limit: string; dryRun?: boolean }) => {
    const stages = opts.stages
      ? (opts.stages.split(',').map((s) => s.trim()) as Stage[])
      : undefined;

    const bad = stages?.filter((s) => !ALL_STAGES.includes(s));
    if (bad?.length) {
      console.error(`unknown stage(s): ${bad.join(', ')}`);
      process.exit(1);
    }

    const report = await run({
      stages,
      limit: Number(opts.limit),
      dryRun: Boolean(opts.dryRun),
    });

    console.log('\n--- run report ---');
    console.log(JSON.stringify(report, null, 2));
    await closeSession().catch(() => undefined);
    process.exit(report.halted ? 1 : 0);
  });

program
  .command('dry-run')
  .description('Full pipeline, drafting everything and sending nothing')
  .option('-n, --limit <n>', 'max items per stage', '5')
  .action(async (opts: { limit: string }) => {
    const report = await run({ dryRun: true, limit: Number(opts.limit) });
    console.log('\n--- dry run ---');
    console.log(JSON.stringify(report, null, 2));
    await closeSession().catch(() => undefined);
  });

program
  .command('status')
  .description('What the agent is doing, what it may do, and what is stopping it')
  .action(() => {
    const now = new Date();
    const tripped = isTripped();

    console.log('=== linkedin-agent status ===\n');

    if (tripped) {
      console.log(`STOPPED — circuit breaker: ${tripped.reason}`);
      console.log(`  ${tripped.detail}`);
      console.log(`  tripped at ${tripped.at}\n`);
    } else if (isPaused()) {
      console.log(`PAUSED — ${pauseReason()}\n`);
    } else {
      console.log('Running.\n');
    }

    console.log(`Writes enabled:  ${CONFIG.writesEnabled ? 'yes' : 'no'}`);
    console.log(
      `Write actions:   ${CONFIG.enabledWriteActions.length ? CONFIG.enabledWriteActions.join(', ') : 'none'}`,
    );
    const timing = canActNow(now);
    console.log(`Timing:          ${timing.ok ? 'in window' : `holding — ${timing.reason}`}`);
    console.log(`Ramp week:       ${rampWeek(now)}${CONFIG.skipRamp ? ' (ramp disabled)' : ''}`);
    console.log(`Daily budget:    ${dailyWriteBudget(now)} writes\n`);

    console.log('Caps today:');
    for (const t of ACTION_TYPES) {
      const c = effectiveCaps(t, now);
      console.log(`  ${t.padEnd(14)} ${String(c.daily).padStart(3)}/day  ${String(c.weekly).padStart(3)}/week`);
    }

    console.log('\nPipeline:');
    const states = countByState();
    if (Object.keys(states).length === 0) {
      console.log('  (empty)');
    } else {
      for (const [state, n] of Object.entries(states)) {
        console.log(`  ${state.padEnd(14)} ${n}`);
      }
    }

    const open = openEscalations(100);
    console.log(`\nWaiting on you:  ${open.length}`);
    console.log(`GHL sync:        ${ghlConfigured() ? 'configured' : 'not configured (GHL_API_KEY unset)'}`);
    console.log(`Data:            ${PATHS.data}`);
  });

program
  .command('review')
  .description('Everything the agent escalated instead of handling')
  .option('--resolve <id>', 'mark one resolved')
  .action((opts: { resolve?: string }) => {
    if (opts.resolve) {
      resolveEscalation(Number(opts.resolve));
      console.log(`resolved #${opts.resolve}`);
      return;
    }
    const items = openEscalations(50);
    if (items.length === 0) {
      console.log('Nothing waiting.');
      return;
    }
    for (const e of items) {
      console.log(`\n#${e.id} [${e.reason}] ${e.createdAt}`);
      console.log(`  ${e.detail}`);
      if (e.targetUrl) console.log(`  ${e.targetUrl}`);
      if (e.draft) console.log(`  draft: ${e.draft}`);
    }
    console.log(`\n${items.length} open. Resolve with: linkedin-agent review --resolve <id>`);
  });

program
  .command('brief')
  .description("Today's brief")
  .action(() => {
    console.log(buildBrief());
  });

program
  .command('log')
  .description('Recent actions from the audit log')
  .option('-n, --limit <n>', 'how many', '30')
  .action((opts: { limit: string }) => {
    const rows = recentActions(Number(opts.limit));
    for (const r of rows.reverse()) {
      const target = r.targetUrl ? ` ${r.targetUrl}` : '';
      console.log(`${r.occurredAt}  ${r.outcome.padEnd(8)} ${r.actionType.padEnd(13)}${target}`);
      if (r.decision !== 'allow') console.log(`    ${r.decision}: ${r.decisionReason}`);
      if (r.error) console.log(`    error: ${r.error}`);
      if (r.draft) console.log(`    "${r.draft.replace(/\s+/g, ' ').slice(0, 160)}"`);
    }
  });

program
  .command('pause')
  .description('Stop everything')
  .argument('[reason]', 'why', 'paused by hand')
  .action((reason: string) => {
    pause(reason);
    console.log(`Paused: ${reason}`);
    console.log(`Kill switch file: ${PATHS.pause}`);
  });

program
  .command('resume')
  .description('Clear the kill switch')
  .option('--reset-breaker', 'also clear a tripped circuit breaker')
  .action((opts: { resetBreaker?: boolean }) => {
    const tripped = isTripped();
    if (tripped && !opts.resetBreaker) {
      console.error(`Circuit breaker is tripped (${tripped.reason}): ${tripped.detail}`);
      console.error('Look at the account in a browser first, then: resume --reset-breaker');
      process.exit(1);
    }
    if (opts.resetBreaker) resetBreaker();
    resume();
    console.log('Resumed.');
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
