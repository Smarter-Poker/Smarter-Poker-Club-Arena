/**
 * DAN SECTION 79 (cases 25-27) + SECTIONS 21-26, 61-65 — THE TABLE MUST WAIT.
 *
 * "When an award is reserved, the affected table enters a reveal state. During
 * it: no dealer button move, no next hand, no blinds or antes posted, no player
 * action timers. Only the reveal timeout runs."
 *
 * The gate is checked in `ServerTableEngineDealing.dealingLoop` immediately
 * before `dealHand()`, which is the single place the button advances, the
 * blinds are posted and the first action clock is armed. So all four of those
 * prohibitions are ONE condition, and this file proves that condition holds —
 * including the two ways it could fail dangerously: never opening (a wedged
 * table) and opening early (cards dealt under a live chest).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AWARD_1 = 'award-1';
const AWARD_2 = 'award-2';

afterEach(() => vi.useRealTimers());

const engine = () => new ServerTableEngine(TABLE);

describe('section 79/26 - the dealer button cannot move while a bounty is active', () => {
  it('starts open and closes the moment an award is reserved', () => {
    const e = engine();
    expect(e.hasOpenBountyReveal()).toBe(false);
    e.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    expect(e.hasOpenBountyReveal()).toBe(true);
    expect(e.openBountyRevealCount()).toBe(1);
  });

  it('the dealing loop consults the gate before dealHand, not after', () => {
    // The ORDER is the assertion. A check placed after dealHand() would let a
    // hand start, the button move and the blinds post before anything noticed
    // — which is exactly what sections 21-26 forbid. Read from source because
    // the loop itself is an infinite async function that cannot be unit-run.
    const src = readFileSync(join(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
    const gate = src.indexOf('hasOpenBountyReveal()');
    const deal = src.indexOf('await this.dealHand(');
    expect(gate).toBeGreaterThan(-1);
    expect(deal).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(deal);
    expect(src).toMatch(/setLoopPhase\('mystery_bounty_hold'\)/);
  });
});

describe('section 79/27 - the next hand cannot start with a non-empty queue', () => {
  it('stays closed until EVERY queued award has been released', () => {
    const e = engine();
    e.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    e.beginBountyReveal(AWARD_2, Date.now() + 20_000);
    expect(e.openBountyRevealCount()).toBe(2);

    e.endBountyReveal(AWARD_1);
    // One chest done, one still waiting. The button STILL may not move.
    expect(e.hasOpenBountyReveal()).toBe(true);

    e.endBountyReveal(AWARD_2);
    expect(e.hasOpenBountyReveal()).toBe(false);
  });

  it('releasing an award that never opened is harmless', () => {
    const e = engine();
    e.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    e.endBountyReveal('an-award-from-another-table');
    expect(e.hasOpenBountyReveal()).toBe(true);
  });
});

describe('a re-swept elimination must not shorten or duplicate the hold', () => {
  it('is monotonic - a second reserve of the same award extends, never shrinks', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const e = engine();
    e.beginBountyReveal(AWARD_1, t0 + 20_000);
    e.beginBountyReveal(AWARD_1, t0 + 5_000); // the re-sweep, with a shorter window
    expect(e.openBountyRevealCount()).toBe(1);

    vi.setSystemTime(t0 + 10_000);
    // Had the shorter deadline won, the table would already be dealing.
    expect(e.hasOpenBountyReveal()).toBe(true);

    vi.setSystemTime(t0 + 21_000);
    expect(e.hasOpenBountyReveal()).toBe(false);
  });

  it('the same award opened twice is one hold, not two', () => {
    const e = engine();
    e.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    e.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    expect(e.openBountyRevealCount()).toBe(1);
    e.endBountyReveal(AWARD_1);
    expect(e.hasOpenBountyReveal()).toBe(false);
  });
});

describe('a table can never wedge (section 54)', () => {
  it('expires a hold whose settle path died, and prunes it on read', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const e = engine();
    e.beginBountyReveal(AWARD_1, t0 + 30_000);
    expect(e.hasOpenBountyReveal()).toBe(true);

    // The settle never ran. Nothing calls endBountyReveal. The table must
    // resume on its own rather than sit dark forever.
    vi.setSystemTime(t0 + 30_001);
    expect(e.hasOpenBountyReveal()).toBe(false);
    expect(e.openBountyRevealCount()).toBe(0);
  });

  it('an expired hold does not resurrect when a later award opens', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const e = engine();
    e.beginBountyReveal(AWARD_1, t0 + 10_000);
    vi.setSystemTime(t0 + 10_001);
    e.beginBountyReveal(AWARD_2, t0 + 40_000);
    expect(e.openBountyRevealCount()).toBe(1);
  });
});

describe('section 22 / 61 - only the affected table pauses', () => {
  it('the gate is per-engine, so another table is unaffected', () => {
    const busted = engine();
    const other = new ServerTableEngine('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    busted.beginBountyReveal(AWARD_1, Date.now() + 20_000);
    expect(busted.hasOpenBountyReveal()).toBe(true);
    expect(other.hasOpenBountyReveal()).toBe(false);
  });
});

describe('input hygiene', () => {
  it('ignores an empty award id rather than opening an unreleasable hold', () => {
    const e = engine();
    e.beginBountyReveal('', Date.now() + 20_000);
    e.beginBountyReveal('   ', Date.now() + 20_000);
    expect(e.hasOpenBountyReveal()).toBe(false);
  });
});
