/**
 * Voice linter tests.
 *
 * The linter is what stops agency-speak going out under Josh's name. These
 * fixtures are drawn from the "does NOT sound like" column of his brand voice
 * guide, so a regression here means the agent started sounding like a vendor.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lintVoice, isBlockingFinding, FORBIDDEN_WORDS } from '../src/brain/voice.js';

describe('forbidden words', () => {
  for (const word of ['elevate', 'synergy', 'cutting-edge', 'revolutionize', 'world-class']) {
    test(`flags "${word}"`, () => {
      const findings = lintVoice(`We can ${word} your fleet presence this quarter.`);
      assert.ok(
        findings.some((f) => f.rule === 'forbidden_word'),
        `expected "${word}" to be flagged`,
      );
    });
  }

  test('flags "leverage" as a verb', () => {
    const findings = lintVoice('You can leverage your trucks as rolling billboards.');
    assert.ok(findings.some((f) => f.rule === 'forbidden_word'));
  });

  test('every listed forbidden word is actually detectable', () => {
    for (const word of FORBIDDEN_WORDS) {
      const findings = lintVoice(`Some sentence containing ${word} in it.`);
      assert.ok(
        findings.some((f) => f.rule === 'forbidden_word'),
        `"${word}" is in the list but the linter does not catch it`,
      );
    }
  });
});

describe('style rules', () => {
  test('flags exclamation marks', () => {
    const findings = lintVoice('Great post!');
    assert.ok(findings.some((f) => f.rule === 'exclamation'));
  });

  test('flags emoji', () => {
    const findings = lintVoice('Nice truck 🚚');
    assert.ok(findings.some((f) => f.rule === 'emoji'));
  });

  test('flags the wrong brand name', () => {
    const findings = lintVoice('I run Ikonic Detailing out of Denver.');
    assert.ok(findings.some((f) => f.rule === 'wrong_brand'));
  });

  test('flags spaced em dashes', () => {
    const findings = lintVoice('A wrap pays for itself — eventually.');
    assert.ok(findings.some((f) => f.rule === 'em_dash_spacing'));
  });

  test('flags "just" as a softener', () => {
    const findings = lintVoice('I just wanted to reach out about your fleet.');
    assert.ok(findings.some((f) => f.rule === 'softener'));
  });
});

describe('clean copy', () => {
  test('on-brand writing passes', () => {
    const text =
      "Most wraps that fail in the first two years fail on install prep, not the vinyl. Worth asking whoever quotes you what they do about surface prep before you sign anything.";
    const findings = lintVoice(text);
    assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings)}`);
  });

  test('unspaced em dashes are fine', () => {
    const findings = lintVoice('A wrap done right—prepped properly—lasts five years.');
    assert.equal(findings.length, 0);
  });
});

describe('blocking vs advisory', () => {
  test('banned words, emoji, and wrong brand block a send', () => {
    assert.ok(isBlockingFinding({ rule: 'forbidden_word', detail: '' }));
    assert.ok(isBlockingFinding({ rule: 'emoji', detail: '' }));
    assert.ok(isBlockingFinding({ rule: 'wrong_brand', detail: '' }));
  });

  test('softeners and dash spacing are advisory', () => {
    assert.equal(isBlockingFinding({ rule: 'softener', detail: '' }), false);
    assert.equal(isBlockingFinding({ rule: 'em_dash_spacing', detail: '' }), false);
  });
});
