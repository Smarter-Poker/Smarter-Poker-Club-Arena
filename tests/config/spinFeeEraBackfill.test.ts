/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TWO THINGS THAT WERE LEFT AS "SOMEONE ELSE'S DECISION"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Both were written up as open questions for a human. Neither should have been.
 *
 *   1. 2,116 Spins ran and were never booked to the reserve ledger, because
 *      fn_spin_sweep_unbooked and v_spin_reserve_health.unbooked_24h both skip
 *      a game with a fee. The backstop refused to settle them and the counter
 *      that exists to notice unsettled games did not count them.
 *
 *   2. Two tables were created hours apart with RLS off and INSERT/UPDATE/
 *      DELETE granted to anon, because CREATE TABLE in public inherits those
 *      grants. Each one failed CHECK 10, which reads the live catalog, so each
 *      blocked every open PR in the World Hub at once.
 *
 * These are source-level assertions over the two migrations that closed them,
 * in the house style. The behaviour itself was proven against production in
 * rolled-back transactions and recorded under APPLY HISTORY in each file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

const backfill = sqlCode(read('supabase/migrations/20260823040000_book_the_fee_era_spins.sql'));
const rlsDefault = sqlCode(read('supabase/migrations/20260823050000_rls_on_by_default.sql'));

describe('the backfill books the reserve and nothing else', () => {
  it('never writes a rake record', () => {
    // 863 of the 2,116 games already had one. fn_spin_settle_game writes a rake
    // record every time, so replaying it would double-count house rake AND date
    // 2,116 rows today for games that ran days ago.
    expect(backfill).not.toMatch(/INSERT INTO public\.rake_records/);
    expect(backfill).toMatch(/rake_records for the backfilled games changed/);
  });

  it('refuses to clamp a prize instead of writing a shortfall row', () => {
    // A clamp would write kind='adjustment', which v_spin_reserve_health counts
    // as shortfall_events with NO time window, so spin-sweep would page an
    // operator forever about a game from days ago.
    expect(backfill).toMatch(/refusing to clamp/);
    expect(backfill).toMatch(/the backfill created % shortfall row\(s\)/);
  });

  it('books against the resolved OWNER, not the playing club', () => {
    expect(backfill).toMatch(/fn_spin_reserve_owner\(g\.club_id\)/);
  });

  it('scopes its assertions to its own games, so a live Spin cannot abort it', () => {
    // The first attempt asserted on a GLOBAL rake count and rolled itself back
    // when a concurrent Spin settled mid-loop. The assertion was made precise
    // rather than removed.
    expect(backfill).toMatch(/FROM public\.rake_records r\s*\n\s*WHERE r\.tournament_id IN \(/);
    expect(backfill).toMatch(/note LIKE 'fee-era backfill%'/);
  });

  it('proves money is conserved from its own ledger rows', () => {
    expect(backfill).toMatch(/money is not conserved/);
  });

  it('refuses to run twice', () => {
    expect(backfill).toMatch(/has already run - it is not idempotent by design/);
  });

  it('leaves nothing unbooked', () => {
    expect(backfill).toMatch(/fee-era spins are still unbooked/);
  });
});

describe('a new table cannot be born writable by the internet', () => {
  it('installs an event trigger on every way a table gets created', () => {
    expect(rlsDefault).toMatch(/CREATE EVENT TRIGGER trg_rls_on_new_public_table/);
    for (const tag of ['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO']) {
      expect(rlsDefault).toContain(`'${tag}'`);
    }
  });

  it('enables RLS rather than revoking grants', () => {
    // CHECK 10 tests `NOT relrowsecurity AND client-writable`. Enabling RLS
    // makes the first half false no matter what anyone grants later, which is
    // structural; revoking grants is only true until the next GRANT.
    expect(rlsDefault).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('keeps a deliberate escape hatch, like the function guard it mirrors', () => {
    expect(rlsDefault).toMatch(/app\.allow_rls_off_table/);
  });

  it('can never be the reason a migration fails', () => {
    // It runs on EVERY CREATE TABLE in the estate.
    expect(rlsDefault).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(rlsDefault).toMatch(/RAISE WARNING 'fn_rls_on_new_public_table could not secure/);
    expect(rlsDefault).not.toMatch(/RAISE EXCEPTION 'fn_rls_on_new_public_table/);
  });

  it('only touches ordinary and partitioned tables in public', () => {
    expect(rlsDefault).toMatch(/schema_name = 'public'/);
    expect(rlsDefault).toMatch(/c\.relkind IN \('r', 'p'\)/);
    expect(rlsDefault).toMatch(/NOT c\.relrowsecurity/);
  });

  it('asserts the guard it backs up is green at apply time', () => {
    expect(rlsDefault).toMatch(/no_rls_off_tables_writable_by_clients is failing at apply time/);
  });
});
