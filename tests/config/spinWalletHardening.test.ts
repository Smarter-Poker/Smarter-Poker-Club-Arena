/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  READING MY OWN FEATURE BACK AS AN ATTACKER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six findings from the adversarial pass over the Spin wallet. Two of them
 * were already doing damage in production.
 *
 * 1. A MINTING FUNCTION BECAME A MINT-TO-WALLET CHANNEL.
 *    fn_spin_reserve_seed credited balance AND seeded_amount and debited
 *    nobody. Phase 1 waved that away because it "had no caller in application
 *    code" — and that reasoning died the moment Phase 1 shipped, because Phase
 *    1 made seeded_amount a repayable loan that pays out to a real wallet. It
 *    was still EXECUTABLE by service_role, the role every API route and the
 *    engine run as.
 *
 * 2. THE IDEMPOTENCY GUARD READ BEFORE IT LOCKED.
 *    Two concurrent settles both passed "already settled?", then serialised on
 *    the lock and both booked. The engine retries settlement three times, so a
 *    call that timed out client-side after committing hit it exactly. SIX
 *    tournaments were double-booked in production, with gaps of 19ms to 1.9s
 *    between the pairs — the signature of that retry loop.
 *
 * 3. THE REPAYMENT BAR WAS OWNER-ADJUSTABLE.
 *    It was read live from offered_max_stake, which fn_spin_activate rewrites.
 *    Activate at stake 100 (bar 20,000), deactivate, reactivate at stake 1 and
 *    the bar drops to 200 — the whole 20,000 repayable after trivial play.
 *
 * 4. REACTIVATION DOUBLE-SEEDED AND REDIRECTED THE REPAYMENT to whichever
 *    wallet was named last.
 *
 * 5. A ZERO-ROW UPDATE AFTER THE WALLET MOVED REPORTED SUCCESS.
 *
 * 6. A DEAD GATE: fn_spin_owner_can_open had no callers anywhere.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '../../supabase/migrations');
const sql = readdirSync(dir)
  .filter((f) => f.includes('spin_wallet_hardening'))
  .map((f) => readFileSync(resolve(dir, f), 'utf8'))
  .join('\n');

describe('the minter is gone, and its honest caller still balances', () => {
  it('drops the bare minting function', () => {
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_spin_reserve_seed\(uuid, numeric, numeric, numeric\)/
    );
  });

  it('asserts it cannot survive the migration', () => {
    expect(sql).toMatch(/the minting fn_spin_reserve_seed is still callable/);
  });

  it('inlines the credit immediately after the debit it belongs to', () => {
    const fn = sql.slice(
      sql.indexOf('FUNCTION public.fn_spin_reserve_seed_from_union'),
      sql.indexOf('DROP FUNCTION IF EXISTS public.fn_spin_reserve_seed(')
    );
    const debit =
      fn.indexOf("tx_type 'spin_reserve_seed'") >= 0
        ? fn.indexOf("'spin_reserve_seed'")
        : fn.indexOf('union_wallet_transactions');
    const credit = fn.indexOf('seeded_amount      = seeded_amount + p_amount');
    expect(debit).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(debit);
  });

  it('records the source wallet, so a union seed can actually be repaid', () => {
    // The old function left seed_source_wallet NULL, and the repayment refuses
    // to guess a wallet - so that seed could never come back.
    expect(sql).toMatch(/seed_source_wallet = COALESCE\(seed_source_wallet, p_wallet\)/);
  });
});

