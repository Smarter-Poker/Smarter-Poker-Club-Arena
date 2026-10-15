/**
 * LAW: A RETAINED LATE SETTLEMENT READS ITS CERTIFIED EVIDENCE (2026-10-15).
 *
 * smarter_private.compact_horse_settlement_keys certifies a retained hand with
 * the sha256 of fn_pnl_cash_hand_evidence, the base evidence. The outcome row
 * carries that evidence plus accepted_bbj, accepted_rake and
 * accepted_external_net. fn_union_pnl_prove_late_settlement digested the full
 * outcome evidence, so no retained late seat settlement could ever prove and
 * 22 real settlements of 2026-10-06 blocked the original week. The retained
 * branch now digests the evidence in the shape the certificate was written over.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015132419_a_retained_late_settlement_reads_its_certified_evidence.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('a retained late settlement reads its certified evidence', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: .*'2c1a8c9228ca708965748ccb56e88db9'$/m);
    expect(CODE).toContain("md5(src) <> 'fe123c476dd189b5e5588682c5f8a355'");
    expect(CODE).toContain("md5(src) <> '2c1a8c9228ca708965748ccb56e88db9'");
    expect(CODE).toContain('late_settlement_evidence_security_refused');
  });

  it('digests the outcome evidence without the three accepted keys, and changes nothing else', () => {
    const before = CODE.split('old_line constant text := $o$')[1].split('$o$;')[0];
    const after = CODE.split('new_line constant text := $n$')[1].split('$n$;')[0];
    expect(before).toBe(
      "AND w.retained_evidence_sha=encode(extensions.digest(convert_to(w.evidence::text,'UTF8'),'sha256'),'hex') END"
    );
    expect(after).toBe(
      "AND w.retained_evidence_sha=encode(extensions.digest(convert_to((w.evidence-'accepted_bbj'-'accepted_rake'-'accepted_external_net')::text,'UTF8'),'sha256'),'hex') END"
    );
    expect(CODE).toContain("'late_settlement_evidence_anchor_refused'");
  });

  it('refuses if the certificate writer no longer digests the base evidence', () => {
    expect(CODE).toContain('late_settlement_evidence_certificate_writer_moved');
    expect(CODE).toContain(
      'evidence:=public.fn_pnl_cash_hand_evidence(h.table_id,h.hand_number::bigint);'
    );
  });

  it('writes no row or money', () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
