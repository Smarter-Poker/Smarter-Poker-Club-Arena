/**
 * AN AUTHORED EQUAL BLIND LEVEL CAN OPEN A TABLE (2026-10-24)
 *
 * The owner's October 20 Midway standard opens at 25/25. The late-registration
 * capacity check refused SB >= BB, so during that level no table could be
 * opened: 180 late registrations and 9 rebuys refused in a day. SB > BB is
 * still refused; SB = BB is a level.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const sql = read(
  'supabase/migrations/20261024194135_an_authored_equal_blind_level_can_open_a_table.sql'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('an authored equal blind level can open a table', () => {
  it('is one transaction with a live proof', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(sql).toMatch(/^-- @live-proof: .*v_sb>v_bb THEN.*v_sb>=v_bb THEN.*=0\)$/m);
  });

  it('changes exactly the SB >= BB refusal to SB > BB on the measured body', () => {
    expect(code).toContain("v_old constant text := 'OR v_ante<0 OR v_sb>=v_bb THEN';");
    expect(code).toContain("v_new constant text := 'OR v_ante<0 OR v_sb>v_bb THEN';");
    expect(code).toMatch(/md5\(v_src\) <> 'c971b2727cdd42e8a9642523a81e8364'/);
  });

  it('keeps the capacity function service-role only', () => {
    expect(code).toContain("has_function_privilege('service_role', p.oid, 'EXECUTE')");
    expect(code).toContain("NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    expect(code).toContain("NOT has_function_privilege('anon', p.oid, 'EXECUTE')");
  });

  it('matches the owner structure it exists for: Midway opens at 25/25', () => {
    const policy = read('server/src/tournament/MidwayStructurePolicy.law.test.ts');
    expect(policy).toContain('smallBlind: 25, bigBlind: 25, ante: 0');
  });
});
