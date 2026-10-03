/**
 * LAW: MEMBER DRIFT COUNTS BOTH SIDES OF A LEG (2026-10-03).
 *
 * fn_chip_integrity_report read CRITICAL for two days: 670 members drifting,
 * worst 103,747.97. The drifts summed to exactly 0.00. The drift reader put
 * each journal leg under ONE player and summed both sides there, so a leg
 * between two player wallets (rakeback and commission, paid wallet to wallet
 * since 2026-09-29) netted to zero for the receiver and never reached the
 * payer. Counting each side for the member it names, all 1,502 baseline
 * memberships reconcile to the cent.
 *
 * What this pins: the newest fn_chip_drift_since_baseline on disk counts the
 * to side as +amount for its own entity and the from side as -amount for its
 * own entity, and never again names one player per leg.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MIGS = resolve(process.cwd(), 'supabase/migrations');
const MIG = readFileSync(
  resolve(MIGS, '20261003131341_member_drift_counts_both_sides_of_a_leg.sql'),
  'utf8'
);

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline(');
  expect(start, 'the drift reader is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_chip_drift_since_baseline\s*\(/;
  const files = readdirSync(MIGS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  const hit = files.find((f) => re.test(readFileSync(resolve(MIGS, f), 'utf8')));
  if (!hit) throw new Error('fn_chip_drift_since_baseline is never declared');
  return hit;
}

const FN = declaration(MIG);
const code = FN.replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('member drift counts both sides of a leg', () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('6e7f006fb462ab5e008f94a6d6df63e8');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM 'd0f1d4f355477669a4bc0427de757581'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('MEMBER_DRIFT_' + c);
    expect(MIG).toContain('IF v_drifting <> 0 THEN');
  });

  it('counts the to side and the from side each for its own member', () => {
    expect(code).toMatch(
      /SELECT cl\.club_id AS c_id, cl\.to_entity_id AS u_id, cl\.amount AS amt[\s\S]*?AND cl\.to_type = 'player_wallet'/
    );
    expect(code).toMatch(
      /SELECT cl\.club_id, cl\.from_entity_id, -cl\.amount[\s\S]*?AND cl\.from_type = 'player_wallet'/
    );
    expect(code).toContain('UNION ALL');
  });

  it('never again names one player per leg', () => {
    expect(code).not.toMatch(/CASE WHEN cl\.to_type = 'player_wallet' THEN cl\.to_entity_id/);
    expect(code).not.toMatch(/COALESCE\(\s*cl\.to_entity_id\s*,\s*cl\.from_entity_id\s*\)/i);
  });

  it('is closed to browsers and is the newest declaration on disk', () => {
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM PUBLIC, anon, authenticated;'
    );
    expect(MIG).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role;'
    );
    expect(newestFile()).toBe('20261003131341_member_drift_counts_both_sides_of_a_leg.sql');
  });
});
