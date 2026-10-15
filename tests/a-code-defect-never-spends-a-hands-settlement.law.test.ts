/**
 * LAW: A CODE DEFECT NEVER SPENDS A HAND'S ONE SETTLEMENT CLAIM (2026-10-15).
 *
 * A retained tournament hand gets exactly one successor financial attempt. On
 * 2026-10-13 a trigger read a column its table did not have (record "new" has
 * no field "metadata"); every settlement it touched rolled back, and the resume
 * recorded each rollback as the hand's financial refusal. 217 hands were
 * stranded; 209 were rescued by a frozen list, and 8 more froze the 6:00 AM
 * Freeroll (a38b88a9) for 35 hours with 58 players seated.
 *
 * Root: the settlement returns its SQLSTATE and the resume treats a class 42,
 * 0A or XX rollback as an admission refusal, so the claim rolls back. Recovery:
 * the same cause is proved from a hand's own rows (no list) and the 8 hands are
 * certified through the existing operator door; the engine settles them once.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015011723_a_code_defect_never_spends_a_hands_one_settlement_claim.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe("a code defect never spends a hand's one settlement claim", () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_ca_resume_hand_submission\(uuid,text,uuid\)'::regprocedure\)\)='0af98f5b0e305b8c68f7ba8657ec66bf'\)$/m
    );
    for (const pin of [
      'f604ff7504222829d1b5b85d299af242',
      '7c81a81de14275cf79ec2bc947f42884',
      '951110d34bda83ed99b49256e42f05e3',
      '52a667146a924fe2c924aae5e70cb2eb',
      '4f8a0958e5785cb557ddf413d3d9b015',
      'ff16a5b791b4e2d01b7ab4ee62a85c0e',
      '9d0abf53683ad943b18eb8a173fb0556',
      '0af98f5b0e305b8c68f7ba8657ec66bf',
      'b235c4e928096546f3cae16732a1bb34',
      '52562ec4b4097f3e5d19e0626766ea64',
    ])
      expect(CODE).toContain(pin);
    expect(CODE).toContain('defect_claim_security_refused');
    expect(CODE).toContain('defect_claim_sources_refused');
  });

  it('the settlement names its SQLSTATE and the resume rolls a code-defect rollback back', () => {
    expect(CODE).toContain("'sqlstate', SQLSTATE,");
    expect(CODE).toContain(
      "OR (r->>'reason'='rolled_back' AND left(COALESCE(r->>'sqlstate',''),2) IN ('42','0A','XX'))"
    );
  });

  it("proves the defect from the hand's own rows, with no list, and keeps every guard", () => {
    const proof = CODE.slice(
      CODE.indexOf(
        'CREATE OR REPLACE FUNCTION smarter_private.metadata_defect_source_correction_proof'
      ),
      CODE.indexOf('REVOKE ALL ON FUNCTION smarter_private.metadata_defect_source_correction_proof')
    );
    expect(proof).not.toMatch(/\(VALUES/);
    for (const guard of [
      "encode(sha256(convert_to(s.request::text,'UTF8')),'hex') IS DISTINCT FROM s.request_hash",
      'z.result->>\'error\' IS DISTINCT FROM \'record "new" has no field "metadata"\'',
      "p.state IS DISTINCT FROM 'reserved'",
      "upper(t.status)='RUNNING'",
      'hand_submission_correction_claims WHERE submission_id=e',
      'hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number',
      "version='20261013133012'",
      "tf.prosrc ~* 'NEW\\.metadata'",
      "'key_md5',md5(to_jsonb(k)::text)",
    ])
      expect(proof).toContain(guard);
  });

  it('certifies exactly the proved cohort through the existing door and pays nothing itself', () => {
    expect(CODE).toContain('defect_claim_cohort_moved');
    expect(CODE).toContain('smarter_private.certify_original_hand_source_correction(e)');
    expect(CODE).toContain("c->>'financial_payment' IS DISTINCT FROM 'false'");
    expect(CODE).toContain('defect_claim_claimed_early');
    expect(CODE).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\b[^;]*\b(?:chip_ledger|chip_transactions|club_members|table_seats|tournament_players|hand_submission_correction_claims)\b/i
    );
    expect(CODE).not.toMatch(/\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT)\b/i);
  });
});
