/**
 * A custody release either commits every Diamond rail or commits none of them.
 * There is no obligation row, delayed sweep, reconciliation writer, or second
 * chance that can pay from a different source after the request returns.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const migrations = resolve(root, 'supabase/migrations');

const migrationEnding = (suffix: string): string => {
  const file = readdirSync(migrations).find((name) => name.endsWith(suffix));
  if (!file) throw new Error(`Missing migration ending ${suffix}`);
  return readFileSync(resolve(migrations, file), 'utf8');
};

const seal = migrationEnding('_seal_diamond_custody_retry_doors_before_retirement.sql');
const atomic = migrationEnding('_diamond_custody_release_is_atomic_without_recovery.sql');
const internalAcl = migrationEnding('_diamond_internal_writers_are_service_only.sql');
const explicitAcl = migrationEnding('_diamond_internal_writer_acl_contract_is_explicit.sql');
const manifest = JSON.parse(
  readFileSync(
    resolve(root, 'scripts/ci/schema-manifest.d/codex-poker-diamond-custody.json'),
    'utf8'
  )
);
const atomicProbe = readFileSync(
  resolve(root, 'tests/sql/diamond-custody-atomic-release.sql'),
  'utf8'
);

const releaseBodyMatch = atomic.match(
  /CREATE OR REPLACE FUNCTION public\.fn_poker_diamond_release\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/
);
if (!releaseBodyMatch) throw new Error('Atomic Diamond release body is missing');
const releaseBody = releaseBodyMatch[1];

describe('Diamond custody has one atomic release writer', () => {
  it('seals every old entry point behind an exact zero-use preflight', () => {
    for (const fn of [
      'fn_poker_diamond_reserve',
      'fn_poker_diamond_release',
      'fn_poker_diamond_reconcile',
      'fn_poker_diamond_recover_releases',
    ]) {
      expect(seal).toContain(fn);
    }
    expect(seal).toMatch(/md5\(pg_get_functiondef\(v_proc\)\)/);
    expect(seal).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(seal).toContain(
      'Diamond custody was used after its verified zero-row production inventory'
    );
    expect(seal).toContain('COMMIT;');
  });

  it('raises inside the transaction when wallet credit is refused', () => {
    expect(releaseBody).toContain('public.add_diamonds_to_balance(');
    expect(releaseBody).toContain("RAISE EXCEPTION 'diamond_release_credit_failed:%'");
    expect(releaseBody).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(releaseBody).not.toMatch(/obligation|pending|recover|reconcil/i);

    const credit = releaseBody.indexOf('v_credit := public.add_diamonds_to_balance(');
    const custodyClosed = releaseBody.indexOf('UPDATE public.poker_diamond_custody');
    const movement = releaseBody.indexOf('INSERT INTO public.poker_diamond_movements');
    expect(credit).toBeGreaterThan(-1);
    expect(custodyClosed).toBeGreaterThan(credit);
    expect(movement).toBeGreaterThan(custodyClosed);
  });

  it('retires every delayed writer and its queue in the same locked cutover', () => {
    expect(atomic).toContain('DROP FUNCTION public.fn_poker_diamond_recover_releases();');
    expect(atomic).toContain('DROP FUNCTION public.fn_poker_diamond_reconcile();');
    expect(atomic).toContain('DROP TABLE public.poker_diamond_obligations;');
    expect(atomic).toMatch(
      /LOCK TABLE[\s\S]*public\.poker_diamond_obligations[\s\S]*IN SHARE ROW EXCLUSIVE MODE;/
    );
    expect(atomic).toContain(
      'GRANT EXECUTE ON FUNCTION\n  public.fn_poker_diamond_release(uuid,uuid)\nTO service_role;'
    );
  });

  it('declares only the permanent custody surface in the schema overlay', () => {
    expect(manifest.tables).toEqual([
      'poker_diamond_custody',
      'poker_diamond_lot_reservations',
      'poker_diamond_movements',
    ]);
    expect(manifest.removedTables).toEqual(['poker_diamond_obligations']);
    expect(manifest.removedFunctions).toEqual([
      'fn_poker_diamond_reconcile',
      'fn_poker_diamond_recover_releases',
    ]);
  });

  it('keeps every internal Diamond writer behind the service role', () => {
    for (const fn of [
      'add_diamonds_to_balance(uuid,integer,text,text,text)',
      'fn_ca_consume_purchase_lots(uuid,bigint)',
      'fn_ca_diamond_snapshot()',
    ]) {
      expect(internalAcl).toContain(fn);
    }
    expect(internalAcl).toContain('FROM PUBLIC, anon, authenticated;');
    expect(internalAcl).toContain('TO service_role;');
    expect(internalAcl).toContain("has_function_privilege('public', v_proc, 'EXECUTE')");
    expect(explicitAcl.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(3);
    expect(explicitAcl.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(3);
  });

  it('proves commit, immutable replay, and refusal without missing-row false positives', () => {
    expect(atomicProbe).toContain('v_replay IS DISTINCT FROM v_receipt');
    expect(atomicProbe.match(/public\.fn_poker_diamond_release\(/g)).toHaveLength(3);
    expect(atomicProbe).toContain('receipt = v_receipt) <> 1');
    expect(atomicProbe).toContain("type = 'arena_withdraw'");
    expect(atomicProbe).toContain('IS DISTINCT FROM true');
    expect(atomicProbe).toContain(
      "SQLERRM NOT LIKE 'diamond_release_credit_failed:duplicate_reference%'"
    );
    expect(atomicProbe.trimEnd()).toMatch(/ROLLBACK;$/);
  });
});
