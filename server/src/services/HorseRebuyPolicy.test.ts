/**
 * The rebuy was a reflex, not a decision.
 *
 * Both engine sites sized the reload as `bigBlind * 100` flat - ignoring the
 * table's own limits and the horse's roll entirely - and asked exactly one
 * question first: "have I already rebought twice?" So a horse whose bankroll
 * could no longer support a stake reloaded it anyway, forever, at a stack the
 * table might not even permit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bankrollPolicyFor, bankrollTemperamentFor, rebuyDecision } from './HorseBankroll.js';
import { atRebuyStopLoss, horseRebuyOperationId, legacyRebuyAmount } from './HorseRebuyPolicy.js';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
const POLICY = read('services/HorseRebuyPolicy.ts');
const DEAL = read('engine/ServerTableEngineDealing.ts');
const SETTLE = read('engine/ServerTableEngineSettlement.ts');

const idOf = (t: 'nit' | 'standard' | 'gambler'): string => {
  for (let i = 0; i < 5000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    if (bankrollTemperamentFor(id) === t) return id;
  }
  throw new Error(`no ${t} id found`);
};

describe('rebuyDecision asks WHETHER before it asks how much', () => {
  const rich = {
    bankroll: 1_000_000,
    refBuyIn: 200,
    minBuyIn: 80,
    maxBuyIn: 400,
    desired: 200,
    rebuysTaken: 0,
  };

  it('stands the horse up at its own stop-loss, counted in buy-ins COMMITTED', () => {
    for (const t of ['nit', 'standard', 'gambler'] as const) {
      const p = bankrollPolicyFor(idOf(t));
      // rebuysTaken + 1 is the committed count, so the last permitted reload
      // is stopLossBuyIns - 2.
      expect(rebuyDecision({ ...rich, rebuysTaken: p.stopLossBuyIns - 1, policy: p })).toBe(0);
      expect(
        rebuyDecision({ ...rich, rebuysTaken: p.stopLossBuyIns - 2, policy: p })
      ).toBeGreaterThan(0);
    }
  });

  /**
   * THE OFF-BY-ONE. The standard temperament is six in ten of the fleet and
   * must land in exactly the same place as the hard-coded `>= 2` it replaces,
   * or this is a behaviour change dressed as a refactor. Comparing
   * `rebuysTaken` rather than `rebuysTaken + 1` gives standard a third reload
   * - four buy-ins committed where the old code allowed three.
   */
  it('leaves the standard temperament exactly where the hard-coded >= 2 had it', () => {
    const std = bankrollPolicyFor(idOf('standard'));
    expect(rebuyDecision({ ...rich, rebuysTaken: 1, policy: std })).toBeGreaterThan(0);
    expect(rebuyDecision({ ...rich, rebuysTaken: 2, policy: std })).toBe(0);
    expect(atRebuyStopLoss(idOf('standard'), 1)).toBe(false);
    expect(atRebuyStopLoss(idOf('standard'), 2)).toBe(true);
  });

  it('gives the nit an earlier exit and the gambler a later one', () => {
    expect(atRebuyStopLoss(idOf('nit'), 1)).toBe(true);
    expect(atRebuyStopLoss(idOf('gambler'), 2)).toBe(false);
    expect(atRebuyStopLoss(idOf('gambler'), 3)).toBe(true);
  });

  it('stands the horse up when the roll can no longer carry the stake', () => {
    const std = bankrollPolicyFor(idOf('standard'));
    // 25 buy-ins to sit at a 200 reference is 5,000; 4,000 is not enough.
    expect(rebuyDecision({ ...rich, bankroll: 4000, rebuysTaken: 0, policy: std })).toBe(0);
    expect(rebuyDecision({ ...rich, bankroll: 5000, rebuysTaken: 0, policy: std })).toBeGreaterThan(
      0
    );
  });

  /**
   * An unreadable roll must never stand a horse up. The cost of the two
   * mistakes is not symmetrical: a wrong reload is one buy-in, a wrong
   * stand-up empties a table that had a game in it - which is the shape of
   * the bug that emptied the cash floor on 2026-08-31.
   */
  it('falls through to the flat sizing on a zero reference rather than standing up', () => {
    const std = bankrollPolicyFor(idOf('standard'));
    expect(rebuyDecision({ ...rich, refBuyIn: 0, policy: std })).toBeGreaterThan(0);
  });

  /* A roll that reads as genuinely ZERO is not an unread roll: the horse has
     no chips and standing it up is the correct answer, and the recovery path
     from there is the freeroll queue. The unread case never reaches here -
     HorseRebuyPolicy returns the legacy amount on an ABSENT key, pinned below. */
  it('stands up a roll that is genuinely zero', () => {
    const std = bankrollPolicyFor(idOf('standard'));
    expect(rebuyDecision({ ...rich, bankroll: 0, refBuyIn: 200, policy: std })).toBe(0);
  });

  it('sizes inside the table limits, never the flat bigBlind * 100', () => {
    const gam = bankrollPolicyFor(idOf('gambler'));
    const amount = rebuyDecision({
      ...rich,
      bankroll: 1_000_000,
      minBuyIn: 80,
      maxBuyIn: 300,
      desired: 100_000,
      policy: gam,
    });
    expect(amount).toBeLessThanOrEqual(300);
    expect(amount).toBeGreaterThanOrEqual(80);
  });

  it('caps the reload at the policy share of a modest roll', () => {
    const nit = bankrollPolicyFor(idOf('nit'));
    // 3% of 10,000 is 300; the table would happily take 400.
    const amount = rebuyDecision({
      bankroll: 10_000,
      refBuyIn: 200,
      minBuyIn: 80,
      maxBuyIn: 400,
      desired: 400,
      rebuysTaken: 0,
      policy: nit,
    });
    expect(amount).toBeLessThan(400);
  });

  it('legacy sizing is still the fail-open fallback', () => {
    expect(legacyRebuyAmount(2)).toBe(200);
    expect(legacyRebuyAmount(0)).toBe(200);
  });

  it('atRebuyStopLoss reads the temperament, not a constant', () => {
    const gamId = idOf('gambler');
    const nitId = idOf('nit');
    expect(atRebuyStopLoss(nitId, bankrollPolicyFor(nitId).stopLossBuyIns)).toBe(true);
    expect(atRebuyStopLoss(gamId, bankrollPolicyFor(nitId).stopLossBuyIns)).toBe(false);
  });

  it('names one bust identically across retries and replacement processes', () => {
    const first = horseRebuyOperationId('table-a', 'horse-a', 91);
    expect(first).toBe(horseRebuyOperationId('table-a', 'horse-a', 91));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(horseRebuyOperationId('table-a', 'horse-a', 92));
    expect(first).not.toBe(horseRebuyOperationId('table-a', 'horse-b', 91));
  });
});

