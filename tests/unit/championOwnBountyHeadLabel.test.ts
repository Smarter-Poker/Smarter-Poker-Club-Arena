/**
 * THE CHAMPION'S OWN HEAD IS LABELLED AS HIS OWN (20261005184659).
 *
 * fn_finalize_bounty_pool pays the champion the bounty pool nobody claimed,
 * which always contains the champion's own head, and the wallet called all of
 * it "Unclaimed bounty pool awarded to champion". The migration changes the
 * label only. This pins that it is an asserted, label-only substitution.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261005184659_the_champion_s_own_bounty_head_is_labelled_as_his_own.sql'
  ),
  'utf8'
);
const body = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe("the champion's own bounty head label", () => {
  it('names the own head when that is all the residual is, and both parts otherwise', () => {
    expect(body).toContain("Tournament champion: own bounty head returned''");
    expect(body).toContain(
      'Tournament champion: own bounty head returned with unclaimed bounty pool'
    );
    expect(body).toContain('WHEN v_residual <= own.head');
    expect(body).toContain('NULLIF(tp.current_bounty, 0)');
  });

  it('keeps the old wording only when the champion holds no head', () => {
    expect(body).toMatch(
      /WHEN COALESCE\(own\.head, 0\) <= 0\\n'\s*\|\| E'\s*THEN ''Unclaimed bounty pool awarded to champion''/
    );
  });

  it('is an asserted substitution against the pinned live text, in one transaction', () => {
    expect(body).toContain("'96417e3cbe35661ced11437cbbb18613'");
    expect(body).toMatch(/IF v_n <> 1 THEN/);
    expect(body).toMatch(/the reverse substitution does not reproduce the pinned text/);
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('changes the label and nothing that moves money', () => {
    // The replaced clause starts at the amount argument, which is carried
    // through unchanged; no UPDATE, INSERT or settle call is added.
    expect(body).not.toMatch(/\bUPDATE\b|\bINSERT\b|fn_credit_and_log/);
    expect(
      body.match(/round\(v_prior \+ v_residual, 2\), ''fn_finalize_bounty_pool'',/g)
    ).toHaveLength(2);
  });
});
