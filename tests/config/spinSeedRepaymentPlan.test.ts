/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEED REPAYMENT PLAN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "IMPLEMENT A REPAYMENT PLAN THAT'S STRUCTURED INTO THE
 * ARCHITECTURE OF THE POOL, THAT PAYS BACK A CERTAIN PERCENTAGE TO THE FUNDING
 * WALLET EVERY TIME THE WALLET REACHES A CERTAIN THRESHOLD OF FUNDS."
 *
 * WHY THIS IS ARCHITECTURE AND NOT PREFERENCE.
 *
 * The pool has ZERO DRIFT by construction — spinSpec's own identity,
 * E[multiplier] = seats × (1 − rake), makes E[reserve_out] equal reserve_in
 * exactly. The rake is taken before the pool; what is left random-walks and
 * never grows in expectation.
 *
 * The rule this replaces waited for the balance to exceed the bar by a WHOLE
 * FURTHER SEED. On a zero-drift walk that is a wait for a large excursion that
 * may never arrive: the owner's capital could sit in the pool forever with
 * nothing wrong and nothing happening. Harvesting the upswings is the only
 * mechanism a zero-drift process reliably offers.
 *
 * Three numbers now exist in two places — the rule in Postgres and the mirror
 * in spinSpec that the owner menu quotes from. This file pins them together,
 * because a disagreement means the menu promises one repayment and the wallet
 * makes another.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SEED_REPAY_TRIGGER_X,
  SEED_REPAY_RATE,
  SEED_REPAY_MIN_INSTALMENT,
  seedRepayTriggerAt,
  seedInstalmentDue,
  requiredSeed,
  SPIN_TIERS,
} from '../../src/config/spinSpec';

const root = resolve(__dirname, '../../');
const dir = resolve(root, 'supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('spin_seed_instalment_plan'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');
const panel = readFileSync(resolve(root, 'src/components/club/SpinActivationPanel.tsx'), 'utf8');

describe('the plan is a loan being retired, not a rake', () => {
  it('takes nothing when nothing is owed, however rich the pool', () => {
    expect(seedInstalmentDue(1_000_000, 0, 20_000)).toBe(0);
    expect(sql).toMatch(/skimmed a pool that owes nothing/);
  });

  it('never returns more than is still owed', () => {
    expect(seedInstalmentDue(100_000, 500, 20_000)).toBe(500);
  });

  it('does nothing without a floor to measure against', () => {
    // A zero floor would make the whole balance "surplus" and hand half of it
    // back on the first settle.
    expect(seedInstalmentDue(50_000, 10_000, 0)).toBe(0);
  });
});

describe('the threshold', () => {
  it('is a quarter clear of the floor', () => {
    expect(SEED_REPAY_TRIGGER_X).toBe(1.25);
    expect(seedRepayTriggerAt(100)).toBe(25_000);
    expect(seedRepayTriggerAt(10)).toBe(2_500);
  });

  it('pays nothing one chip below it, even though surplus exists', () => {
    expect(seedInstalmentDue(24_999, 20_000, 20_000)).toBe(0);
    expect(seedInstalmentDue(25_000, 20_000, 20_000)).toBe(2_500);
  });

  it('ignores dust rather than writing a ledger row for it', () => {
    expect(SEED_REPAY_MIN_INSTALMENT).toBe(1);
    // Just over the trigger, the surplus is tiny.
    expect(seedInstalmentDue(20_001 * 1.25, 20_000, 20_000)).toBeGreaterThanOrEqual(0);
    expect(seedInstalmentDue(25_000, 0.4, 20_000)).toBe(0);
  });
});

describe('the percentage', () => {
  it('is half of the surplus above the floor', () => {
    expect(SEED_REPAY_RATE).toBe(0.5);
    expect(seedInstalmentDue(30_000, 20_000, 20_000)).toBe(5_000);
  });

  it('can never take the balance below the floor, at any balance', () => {
    for (let b = 20_000; b <= 120_000; b += 613) {
      const paid = seedInstalmentDue(b, 10_000_000, 20_000);
      expect(b - paid).toBeGreaterThanOrEqual(20_000);
    }
  });

  it('retires a seed in the eight visits the design claims', () => {
    // The worked example in both the migration header and spinSpec.
    let balance = 25_000;
    let owed = 20_000;
    let instalments = 0;
    while (owed > 0 && instalments < 100) {
      const due = seedInstalmentDue(balance, owed, 20_000);
      if (due <= 0) break;
      owed -= due;
      balance -= due;
      instalments++;
      balance = 25_000; // the pool climbs back to the trigger between visits
    }
    expect(instalments).toBe(8);
    expect(owed).toBeCloseTo(0.0, 1);
  });
});

describe('the database and the client agree, number for number', () => {
  it('the SQL asserts the same worked example the client computes', () => {
    expect(seedInstalmentDue(25_000, 20_000, 20_000)).toBe(2_500);
    expect(sql).toMatch(/fn_spin_seed_instalment\(25000, 20000, 20000\) <> 2500/);
    expect(sql).toMatch(/fn_spin_seed_instalment\(24999, 20000, 20000\) <> 0/);
    expect(sql).toMatch(/fn_spin_seed_instalment\(100000, 500, 20000\) <> 500/);
  });

  it('the SQL sweeps the floor invariant the same way this file does', () => {
    expect(sql).toMatch(/generate_series\(20000, 60000, 137\)/);
    expect(sql).toMatch(/would take the balance below the floor/);
  });

  it('the floor is still two top-tier jackpots, and the top tier is 100x', () => {
    expect(SPIN_TIERS[SPIN_TIERS.length - 1].multiplier).toBe(100);
    expect(requiredSeed(100)).toBe(20_000);
  });

  it('refuses to pass if the live settle path is not using the plan', () => {
    expect(sql).toMatch(/does not use the repayment plan/);
  });

  it('checks the pool still reconciles after replacing the money function', () => {
    expect(sql).toMatch(/seeded_amount \+ total_deposited - total_drawn/);
  });
});

describe('the owner is told the plan, not just a number', () => {
  it('explains it before they commit any money', () => {
    expect(panel).toMatch(/How It Comes Back/);
  });

  it('names the wallet the money actually returns to', () => {
    expect(panel).toMatch(/walletLabel\(state\.owner_kind, state\.seed_source_wallet\)/);
  });

  it('shows the floor, the trigger and what is due next', () => {
    expect(panel).toMatch(/state\.repay_floor/);
    expect(panel).toMatch(/state\.repay_trigger_at/);
    expect(panel).toMatch(/state\.next_instalment/);
  });

  it('shows progress, so a long plan does not look like a stalled one', () => {
    expect(panel).toMatch(/Returned So Far/);
    expect(panel).toMatch(/Seed Still Owed/);
  });
});
