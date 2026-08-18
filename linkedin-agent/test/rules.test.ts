/**
 * Rule engine tests.
 *
 * These are the guardrails Josh asked for, so they get adversarial fixtures
 * rather than happy-path ones: the tests that matter are the ones where a
 * plausible-looking draft should NOT go out.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, extractDollarAmounts, type RuleContext } from '../src/governor/rules.js';
import type { DraftedAction, Prospect } from '../src/types.js';

const NOW = new Date('2026-03-10T15:00:00Z');

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: 1,
    publicId: 'jane-smith-hvac',
    profileUrl: 'https://www.linkedin.com/in/jane-smith-hvac/',
    fullName: 'Jane Smith',
    headline: 'Owner at Smith Heating & Air',
    company: 'Smith Heating & Air',
    companyDomain: null,
    location: 'Denver, CO',
    industry: 'HVAC',
    fleetSize: 6,
    employeeCount: 20,
    source: 'clay_import',
    score: 62,
    scoreRationale: null,
    state: 'connected',
    excludedReason: null,
    ghlContactId: null,
    ghlOpportunityId: null,
    createdAt: '2026-03-01 10:00:00',
    updatedAt: '2026-03-01 10:00:00',
    ...overrides,
  };
}

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    prospect: prospect(),
    threadClassification: null,
    lastMessageAt: null,
    lastCommentAt: null,
    now: NOW,
    ...overrides,
  };
}

function message(body: string, hook = 'they asked about their van fleet'): DraftedAction {
  return { actionType: 'message', prospectId: 1, targetUrl: null, body, hook };
}

describe('meeting commitments', () => {
  const cases = [
    'Tuesday at 2 works for me, see you then.',
    "I've booked you in for Thursday.",
    "Let's do Wednesday afternoon.",
    'Sending the calendar invite over now.',
    '3pm works, confirmed.',
  ];

  for (const body of cases) {
    test(`escalates: "${body}"`, () => {
      const v = evaluate(message(body), ctx());
      assert.equal(v.action, 'escalate', `expected escalation for: ${body}`);
      assert.equal(v.escalationReason, 'meeting_request');
    });
  }

  test('allows floating availability without committing', () => {
    const v = evaluate(
      message("Happy to talk it through — what does your week look like?"),
      ctx(),
    );
    assert.equal(v.action, 'allow');
  });
});

describe('pricing', () => {
  test('allows the published wrap range', () => {
    const v = evaluate(
      message('Full van wraps generally land in the $3K–$5.2K range depending on coverage.'),
      ctx(),
    );
    assert.equal(v.action, 'allow');
  });

  test('escalates a specific quote outside the published figures', () => {
    const v = evaluate(message('I can do your three vans for $7,400 all in.'), ctx());
    assert.equal(v.action, 'escalate');
    assert.equal(v.escalationReason, 'pricing_request');
  });

  test('escalates discount language even with no number', () => {
    const v = evaluate(message('I could knock off a bit if you book this month.'), ctx());
    assert.equal(v.action, 'escalate');
    assert.equal(v.escalationReason, 'pricing_request');
  });

  test('escalates a commitment phrased around a published number', () => {
    const v = evaluate(message('I can do it for $3K, locked in.'), ctx());
    assert.equal(v.action, 'escalate');
  });

  test('normalises $3K and $3,000 to the same figure', () => {
    assert.deepEqual(extractDollarAmounts('$3K'), [3000]);
    assert.deepEqual(extractDollarAmounts('$3,000'), [3000]);
    assert.deepEqual(extractDollarAmounts('$497 / $797'), [497, 797]);
  });
});

describe('negative and client threads', () => {
  test('blocks a thread classified as client', () => {
    const v = evaluate(message('Good to hear from you'), ctx({ threadClassification: 'client' }));
    assert.equal(v.action, 'block');
    assert.equal(v.rule, 'known_client');
  });

  test('escalates a thread classified negative', () => {
    const v = evaluate(message('Sorry to hear that'), ctx({ threadClassification: 'negative' }));
    assert.equal(v.action, 'escalate');
    assert.equal(v.escalationReason, 'negative_thread');
  });

  test('catches complaint language the classifier may have missed', () => {
    const v = evaluate(message("I'll pass this to our attorney to review."), ctx());
    assert.equal(v.action, 'escalate');
    assert.equal(v.escalationReason, 'negative_thread');
  });

  test('catches an opt-out request', () => {
    const v = evaluate(message('Understood, stop messaging me.'), ctx());
    assert.equal(v.action, 'escalate');
  });

  test('blocks any action against an excluded prospect', () => {
    const v = evaluate(
      message('hello'),
      ctx({ prospect: prospect({ state: 'excluded', excludedReason: 'existing client' }) }),
    );
    assert.equal(v.action, 'block');
    assert.equal(v.rule, 'excluded_prospect');
  });
});

describe('cooldowns', () => {
  test('blocks a second message inside 7 days', () => {
    const v = evaluate(message('following up'), ctx({ lastMessageAt: '2026-03-08 09:00:00' }));
    assert.equal(v.action, 'block');
    assert.equal(v.rule, 'message_cooldown');
  });

  test('allows a message after the cooldown', () => {
    const v = evaluate(message('following up'), ctx({ lastMessageAt: '2026-02-20 09:00:00' }));
    assert.equal(v.action, 'allow');
  });

  test('blocks a second comment inside 14 days', () => {
    const action: DraftedAction = {
      actionType: 'comment',
      prospectId: 1,
      targetUrl: 'https://linkedin.com/feed/update/x',
      body: 'good point about condenser sizing',
      hook: 'their post on condenser sizing',
    };
    const v = evaluate(action, ctx({ lastCommentAt: '2026-03-05 09:00:00' }));
    assert.equal(v.action, 'block');
    assert.equal(v.rule, 'comment_cooldown');
  });
});

describe('hook requirement', () => {
  test('blocks a draft with no concrete hook', () => {
    const v = evaluate({ ...message('Hi there, hope business is going well!'), hook: '' }, ctx());
    assert.equal(v.action, 'block');
    assert.equal(v.rule, 'no_hook');
  });

  test('a like needs no hook of its own', () => {
    const v = evaluate(
      { actionType: 'like', prospectId: 1, targetUrl: 'https://x', body: null, hook: '' },
      ctx(),
    );
    assert.equal(v.action, 'allow');
  });
});
