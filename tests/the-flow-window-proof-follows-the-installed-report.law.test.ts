/**
 * THE FLOW WINDOW PROOF FOLLOWS THE INSTALLED REPORT (2026-10-17)
 *
 * fn_accounting_union_earned_plan_advance proves the week's flows one window
 * at a time only while fn_union_pnl_evidence_report is the reviewed
 * definition, by md5. 20261017034258 moved the report and left that pin on
 * the old md5, which silently switched the window proof off and left the
 * report to prove 814k flows in one statement no tick can hold. Every report
 * md5 pinned anywhere must move together; this law keeps the two in step.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'supabase/migrations';
const sql = readFileSync(
  `${dir}/20261017130300_the_flow_window_proof_follows_the_installed_report.sql`,
  'utf8'
);

describe('the flow window proof follows the installed report', () => {
  it('moves exactly the report pin, from the old report md5 to the installed one', () => {
    expect(sql).toContain(
      "replace(v_def, 'edecfc5273ee4c96b608baa0ea863578', '7b465b7055e80234bd8c40ed5899f4dd')"
    );
    expect(sql).toContain('/ 32 <> 1 THEN');
    expect(sql).toContain("'d6bd67edc007bf42586c980591fd4707'");
    expect(sql).toContain("'64c67ea9c59eaa94d10eb7e0bff1ccdd'");
  });

  it('only moves it while the report and the flow evidence are the reviewed definitions', () => {
    expect(sql).toContain("<> '7b465b7055e80234bd8c40ed5899f4dd'");
    expect(sql).toContain("<> '09745f78c6cc2ae57f403419020fd1ab'");
  });
});
