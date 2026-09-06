/**
 * A DETECTOR RE-READS WHAT IT FILED.
 *
 * H2 of the chip-accounting programme. fn_ca_escrow_vs_counter_check filed
 * thirty incidents and never looked at them again: twenty-three were
 * settlement legs that landed minutes after the detector looked (a fee
 * settled by the sweep, a place paid by the reconciler) and had balanced for
 * days while the board still called them owed money; seven were settled,
 * Dan-ruled 2026-09-02 events whose residue is a fixed mechanism, not a live
 * leak. One more was a chip moved between two columns of the shadow by an
 * unregistration's fee reversal - 600.00 held, 600.00 paid, +0.98 / -0.98.
 *
 * Dan, 2026-09-06: "NOT CONSTANTLY RUNNING AROUND RECONCILING ... I WANT
 * NOTHING BUT CODE BASE FIXES FOR ANY AND ALL CHIP DRIFT ISSUES." A detector
 * that cannot recognise its own false alarm is a code defect in the detector,
 * and that is what these pin. None of it moves a chip.
 *
 *  - The detector re-reads every incident it holds open, first thing, every
 *    run, through fn_ca_escrow_incident_closes_when_the_leg_lands, and the
 *    run summary reports how many it re-read and how many closed.
 *  - The helper closes ONLY an event that balances 0.00 / 0.00 / 0.00 now,
 *    names the leg that landed and how late, and files its own failures
 *    where a person reads (ca_incident_file_failures), never only the log.
 *  - The migration proves the helper leaves an owed event open, in a probe
 *    it rolls back.
 *  - An unregistration's fee reversal is excluded from fee_in the same way a
 *    cancel's is (chip standard 5.3), so a refunded entry cannot split the
 *    shadow between two columns.
 *  - The seven 2026-09-02 events are closed with the migration that fixed
 *    each mechanism as correction_ref, and the double-paid overlay is named
 *    as absorbed, never clawed back (CLAUDE.md 10.9 rule 3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  return { f, sql: f ? readFileSync(join(MIGRATIONS, f), 'utf8') : '' };
};
const selfClose = read('an_escrow_incident_closes_itself_when_the_leg_lands');
const unregister = read('an_unregistration_fee_reversal_is_attribution_not_escrow_mon');

describe('a detector re-reads what it filed', () => {
  it('both migrations exist', () => {
    expect(selfClose.f, 'the self-close migration must not be deleted').toBeTruthy();
    expect(unregister.f, 'the unregistration-reversal migration must not be deleted').toBeTruthy();
  });

  it('the detector re-reads its open incidents before it looks for new ones', () => {
    const s = selfClose.sql;
    const reread = s.indexOf(
      "WHERE i.source = 'fn_ca_escrow_vs_counter_check'\n       AND i.status <> 'resolved'"
    );
    const scan = s.indexOf(
      "FROM public.tournaments t\n     WHERE (t.status = 'COMPLETED' AND t.ended_at > v_cutoff)"
    );
    expect(reread).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(reread);
    expect(s).toContain('IF public.fn_ca_escrow_incident_closes_when_the_leg_lands(r.id) THEN');
    expect(s).toContain("'open_incidents_reread', v_reread");
    expect(s).toContain("'open_incidents_self_closed', v_self_closed");
  });

  it('the helper closes only an event that balances now, and says which leg landed', () => {
    const s = selfClose.sql;
    expect(s).toMatch(
      /IF abs\(e\.prize_balance\) > 0\.005 OR abs\(e\.bounty_balance\) > 0\.005\s+OR abs\(e\.fee_balance\) > 0\.005 THEN\s+RETURN false;/
    );
    expect(s).toContain("'The escrow shadow looked before the %s leg had landed.");
    expect(s).toContain(
      "correction_ref = 'verified: fn_ca_tournament_escrow balances 0.00/0.00/0.00 at '"
    );
    expect(s).toContain("'lag_seconds'");
  });

  it('the helper files its own failure where a person reads, not only the log', () => {
    expect(selfClose.sql).toMatch(
      /EXCEPTION WHEN OTHERS THEN[\s\S]*?INSERT INTO public\.ca_incident_file_failures[\s\S]*?'fn_ca_escrow_incident_closes_when_the_leg_lands'/
    );
  });

  it('the migration proves an owed event stays open, in a rolled-back probe', () => {
    const s = selfClose.sql;
    expect(s).toContain(
      "RAISE EXCEPTION 'VERIFY FAILED: the helper closed an incident whose event does not balance'"
    );
    expect(s).toContain("RAISE EXCEPTION 'ca_verify_rollback'");
    expect(s).toContain(
      "IF EXISTS (SELECT 1 FROM public.ca_drift_incidents WHERE dedupe_key LIKE 'zz-verify-escrow-%')"
    );
  });

  it('the seven settled 2026-09-02 events are closed against their live residual, with no clawback', () => {
    const s = selfClose.sql;
    expect(s).toContain(
      "RAISE EXCEPTION 'ABORT: % prize_balance is % now, expected % - the board moved, re-read before closing'"
    );
    expect(s).toContain(
      "correction_ref = 'migration 20260902042044_the_reconciler_counts_the_overlay_backpay'"
    );
    expect(s).toContain(
      "correction_ref = 'migration 20260902162954_settle_two_tournaments_frozen_by_the_engineless_table_defect'"
    );
    expect(s).toContain(
      "correction_ref = 'migration 20260903020000_a_satellite_seat_is_paid_from_the_satellites_own_pool'"
    );
    expect(s).toMatch(/Dan ruled no clawback/);
    expect(s).not.toMatch(/UPDATE public\.(club_members|wallets|wallet_transactions|chip_ledger)/);
  });

  it('an unregistration fee reversal is attribution, like a cancel, not escrow money', () => {
    const s = unregister.sql;
    expect(s).toMatch(
      /AND NOT \(rake_amount < 0\s+AND source IN \('atomic_cancel_tournament', 'fn_unregister_from_tournament'\)\)/
    );
    expect(s).toContain('IF e.fee_in <> 60.00 OR e.prize_in <> 360.00 THEN');
  });
});
