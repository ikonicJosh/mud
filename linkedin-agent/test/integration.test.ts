/**
 * End-to-end governor tests against a real database.
 *
 * This is the test that would catch the worst class of bug in this system: an
 * action executing when it shouldn't have. It exercises the actual decision path
 * — kill switch, write flags, rules, caps — rather than the pieces in isolation.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { useDatabase, closeDatabase, db } from '../src/memory/db.js';
import { upsertProspect, transition, findByPublicId, exclude } from '../src/memory/prospects.js';
import { recordInteraction, openEscalations, countActionsSince } from '../src/memory/audit.js';
import { request, settle, startOfDay } from '../src/governor/index.js';
import { pause, resume } from '../src/governor/killswitch.js';
import { CONFIG } from '../src/config/config.js';
import type { DraftedAction } from '../src/types.js';

let tmpDir: string;
const NOW = new Date(2026, 2, 10, 11, 0, 0); // Tuesday, mid-morning

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-agent-int-'));
  useDatabase(path.join(tmpDir, 'test.db'));
});

after(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db().exec('DELETE FROM actions; DELETE FROM interactions; DELETE FROM escalations; DELETE FROM prospects;');
  // A PAUSE file left behind by a crashed test would silently block every
  // assertion below, so clear it rather than debug it later.
  resume();
  // Default posture for these tests: writes on, all four types enabled.
  CONFIG.writesEnabled = true;
  CONFIG.enabledWriteActions = ['like', 'comment', 'connect', 'message'];
  CONFIG.skipRamp = true; // exercise target caps, not ramped ones
});

function makeProspect(publicId = 'jane-smith-hvac') {
  const p = upsertProspect({
    publicId,
    profileUrl: `https://www.linkedin.com/in/${publicId}/`,
    fullName: 'Jane Smith',
    headline: 'Owner at Smith Heating & Air',
    company: 'Smith Heating & Air',
    source: 'clay_import',
  });
  transition(p.id, 'scored');
  transition(p.id, 'engaged');
  return findByPublicId(publicId)!;
}

function comment(body = 'Worth asking what prep they do before quoting.', hook = 'their post'): DraftedAction {
  return {
    actionType: 'comment',
    prospectId: null,
    targetUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
    body,
    hook,
  };
}

describe('write gating', () => {
  test('blocks every write when writes are disabled', () => {
    CONFIG.writesEnabled = false;
    const p = makeProspect();
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /writes disabled/);
  });

  test('blocks an action type not yet enabled for this phase', () => {
    CONFIG.enabledWriteActions = ['like']; // phase 3, likes only
    const p = makeProspect();
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /not in enabledWriteActions/);
  });

  test('allows an enabled action type', () => {
    const p = makeProspect();
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });
    assert.equal(d.decision, 'allow');
  });
});

describe('audit trail', () => {
  test('a blocked action is still recorded with its draft', () => {
    CONFIG.writesEnabled = false;
    const p = makeProspect();
    const draft = 'this text should survive the block';
    request({ ...comment(draft), prospectId: p.id }, { prospect: p, now: NOW });

    const rows = db().prepare('SELECT * FROM actions').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'blocked');
    assert.equal(rows[0]!.draft, draft);
  });

  test('an allowed action is not counted until it settles', () => {
    const p = makeProspect();
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });

    // Before settle: not counted, so a crash mid-action cannot inflate caps.
    assert.equal(countActionsSince('comment', startOfDay(NOW)), 0);

    settle(d.auditId, 'success');
    assert.equal(countActionsSince('comment', startOfDay(NOW)), 1);
  });

  test('a failed action does not count against the cap', () => {
    const p = makeProspect();
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });
    settle(d.auditId, 'failed', 'comment box not found');
    assert.equal(countActionsSince('comment', startOfDay(NOW)), 0);
  });
});

describe('caps', () => {
  test('defers once the daily cap is spent', () => {
    const p = makeProspect();
    let allowed = 0;

    // Push well past the cap; the governor should stop allowing partway through.
    for (let i = 0; i < 40; i++) {
      const d = request(
        { ...comment(`draft ${i}`), prospectId: p.id },
        { prospect: p, now: NOW },
      );
      if (d.decision === 'allow') {
        allowed += 1;
        settle(d.auditId, 'success');
      }
    }

    assert.ok(allowed > 0, 'should have allowed at least one');
    assert.ok(allowed < 40, `should have stopped before 40, allowed ${allowed}`);

    const last = request({ ...comment('one more'), prospectId: p.id }, { prospect: p, now: NOW });
    assert.equal(last.decision, 'defer');
  });
});

describe('guardrails end to end', () => {
  test('an excluded client is blocked and nothing is sent', () => {
    const p = makeProspect();
    exclude(p.id, 'existing GHL client');
    const fresh = findByPublicId(p.publicId)!;

    const d = request({ ...comment(), prospectId: fresh.id }, { prospect: fresh, now: NOW });
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /excluded/);
  });

  test('a pricing commitment is blocked and lands in the review queue', () => {
    const p = makeProspect();
    const d = request(
      {
        actionType: 'message',
        prospectId: p.id,
        targetUrl: 'https://www.linkedin.com/messaging/thread/1/',
        body: 'I can do all three vans for $7,400.',
        hook: 'they asked what three vans would run',
      },
      { prospect: p, now: NOW },
    );

    assert.equal(d.decision, 'block');
    const queue = openEscalations();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.reason, 'pricing_request');
    // The draft is preserved so Josh can send it himself if he wants to.
    assert.match(queue[0]!.draft ?? '', /7,400/);
  });

  test('a meeting confirmation is blocked and escalated', () => {
    const p = makeProspect();
    const d = request(
      {
        actionType: 'message',
        prospectId: p.id,
        targetUrl: 'https://www.linkedin.com/messaging/thread/1/',
        body: 'Thursday at 10 works for me, see you then.',
        hook: 'they proposed Thursday',
      },
      { prospect: p, now: NOW },
    );
    assert.equal(d.decision, 'block');
    assert.equal(openEscalations()[0]!.reason, 'meeting_request');
  });

  test('the 7-day message cooldown holds across a real interaction record', () => {
    const p = makeProspect();
    recordInteraction({
      prospectId: p.id,
      direction: 'outbound',
      actionType: 'message',
      body: 'first touch',
      occurredAt: isoForSqlite(new Date(NOW.getTime() - 2 * 86_400_000)),
    });

    const d = request(
      {
        actionType: 'message',
        prospectId: p.id,
        targetUrl: null,
        body: 'circling back',
        hook: 'their fleet',
      },
      { prospect: p, now: NOW },
    );
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /message_cooldown/);
  });

  test('replies to inbound bypass caps but not the rules', () => {
    const p = makeProspect();

    // Spend the entire message budget.
    for (let i = 0; i < 30; i++) {
      const d = request(
        { actionType: 'message', prospectId: null, targetUrl: null, body: `x${i}`, hook: 'h' },
        { prospect: null, now: NOW },
      );
      if (d.decision === 'allow') settle(d.auditId, 'success');
    }

    // An inbound reply still gets through...
    const reply = request(
      {
        actionType: 'message',
        prospectId: p.id,
        targetUrl: null,
        body: 'Happy to talk it through — what does your week look like?',
        hook: 'they asked about turnaround',
      },
      { prospect: p, isReplyToInbound: true, now: NOW },
    );
    assert.equal(reply.decision, 'allow');

    // ...but a rule violation in an inbound reply is still blocked.
    const bad = request(
      {
        actionType: 'message',
        prospectId: p.id,
        targetUrl: null,
        body: 'Friday at 2 works for me, see you then.',
        hook: 'they proposed Friday',
      },
      { prospect: p, isReplyToInbound: true, now: NOW },
    );
    assert.equal(bad.decision, 'block');
  });
});

describe('kill switch', () => {
  test('blocks everything while the PAUSE file exists, and releases when removed', () => {
    const p = makeProspect();

    // Sanity: allowed before the switch flips.
    assert.equal(
      request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW }).decision,
      'allow',
    );

    pause('test halt');
    try {
      const during = request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW });
      assert.equal(during.decision, 'block');
      assert.match(during.reason, /kill switch/);
    } finally {
      resume();
    }

    assert.equal(
      request({ ...comment(), prospectId: p.id }, { prospect: p, now: NOW }).decision,
      'allow',
    );
  });

  test('the halt is visible in the audit log afterwards', () => {
    const p = makeProspect();
    pause('test halt');
    try {
      request({ ...comment('held back'), prospectId: p.id }, { prospect: p, now: NOW });
    } finally {
      resume();
    }

    const rows = db()
      .prepare("SELECT * FROM actions WHERE outcome = 'blocked'")
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.decision_reason), /kill switch/);
  });
});

describe('timing', () => {
  test('defers outside working hours', () => {
    const p = makeProspect();
    const night = new Date(2026, 2, 10, 23, 0, 0);
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: night });
    assert.equal(d.decision, 'defer');
    assert.match(d.reason, /working hours/);
  });

  test('defers on a quiet day', () => {
    const p = makeProspect();
    const sunday = new Date(2026, 2, 8, 11, 0, 0);
    const d = request({ ...comment(), prospectId: p.id }, { prospect: p, now: sunday });
    assert.equal(d.decision, 'defer');
    assert.match(d.reason, /quiet day/);
  });
});

/** SQLite stores timestamps as UTC "YYYY-MM-DD HH:MM:SS". */
function isoForSqlite(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
