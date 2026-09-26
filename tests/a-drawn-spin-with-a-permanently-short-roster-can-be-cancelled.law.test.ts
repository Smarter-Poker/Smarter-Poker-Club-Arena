/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DRAWN SPIN WITH A PERMANENTLY SHORT ROSTER CAN BE CANCELLED (law)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production Alerts Fleet, board issue #5070 (Smarter-Poker-Club-Arena),
 * incident spin-unfilled-backlog-legacy-orphans: 13 Spin tournaments drew a
 * real multiplier and moved real chips into their prize liability, but their
 * receipt was never written and the launch that deals the hand never ran.
 * Every one of the 13 has since permanently dropped below the three active
 * seats a relaunch requires (fn_spin_draw_and_settle_atomic's own field-of-3
 * proof), so they could neither relaunch nor cancel: atomic_cancel_tournament
 * refused ANY tournament with a stamped multiplier or a jackpot_draw row,
 * unconditionally, even though the function already has more precise clauses
 * for genuine in-play evidence.
 *
 * Migration 20260922225837_legacy_drawn_never_launched_spin_settles.sql fixes
 * this at the root: the guard now only refuses a drawn Spin when its active
 * roster could still plausibly relaunch (exactly 3), a narrow cache-sync
 * closes the untested caches-vs-escrow gap this exposed, and
 * fn_ca_tournament_refund_plan is given the same Spin fee-accounting
 * exemption fn_spin_draw_and_settle_atomic's own header already documents
 * needing. This pins that the three patches keep their safety conditions
 * intact - never a bare, unconditional relaxation - so a later edit cannot
 * quietly widen this into "any drawn Spin can be cancelled" and reopen the
 * exact race (cancelling a Spin that is genuinely mid-launch) this law
 * exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

function findMigration(): string {
  const dir = resolve(__dirname, '..', 'supabase', 'migrations');
  const file = readdirSync(dir).find((f) =>
    f.endsWith('_legacy_drawn_never_launched_spin_settles.sql')
  );
  if (!file) {
    throw new Error(
      'legacy_drawn_never_launched_spin_settles migration not found -- the fix this law pins was removed or renamed'
    );
  }
  return readFileSync(resolve(dir, file), 'utf8');
}

const MIGRATION = findMigration();

describe('atomic_cancel_tournament admits a drawn Spin only when its roster can never relaunch', () => {
  it('still checks every pre-existing in-play clause (launch receipt, draw receipt) before the new roster-count exception', () => {
    expect(MIGRATION).toContain(
      "EXISTS (SELECT 1 FROM public.tournament_launch_receipts r"
    );
    expect(MIGRATION).toContain(
      "EXISTS (SELECT 1 FROM public.spin_draw_receipts r"
    );
  });

  it('only bypasses the multiplier/jackpot_draw refusal when the active roster is exactly 3, never unconditionally', () => {
    expect(MIGRATION).toMatch(
      /COALESCE\(v_t\.spin_multiplier,0\)>0[\s\S]{0,400}kind=''jackpot_draw''[\s\S]{0,400}status IN \(''registered'',''playing''\)\)=3\)/
    );
  });

  it('never widens the roster-count condition to "less than 3" or drops it entirely', () => {
    expect(MIGRATION).not.toMatch(/registered'',\s*''playing''\)\)\s*[<>]=?\s*3/);
  });
});

describe('the cache sync only fires for a Spin that already drew and never launched or dealt a hand', () => {
  it('is gated on jackpot_draw/multiplier evidence, no launch receipt, and no hand history', () => {
    expect(MIGRATION).toContain(
      "AND (COALESCE(t2.spin_multiplier,0)>0"
    );
    expect(MIGRATION).toContain(
      "NOT EXISTS (SELECT 1 FROM public.tournament_launch_receipts r3 WHERE r3.tournament_id=t2.id AND r3.completed_at IS NOT NULL)"
    );
    expect(MIGRATION).toContain(
      "NOT EXISTS (SELECT 1 FROM public.hand_history hh3 WHERE hh3.tournament_id=t2.id)"
    );
  });

  it('only writes when the cache has actually drifted from the escrow, never unconditionally', () => {
    expect(MIGRATION).toMatch(
      /prize_pool IS DISTINCT FROM e2\.prize_balance[\s\S]{0,120}bounty_pool IS DISTINCT FROM e2\.bounty_balance[\s\S]{0,120}total_rake IS DISTINCT FROM e2\.fee_balance/
    );
  });
});

describe('the refund-plan fee exemption is scoped to Spin tournaments only', () => {
  it('exempts fee_entries_in equality only when the tournament is variant=spin', () => {
    expect(MIGRATION).toMatch(
      /fee_entries_in IS DISTINCT FROM v_direct_fee[\s\S]{0,120}NOT EXISTS \(SELECT 1 FROM public\.tournaments tsp WHERE tsp\.id=p_tournament_id AND tsp\.variant=''spin''\)/
    );
  });

  it('leaves every other refund-plan assertion untouched (gross_in, satellite_fee_in, bounty_in, satellite_in)', () => {
    expect(MIGRATION).toContain('v_escrow.gross_in IS DISTINCT FROM v_wallet_gross');
    expect(MIGRATION).toContain('v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee');
    expect(MIGRATION).toContain('v_escrow.bounty_in IS DISTINCT FROM v_bounty');
    expect(MIGRATION).toContain('v_escrow.satellite_in IS DISTINCT FROM v_satellite_in');
  });
});

describe('the one-time settlement is self-verifying, never a hardcoded total', () => {
  it('reads each tournament\'s own escrow immediately before settling it, rather than trusting a literal', () => {
    expect(MIGRATION).toContain(
      "PERFORM public.fn_ca_escrow_apply(v_id, 'legacy spin settlement preflight');"
    );
    expect(MIGRATION).toContain('INTO v_expected_prize, v_expected_bounty, v_expected_fee');
  });

  it('aborts the whole migration if the settled receipt disagrees with what was just read', () => {
    expect(MIGRATION).toContain("(v_receipt->>'total_refunded')::numeric IS DISTINCT FROM v_expected_total");
    expect(MIGRATION).toContain("(v_receipt->>'fees_reversed')::numeric IS DISTINCT FROM v_expected_fee");
    expect(MIGRATION).toContain('MIGRATION_ABORT');
  });

  it('refuses to run against anything but the exact known defect signature', () => {
    expect(MIGRATION).toContain("t.variant = 'spin'");
    expect(MIGRATION).toContain("t.started_at IS NULL");
    expect(MIGRATION).toContain('v_signature_count IS DISTINCT FROM cardinality(v_ids)');
  });
});
