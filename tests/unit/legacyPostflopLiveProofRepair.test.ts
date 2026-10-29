import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveDeclaredProofs,
  proofIsRunnable,
} from '../../scripts/ci/check-migrations-are-live.mjs';

it('uses the corrected protected inline postflop proof without a stale external byte override', () => {
  const directory = resolve(__dirname, '../../supabase/migrations');
  const file = '20261029011340_legacy_postflop_void_preserves_original_principal.sql';
  const bytes = readFileSync(resolve(directory, file));
  const sql = bytes.toString('utf8');
  const registry = JSON.parse(
    readFileSync(resolve(__dirname, '../../scripts/ci/migration-live-proofs.json'), 'utf8')
  );
  const predicate =
    "md5(pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure)) = 'e416f1fa850c85d656ec55ddfae3386d'";
  expect(resolveDeclaredProofs(sql, registry, directory)).toEqual([predicate]);
  const entry = registry.entries.find((item: any) => item.file === file);
  expect(entry).toBeUndefined();
  expect(sql).toContain(`-- @live-proof: ${predicate}\n`);
  expect(sql).not.toContain(`-- @live-proof: SELECT ${predicate} AS installed;`);
  expect(proofIsRunnable(predicate)).toBe(true);
  // The live preimage is intentionally NOT accepted as the desired postimage.
  expect(sql).toContain("md5(p.definition) IS DISTINCT FROM '52e7b71547751e500fa10b59185bd456'");
  expect(predicate).not.toContain('52e7b71547751e500fa10b59185bd456');
});