describe('WIRING - both engine sites ask, and a zero is a decision to leave', () => {
  it('the module never statically imports the live wallet client', () => {
    /* `./supabase/wallets.js` aborts the process when
       SUPABASE_SERVICE_ROLE_KEY is unset, so a static import would make
       merely LOADING this module a database dependency and the pure decision
       functions beside it untestable without production secrets. */
    expect(POLICY).toMatch(/await import\('\.\/supabase\/wallets\.js'\)/);
    expect(POLICY).not.toMatch(/^import .*supabase\/wallets\.js/m);
  });

  it('an unreadable balance returns the legacy amount, never zero', () => {
    expect(POLICY).toMatch(/if \(roll === undefined\) return legacy;/);
    expect(POLICY).toMatch(/\} catch \{\s*return legacy;/);
    expect(POLICY).toMatch(/if \(!clubId \|\| !userId\) return legacy;/);
  });

  for (const [name, SRC] of [
    ['dealing', DEAL],
    ['settlement', SETTLE],
  ] as const) {
    it(`the ${name} site asks the policy instead of sizing flat`, () => {
      expect(SRC).toMatch(/const rebuyAmount = await horseRebuyAmount\(\{/);
      expect(SRC).not.toMatch(
        /const rebuyAmount = this\.tableInfo\?\.big_blind \? this\.tableInfo\.big_blind \* 100 : 200;/
      );
    });

    it(`the ${name} site distinguishes a refusal from a deferred transaction`, () => {
      expect(SRC).toMatch(/const outcome =\s*rebuyAmount > 0\s*\?/);
      expect(SRC).toMatch(/horseRebuyOperationId\(this\.tableId, horse\.user_id,/);
      expect(SRC).toMatch(/if \(outcome === 'deferred'\) return;/);
      expect(SRC).toMatch(/if \(outcome === 'funded'\) \{/);
    });

    it(`the ${name} site passes the table's own limits, not just the blind`, () => {
      expect(SRC).toMatch(
        /minBuyIn: this\.tableInfo\?\.min_buy_in as number \| null \| undefined,/
      );
      expect(SRC).toMatch(
        /maxBuyIn: this\.tableInfo\?\.max_buy_in as number \| null \| undefined,/
      );
      expect(SRC).toMatch(/rebuysTaken: currentRebuys,/);
    });
  }

  it('the settlement stop-loss reads the temperament, not >= 2', () => {
    expect(SETTLE).toMatch(/if \(atRebuyStopLoss\(horse\.user_id, currentRebuys\)\) \{/);
    expect(SETTLE).not.toMatch(/if \(currentRebuys >= 2\) \{/);
  });

  /**
   * TIMING IS PART OF THE TREATMENT (CLAUDE.md 10.5). The five-second rebuy
   * window and the pauses around it are upstream of this call and must stay
   * exactly as they are; this decides only the answer given inside the window.
   */
  it('adds no delay of its own to the rebuy path', () => {
    expect(POLICY).not.toMatch(/setTimeout|sleep\(|delay\(/);
  });
});
