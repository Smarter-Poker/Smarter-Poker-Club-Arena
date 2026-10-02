/**
 * A UNION FLOW PROOF PROBES ONLY THE ROWS IT CAN USE
 *
 * Midway's weekly close spent 808 s in fn_union_pnl_original_flow_evidence
 * (2026-10-01): 242 s reading every tournament credit receipt ever written,
 * and the rest probing funding, entry and inventory rows for flows whose own
 * conditions already ruled them out. The predicates are unchanged; they gate
 * the probes instead of filtering after them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(__dirname, '..', 'supabase/migrations/20261001153644_a_union_flow_proof_probes_only_the_rows_it_can_use.sql'),
  'utf8',
);

describe('the union original flow proof', () => {
  it('is patched only from the exact live version, in one transaction', () => {
    expect(SQL).toContain("IF md5(d)<>'e3fa192a9ce146e637eafa48f76be689' THEN RAISE EXCEPTION");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('looks a tournament return up by the flow ledger, not across every credit receipt', () => {
    expect(SQL).toContain('WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id');
    expect(SQL).toContain('WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id');
    expect(SQL.match(/b\.observed_at>=p_start AND b\.observed_at<p_end/g)?.length).toBe(2);
    expect(SQL).toContain("IF position('fn_union_pnl_tournament_returns(NULL' in d)>0");
  });

  it('gates every probe with the flow conditions it already had', () => {
    expect(SQL).toContain('WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true');
    expect(SQL).toContain("WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true");
    expect(SQL).toContain("WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'\n      AND ret.owners IS DISTINCT FROM 1\n      AND i.transaction_id=q.transaction_id");
  });
});
