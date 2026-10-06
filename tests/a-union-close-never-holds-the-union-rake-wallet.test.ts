/**
 * A UNION CLOSE NEVER HOLDS THE UNION'S RAKE WALLET WHILE IT WORKS
 *
 * Every hand on a union table credits that union's one union_wallets row.
 * Round 1 of the weekly close used to lock that row FOR UPDATE before its
 * heavy reads and keep it through rounds 2 and 3, invoices and statements, so
 * every Midway hand commit queued behind the close and timed out (2026-09-29).
 * The debit is now one guarded UPDATE, posted as the cascade's last write.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(__dirname, '..', 'supabase/migrations/20260929124252_a_union_close_never_holds_the_union_rake_wallet.sql'),
  'utf8',
);

describe('the weekly union close and live hands', () => {
  it('reads the union wallet in round 1 without a lock', () => {
    expect(SQL).toContain('  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id;\n');
  });

  it('debits the rake wallet in one guarded update that cannot overdraw it', () => {
    expect(SQL).toContain('WHERE union_id = u AND rake_wallet >= v_total');
    expect(SQL).toContain("RAISE EXCEPTION 'insufficient_rake_treasury'");
  });

  it('posts that debit as the last write of the cascade, and refuses success without it', () => {
    expect(SQL).toContain("PERFORM set_config('app.union_close_defer_rake_debit'");
    expect(SQL).toContain('SELECT * INTO v_posted FROM public.fn_union_close_post_rake_debit(v_pending);');
    expect(SQL).toContain("RAISE EXCEPTION 'union_close_rake_debit_not_pending'");
  });

  it('still posts inline when round 1 is called on its own', () => {
    expect(SQL).toContain('FROM public.fn_union_close_post_rake_debit(v_pending) d;');
  });

  it('never takes a key lock on a club row to credit its treasury', () => {
    expect(SQL).toContain('FROM clubs WHERE id = p_club_id FOR NO KEY UPDATE;');
  });

  it('registers the new money function before creating it, and carries its live proof', () => {
    expect(SQL.indexOf("SELECT 'fn_union_close_post_rake_debit','approved'")).toBeLessThan(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_close_post_rake_debit'),
    );
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });
});
