/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A LIVE SEAT COUNT IS NOT A SEAT COUNT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_spin_sweep_unbooked settled each unbooked Spin with `current_players`.
 * That column drains as players bust, so by the time the sweep reached a
 * finished Spin it could be anything from the real field down to 1.
 * fn_spin_settle_game multiplies it by the buy-in to get `collected` and takes
 * the house rake off that number, so a drained counter under-books both.
 *
 * Proved against production in a transaction that rolled itself back: a real
 * 3-seat 10.00 Spin booked seats=1, collecting 10.00 instead of 30.00. After
 * the fix the same Spin books seats=3, collected 30.00, rake 2.10 - and it
 * books correctly even when the counter has drained all the way to zero, which
 * the old filter skipped entirely so the rake was never taken at all.
 *
 * CI has no database, so these assert on migration source. Both outputs are
 * quoted in the migration header. What these CAN prove is that nobody quietly
 * points it back at the draining counter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20260828033000_the_spin_sweep_books_the_seats_that_sold.sql'
  ),
  'utf8'
);

/** The header quotes the defect on purpose; negative assertions read the
 *  executable half or they match the documentation. */
const BODY = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION'));

describe('the spin sweep books the seats that were sold', () => {
  it('counts rows in tournament_players, not the draining counter', () => {
    expect(BODY).toContain('FROM public.tournament_players tp');
    expect(BODY).toContain('AS seats_sold');
    expect(BODY).toContain('v_t.seats_sold, v_t.spin_multiplier');
  });

  it('never passes current_players into the settlement again', () => {
    // The word survives in the comment that explains what changed, so this
    // looks for the value being read, not for the name.
    expect(BODY).not.toMatch(/v_t\.current_players/);
    expect(BODY).not.toMatch(/t\.current_players,\s*t\.spin_multiplier/);
  });

  it('casts the count, because bigint will not resolve against p_seats integer', () => {
    /**
     * The first attempt at this fix omitted the cast. Every call failed
     * function resolution, EXCEPTION WHEN OTHERS swallowed it, and the sweep
     * reported settled 0 / failed 1 with no reason. The code read as correct.
     */
    expect(BODY).toMatch(/count\(\*\)::int/);
  });

  it('no longer skips a Spin whose counter drained to zero', () => {
    // A skipped Spin is one whose rake is never taken at all, so "did anybody
    // enter" replaced "are any of them still sitting there".
    expect(BODY).not.toMatch(/COALESCE\(t\.current_players,\s*0\)\s*>\s*0/);
    expect(BODY).toContain('EXISTS (SELECT 1 FROM public.tournament_players tp');
  });

  it('still refuses to book a Spin that sold nothing', () => {
    expect(BODY).toMatch(/COALESCE\(v_t\.seats_sold, 0\) < 1/);
    expect(BODY).toContain('skipped_no_entrants');
  });

  it('says why a settlement failed instead of counting it in silence', () => {
    expect(BODY).toContain("'sqlstate', SQLSTATE, 'error', SQLERRM");
    expect(BODY).toContain("'failures', v_failures");
  });

  it('is not callable from a browser', () => {
    // It writes a club's rake ledger. Same rule as every other maintenance RPC.
    expect(BODY).toContain(
      'REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer) FROM PUBLIC, anon, authenticated'
    );
    expect(BODY).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer) TO service_role'
    );
  });

  it('records both probes, so the claim has a number behind it', () => {
    expect(SQL).toContain('booked seats=1 (want 3)');
    expect(SQL).toContain('seats=3 collected=30.00 rake=2.10');
  });
});
