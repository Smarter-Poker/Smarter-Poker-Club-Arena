/**
 * A Spin that was drawn but never launched, and never even had a launch
 * attempt start, is dead reserve, not a Spin in play - it must be refundable.
 * Board incident: operational_alert_events id=5 (SpinUnfilledBacklog),
 * 13 tournaments drawn 2026-09-08, never launched, stuck since.
 *
 * Two independent defects blocked their cancellation before this migration:
 *  1. atomic_cancel_tournament's guard refused ANY stamped spin_multiplier
 *     or jackpot_draw row unconditionally, with no way to tell a genuinely
 *     abandoned draw from one whose launch is still claiming a stale lease.
 *  2. fn_ca_tournament_refund_plan compared tournament_escrow.fee_entries_in
 *     against the sum of each player's own refund_fee entitlement, which is
 *     structurally always 0 for a Spin (the whole buy-in itemizes as prize;
 *     the Spin's rake is pooled separately at booking) - so the assertion
 *     could never pass for any Spin, independent of these 13 rows. Flagged
 *     and left open 2026-09-09 (docs/audits/2026-09-09-phase3-tournament-
 *     lifecycle.md, "T06/S11").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260923165133_a_drawn_spin_with_no_launch_evidence_is_refundable.sql'
  ),
  'utf8'
);

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

const SQL = executable(MIGRATION);
const ATOMIC = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament'),
  SQL.indexOf(
    '$function$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament')
  )
);
const REFUND_PLAN = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan'),
  SQL.indexOf(
    '$function$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan')
  )
);
const SETTLEMENT = SQL.slice(SQL.indexOf('DO $settle_stuck_spins$'));

describe('a drawn Spin with no launch evidence is refundable', () => {
  it('no longer refuses cancellation on a stamped multiplier or a draw row alone', () => {
    expect(ATOMIC).not.toMatch(/COALESCE\(v_t\.spin_multiplier,0\)>0/);
    expect(ATOMIC).not.toMatch(
      /EXISTS \(SELECT 1 FROM public\.spin_reserve_ledger r[\s\S]{0,80}kind='jackpot_draw'\)\s*\n\s*OR EXISTS \(SELECT 1 FROM public\.hand_history/
    );
  });

  it('still refuses cancellation whenever any launch attempt row exists at all, not only a completed one', () => {
    expect(ATOMIC).toMatch(
      /EXISTS \(SELECT 1 FROM public\.tournament_launch_receipts r\s*\n\s*WHERE r\.tournament_id=p_tournament_id\)/
    );
    expect(ATOMIC).not.toMatch(/tournament_launch_receipts r[\s\S]{0,40}completed_at IS NOT NULL/);
  });

  it('keeps every other real-play guard clause unchanged', () => {
    expect(ATOMIC).toMatch(/v_t\.started_at IS NOT NULL/);
    expect(ATOMIC).toMatch(/upper\(COALESCE\(v_t\.status::text,''\)\) IN \('RUNNING','BREAK'\)/);
    expect(ATOMIC).toMatch(/EXISTS \(SELECT 1 FROM public\.spin_draw_receipts r/);
    expect(ATOMIC).toMatch(/EXISTS \(SELECT 1 FROM public\.hand_history hh/);
    expect(ATOMIC).toMatch(
      /EXISTS \(SELECT 1 FROM public\.tables tb\s*\n\s*JOIN public\.hand_history hh ON hh\.table_id=tb\.id/
    );
    expect(ATOMIC).toMatch(/o\.kind<>'refund' AND o\.amount_paid>0/);
    expect(ATOMIC).toMatch(
      /Tournament has started or committed awards; resume or settle it instead of cancelling/
    );
  });

  it('fn_ca_tournament_refund_plan compares a Spin escrow to its pooled booking rake, never per-player refund_fee', () => {
    expect(REFUND_PLAN).toMatch(/v_is_spin boolean;/);
    expect(REFUND_PLAN).toMatch(/v_expected_fee_entries numeric;/);
    expect(REFUND_PLAN).toMatch(
      /SELECT COALESCE\(t\.spin_multiplier,0\)>0 INTO v_is_spin/
    );
    expect(REFUND_PLAN).toMatch(/IF v_is_spin THEN/);
    // Sums every rake_records row for the tournament EXCEPT a prior
    // cancellation/unregister reversal, then subtracts the satellite-seat
    // award portion - not a literal filter on 'fn_spin_book_entry', so this
    // stays correct for a Spin with an earlier partial refund on record, not
    // only for these 13 (which happen to carry no other rake source yet).
    expect(REFUND_PLAN).toMatch(
      /NOT \(r\.rake_amount<0 AND r\.source IN \(\s*\n\s*'atomic_cancel_tournament','fn_unregister_from_tournament'\)\)/
    );
    expect(REFUND_PLAN).toMatch(/WHERE r\.source='fn_award_satellite_seat'/);
    expect(REFUND_PLAN).toMatch(/v_expected_fee_entries:=v_direct_fee;/);
    expect(REFUND_PLAN).toMatch(
      /v_escrow\.fee_entries_in IS DISTINCT FROM v_expected_fee_entries/
    );
    expect(REFUND_PLAN).not.toMatch(/v_escrow\.fee_entries_in IS DISTINCT FROM v_direct_fee/);
  });

  it('leaves every non-spin invariant in fn_ca_tournament_refund_plan untouched', () => {
    expect(REFUND_PLAN).toMatch(/wallet charges and immutable entitlements disagree/);
    expect(REFUND_PLAN).toMatch(/has % invalid refund entitlement sources/);
    expect(REFUND_PLAN).toMatch(/has refund money without exact entitlement tranches/);
    expect(REFUND_PLAN).toMatch(/has a tranche detached from its entitlement/);
  });

  it('settles all 13 known stuck tournaments through atomic_cancel_tournament itself, asserting the proven refund total', () => {
    const ids = [
      '2aa4cba1-506f-426b-a1ba-d8e22e018533',
      '44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa',
      '482e90bb-ef9d-4135-9067-9f0332c94142',
      '6d359f61-d681-49ba-82f3-00493178e5b3',
      '7284506c-093c-491a-8da7-5816bf1ccccf',
      '8904c10b-6a47-4934-bdf2-def1b1e76f0b',
      '8d5969da-df76-44fa-8c83-5608b844ca06',
      '95e43b6e-c1c9-445e-a1d9-cbe711e3bac1',
      '9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8',
      'b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99',
      'b67ab0cb-e2d6-4955-8f43-4bff32551400',
      'c2fd1c7e-9572-4b95-90dd-3b999777a145',
      'efd5455d-d188-4171-becb-1d35b016d06a',
    ];
    for (const id of ids) {
      expect(SETTLEMENT).toContain(id);
    }
    expect(SETTLEMENT).toMatch(/atomic_cancel_tournament\(v_id,NULL\)/);
    expect(SETTLEMENT).toMatch(/\(v_result->>'ok'\)::boolean,false\) IS NOT TRUE/);
    expect(SETTLEMENT).toMatch(/\(v_result->>'fully_settled'\)::boolean,false\) IS NOT TRUE/);
    expect(SETTLEMENT).toMatch(
      /\(v_result->>'total_refunded'\)::numeric IS DISTINCT FROM v_expected\[v_i\]/
    );
    expect(SETTLEMENT).toMatch(
      /300\.00,150\.00,6\.00,60\.00,6\.00,3\.00,15\.00,60\.00,9\.00,30\.00,15\.00,9\.00,6\.00/
    );
  });

  it('is one migration transaction guarded against drift from the state this was written against', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
    expect(MIGRATION).toMatch(
      /oid='public\.atomic_cancel_tournament\(uuid,uuid\)'::regprocedure\s*\n\s*AND md5\(prosrc\)='0aea21224182e48dc5a466e4592a09e4'/
    );
    expect(MIGRATION).toMatch(
      /oid='public\.fn_ca_tournament_refund_plan\(uuid,uuid\)'::regprocedure\s*\n\s*AND md5\(prosrc\)='27cedb21bac278709f43f037a31403a0'/
    );
  });
});