describe('settlement locks before it decides it is already settled', () => {
  it('takes the row lock first', () => {
    const settle = sql.slice(sql.indexOf('FUNCTION public.fn_spin_settle_game'));
    const lock = settle.indexOf('FOR UPDATE');
    const check = settle.indexOf('already_settled');
    expect(lock).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(check);
  });

  it('asserts that ordering against the LIVE function, not the file', () => {
    expect(sql).toMatch(/still checks already_settled before locking/);
  });

  it('adds a uniqueness backstop for any future caller', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_spin_ledger_one_booking_per_game/);
    expect(sql).toMatch(
      /WHERE tournament_id IS NOT NULL AND kind IN \('contribution','jackpot_draw'\)/
    );
  });

  it('repairs the games that already double-booked', () => {
    expect(sql).toMatch(/REPAIR: removed %s duplicate settlement pair\(s\)/);
    expect(sql).toMatch(/DELETE FROM public\.spin_reserve_ledger l USING _spin_dupes d/);
  });

  it('removes the duplicate rake rows too -- revenue that was never earned', () => {
    expect(sql).toMatch(/DELETE FROM public\.rake_records rr USING ranked/);
  });

  it('computes the correction per OWNER, not as one lump', () => {
    // Summing across owners and applying the total to whichever sorted first
    // would be a silent misattribution the moment a second club activates.
    expect(sql).toMatch(/FROM _spin_dupes GROUP BY club_id/);
  });

  it('unwinds signed amounts correctly -- draws are negative', () => {
    expect(sql).toMatch(/balance\s+= balance - \(r\.extra_in \+ r\.extra_out\)/);
    expect(sql).toMatch(/total_drawn\s+= total_drawn \+ r\.extra_out/);
  });

  it('refuses to finish while any duplicate remains', () => {
    expect(sql).toMatch(/tournament\(s\) still double-booked/);
  });
});

describe('the repayment bar is frozen where the seed was taken', () => {
  it('stores it in its own column', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS required_seed_at_activation numeric/);
  });

  it('settle reads the frozen bar, not the mutable stake', () => {
    const settle = sql.slice(sql.indexOf('FUNCTION public.fn_spin_settle_game'));
    expect(settle).toMatch(
      /required_seed_at_activation\s*\n?\s*INTO v_seed, v_wallet, v_kind, v_collected_play, v_required/
    );
    expect(settle).not.toMatch(/v_required := public\.fn_spin_required_seed/);
  });

  it('never lowers a bar that has already been set', () => {
    expect(sql).toMatch(
      /required_seed_at_activation = GREATEST\(required_seed_at_activation, v_required\)/
    );
  });

  it('the owner menu quotes the frozen bar while a seed is outstanding', () => {
    expect(sql).toMatch(/WHEN v_r\.seeded_amount > 0 AND v_r\.required_seed_at_activation > 0/);
  });
});

describe('reactivation cannot quietly redirect somebody else’s money', () => {
  it('refuses a second seed owed to a different wallet', () => {
    expect(sql).toMatch(/'seed_outstanding_to_another_wallet'/);
    expect(sql).toMatch(/v_prev_wallet <> p_source_wallet/);
  });
});

describe('a move that lands nowhere is a rollback, not a success', () => {
  it('checks FOUND after every money UPDATE', () => {
    const raises = sql.match(/IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(4);
  });

  it('names what was lost, so the log says which wallet moved', () => {
    expect(sql).toMatch(/spin pool row vanished for owner % after debiting % from %/);
    expect(sql).toMatch(/spin pool row vanished for owner % after repaying % to %/);
  });
});

describe('small numbers cannot slip past the bar', () => {
  it('refuses a stake whose required seed rounds to zero', () => {
    expect(sql).toMatch(/'max_stake_too_small'/);
    expect(sql).toMatch(/IF v_required <= 0 THEN/);
  });

  it('rounds the seed to the precision the pool actually stores', () => {
    expect(sql).toMatch(/v_seed := round\(COALESCE\(p_seed_amount, 0\), 2\)/);
  });
});

describe('the dead gate is gone', () => {
  it('drops fn_spin_owner_can_open', () => {
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.fn_spin_owner_can_open\(uuid\)/);
  });

  it('corrects the comment that claimed it read is_active', () => {
    expect(sql).toMatch(/read by TournamentRecurringService\.activatedSpinOwners/);
  });
});
