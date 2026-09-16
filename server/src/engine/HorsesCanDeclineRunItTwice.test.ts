/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE CAN DECLINE RUN IT TWICE - AND INSURANCE DEPENDS ON IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * scheduleHorseRITResponses answered the run-it-twice offer with a constant:
 * a horse chooser picked 2 or 3 every time, a horse responder sent 'accept'
 * every time. There was no branch in the code that could produce anything
 * else.
 *
 * checkAllInRunout asks the RIT question FIRST and reaches startInsuranceFlow
 * only on the single-run branch. All 27 live cash tables run both features.
 * So a horse that could not decline made insurance unreachable everywhere:
 * 270 hands in 24h met every precondition for an offer, and
 * insurance_offer_events recorded zero. The only rows that table has ever
 * held came from four hand-built INSURANCE test tables, all now closed.
 *
 * These tests pin the two things that keep it fixed: the verdict is not a
 * constant, and both response sites read it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, 'ServerTableEngineRunout.ts'), 'utf8');

/** The verdict, reimplemented exactly, so the distribution can be measured
 *  without standing up an engine. Pinned against the source below. */
function verdict(playerId: string, handCount: number): 'once' | 'multi' {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) {
    h = (h * 31 + playerId.charCodeAt(i)) % 100000;
  }
  return (h + handCount * 7) % 10 < 3 ? 'once' : 'multi';
}

describe('a horse can decline run it twice', () => {
  it('the verdict function exists and both branches are reachable', () => {
    expect(SRC).toContain("protected horseRitVerdict(playerId: string): 'once' | 'multi'");
    // The exact body, so the reimplementation above stays honest.
    expect(SRC).toContain('h = (h * 31 + playerId.charCodeAt(i)) % 100000;');
    expect(SRC).toContain("return (h + this.handCount * 7) % 10 < 3 ? 'once' : 'multi';");
  });

  it('the chooser can pick one board', () => {
    expect(SRC).toContain("this.horseRitVerdict(chooserPlayerId) === 'once'");
    expect(SRC).toContain('? (1 as const)');
  });

  it('the responder can decline', () => {
    expect(SRC).toContain(
      "const answer = this.horseRitVerdict(pid) === 'once' ? 'decline' : 'accept';"
    );
    expect(SRC).toContain('this.respondToRIT(pid, answer);');
    // The old constant must be gone. A bare accept here is the regression.
    expect(SRC).not.toContain("this.respondToRIT(pid, 'accept');");
  });

  it('is not a constant: both answers appear across hands for one horse', () => {
    const id = '7c9f3b21-4d5e-4a10-9b83-2f6e1d0c8a44';
    const answers = new Set<string>();
    for (let hand = 1; hand <= 40; hand++) answers.add(verdict(id, hand));
    expect([...answers].sort()).toEqual(['multi', 'once']);
  });

  it('is not a constant: both answers appear across horses in one hand', () => {
    const answers = new Set<string>();
    for (let i = 0; i < 40; i++) answers.add(verdict('horse-' + i + '-seat', 12));
    expect([...answers].sort()).toEqual(['multi', 'once']);
  });

  it('declines often enough to unblock insurance, rarely enough to keep RIT normal', () => {
    let once = 0;
    let total = 0;
    for (let i = 0; i < 500; i++) {
      for (let hand = 1; hand <= 20; hand++) {
        total++;
        if (verdict('horse-' + i + '-abcdef', hand) === 'once') once++;
      }
    }
    const rate = once / total;
    // Three in ten by construction; the band leaves room for the id mix.
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.45);
  });

  it('is deterministic: the same hand replays to the same answer', () => {
    const id = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
    for (let hand = 1; hand <= 25; hand++) {
      expect(verdict(id, hand)).toBe(verdict(id, hand));
    }
  });

  it('the single-run branch still hands off to insurance', () => {
    // The whole point of letting a horse decline. If this ordering is ever
    // removed, declining buys nothing.
    expect(SRC).toContain("this.emitRitSingleRun('no_agreement');");
    expect(SRC).toContain('if (insuranceEnabled && allInPlayers.length >= 2) {');
    expect(SRC).toContain('startInsuranceFlow();');
  });
});
