/**
 * LAW: A TICKET PAID IN CASH NEVER ARRIVES AT ITS TARGET (2026-10-15).
 *
 * fn_ca_pay_closed_target_ticket_in_cash (20261012054804) pays an unused
 * entry-only satellite ticket in cash when its target closes, and marks the
 * ticket 'redeemed'. Both conservation readings counted every 'redeemed'
 * ticket as a seat that arrived at its target, so the 928 stranded tickets
 * paid on 2026-10-14 raised 56 "retained money it never paid out" warnings
 * (55,120.00) on targets those holders never entered.
 *
 * Root: the scalar and the set reading both exclude a ticket whose
 * redemption is the cash door's own leg, 'ticket:<id>:closed-target-cash'.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015100003_a_ticket_paid_in_cash_never_arrives_at_its_target.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('a ticket paid in cash never arrives at its target', () => {
  it('is one transaction with a live proof and exact pre and post images for both readings', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: .*'e796dbcb9eff1be639d23b2526c98228'.*'42ba1e0ca23edb232eae99433b152bfd'$/m
    );
    for (const h of [
      'bbe59c17ba9d79308f2c5077e0940183',
      'e14f6d4bf9e85ac6679d1120139f4fdf',
      'e796dbcb9eff1be639d23b2526c98228',
      '42ba1e0ca23edb232eae99433b152bfd',
    ])
      expect(CODE).toContain(h);
    expect(CODE).toContain("'public.fn_tournament_conservation_delta(uuid)'::regprocedure");
    expect(CODE).toContain(
      "'public.fn_tournament_conservation_deltas(timestamptz,timestamptz)'::regprocedure"
    );
    for (const refusal of [
      'ticket_cash_conservation_preimage_refused',
      'ticket_cash_conservation_gate_count_refused',
      'ticket_cash_conservation_postimage_refused',
      'ticket_cash_conservation_security_refused',
      'ticket_cash_conservation_key_index_refused',
    ])
      expect(CODE).toContain(refusal);
  });

  it('replaces the one arrival gate with one that excludes the cash door leg', () => {
    const oldGate = CODE.split('old_gate constant text := $g$')[1].split('$g$')[0];
    const newGate = CODE.split('new_gate constant text := $g$')[1].split('$g$')[0];
    expect(oldGate).toBe("AND (k.id IS NULL OR k.status = 'redeemed')");
    expect(newGate).toBe(
      "AND (k.id IS NULL OR (k.status = 'redeemed' AND NOT EXISTS (SELECT 1 FROM public.chip_ledger cl WHERE cl.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash' AND cl.category = 'ticket_redeem')))"
    );
  });

  it('writes no row or money and keeps both readings service role only', () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(CODE).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(CODE).toContain(
      "'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public}|t|s'"
    );
  });
});
