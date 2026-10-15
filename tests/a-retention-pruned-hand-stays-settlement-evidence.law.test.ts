/**
 * LAW: A HAND RETENTION PRUNED STAYS SETTLEMENT EVIDENCE (2026-10-14).
 *
 * The original week (Oct 5 -> Oct 12) stopped settling after attempt 70 with
 * original_restoration_cash_flow_source_refused. Its finite 245-case inventory
 * pins 93 settled horse cash hands by their atomic commit and their signed
 * request. sp_prune_hand_history deletes a horse hand's commit eight days after
 * it settles (CLAUDE.md 10.5 ruling 1) and writes a retention disposal from the
 * live row in the same transaction, but the verifier read only the deleted row,
 * so 44 certified refs became unverifiable for ever.
 *
 * The fix lives in the verifier, where the wrong answer was produced: a pruned
 * commit verifies through exactly one retention disposal for the same
 * submission, with every recorded identity, flag and boundary checked, and
 * nothing else. Live hands keep the original digest path. The discharge getter
 * pin and the finite-40 source authority move with it in one transaction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261014225815_original_inventory_refs_verify_through_retention_disposal.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('a retention-pruned hand stays settlement evidence', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('smarter_private\.original_inventory_source_ref_md5\(jsonb\)'::regprocedure\)\)='81fba77f13564999931e8a7a47cbd609'\)$/m
    );
    for (const pre of [
      '1411d22a7ad914a80922aeed8bfcf7e6',
      '92624d180575de6759e928278e9c2c6b',
      '2f0091a1c85eb9f4ffadce1142ba31a4',
    ])
      expect(CODE).toContain(pre);
    for (const post of [
      '81fba77f13564999931e8a7a47cbd609',
      '9e6fcbf606004b81353a7704b50f072f',
      '4a98179afccf2d31c127f50ed5ab9270',
    ])
      expect(CODE).toContain(post);
    expect(CODE).toContain('original_refs_retention_anchor_refused');
    expect(CODE).toContain('original_refs_retention_security_refused');
    expect(CODE).toContain('original_refs_retention_post_source40_refused');
  });

  it('accepts a pruned commit only through its own retention disposal', () => {
    expect(CODE).toContain(
      'SELECT count(*) INTO n FROM smarter_private.hand_submission_disposals t WHERE t.submission_id=v_ref_id;'
    );
    expect(CODE).toContain("d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'");
    expect(CODE).toContain("d.expected->>'settlement_completed' IS DISTINCT FROM 'true'");
    expect(CODE).toContain("d.expected->>'pruned_hand_id' IS DISTINCT FROM v_ref_id::text");
    expect(CODE).toContain("d.expected->>'request_hash' IS DISTINCT FROM s.request_hash");
    expect(CODE).toContain(
      "(d.expected->>'disposed_at')::timestamptz < (d.expected->>'settlement_completed_at')::timestamptz+interval '8 days'"
    );
    expect(CODE).toContain('EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=v_ref_id)');
    expect(CODE).toContain("ref->>'md5' !~ '^[0-9a-f]{32}$'");
  });

  it('never trusts a claimed digest while the commit still exists', () => {
    // The fallback is reachable only when the live lookup found no row.
    expect(CODE).toMatch(/WHERE t\.hand_id=v_ref_id;\n\s*IF n=0 THEN/);
  });

  it('writes no money, certificate, cache, schedule or retention policy', () => {
    expect(CODE).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\b[^;]*\b(?:chip_ledger|chip_transactions|club_members|wallet|accounting_close_certificates|union_accounting_runs|hand_history_retention_policy)\b/i
    );
    expect(CODE).not.toMatch(/\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT|REVOKE)\b/i);
  });
});
