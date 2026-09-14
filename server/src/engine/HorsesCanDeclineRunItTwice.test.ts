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

/**
 * AND WHEN A HORSE ANSWERS IS NOT A CONSTANT EITHER (2026-09-13).
 *
 * The answer stopped being a tell on 2026-08-31; the latency still was. A
 * horse chooser answered inside 1.2-2.2s and a horse responder inside
 * 2.5-3.7s, every hand, against a 25-second window humans use all of.
 * horseRitThinkMs spreads the answer across that window deterministically.
 */
function thinkMs(playerId: string, handCount: number, role: 'chooser' | 'responder'): number {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) {
    h = (h * 33 + playerId.charCodeAt(i) + 7) % 1000003;
  }
  const mixed = (h + handCount * 131 + (role === 'responder' ? 17 : 0)) % 1000;
  const longThink = mixed % 6 === 0;
  const base = role === 'responder' ? 1500 : 1200;
  if (longThink) return 10_000 + Math.floor((mixed / 1000) * 9_000);
  return base + Math.floor((mixed / 1000) * 7_500);
}

describe('a horse does not always answer run it twice in the same three seconds', () => {
  it('both response sites read the think time, and the old fixed bands are gone', () => {
    expect(SRC).toContain("respond(this.horseRitThinkMs(chooserPlayerId, 'chooser')");
    expect(SRC).toContain("respond(this.horseRitThinkMs(pid, 'responder')");
    expect(SRC).not.toContain('respond(1200 + (this.handCount % 5) * 240');
    expect(SRC).not.toContain('respond(2500 + ((pid.charCodeAt(0) + this.handCount) % 4) * 400');
    // The exact body, so the reimplementation above stays honest.
    expect(SRC).toContain('h = (h * 33 + playerId.charCodeAt(i) + 7) % 1000003;');
    expect(SRC).toContain(
      "const mixed = (h + this.handCount * 131 + (role === 'responder' ? 17 : 0)) % 1000;"
    );
    expect(SRC).toContain('return 10_000 + Math.floor((mixed / 1000) * 9_000);');
    expect(SRC).toContain('return base + Math.floor((mixed / 1000) * 7_500);');
  });

  it('spreads across the window: fast taps, ordinary thinks and long thinks all occur', () => {
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      for (let hand = 1; hand <= 10; hand++) {
        samples.push(thinkMs('horse-' + i + '-seat-uuid', hand, 'responder'));
        samples.push(thinkMs('horse-' + i + '-seat-uuid', hand, 'chooser'));
      }
    }
    samples.sort((a, b) => a - b);
    const p10 = samples[Math.floor(samples.length * 0.1)];
    const p90 = samples[Math.floor(samples.length * 0.9)];
    expect(samples[0]).toBeGreaterThanOrEqual(1200);
    // Never inside the DeadlineScheduler's discard: 20s of the 25s window.
    expect(samples[samples.length - 1]).toBeLessThanOrEqual(20_000);
    // A band a few seconds wide is the tell this replaces.
    expect(p90 - p10).toBeGreaterThan(5_000);
    const fast = samples.filter((s) => s < 4_000).length / samples.length;
    const long = samples.filter((s) => s >= 10_000).length / samples.length;
    expect(fast).toBeGreaterThan(0.15);
    expect(long).toBeGreaterThan(0.08);
    expect(long).toBeLessThan(0.3);
  });

  it('is deterministic: the same hand replays to the same moment', () => {
    for (let hand = 1; hand <= 25; hand++) {
      expect(thinkMs('aa11bb22-cc33', hand, 'chooser')).toBe(
        thinkMs('aa11bb22-cc33', hand, 'chooser')
      );
    }
  });

  it('varies hand to hand for one horse', () => {
    const seen = new Set<number>();
    for (let hand = 1; hand <= 30; hand++) seen.add(thinkMs('7c9f3b21-4d5e', hand, 'responder'));
    expect(seen.size).toBeGreaterThan(10);
  });
});
