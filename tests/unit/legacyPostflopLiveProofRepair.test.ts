import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  resolveDeclaredProofs,
  proofIsRunnable,
} from '../../scripts/ci/check-migrations-are-live.mjs';

it('binds the normalized legacy postflop marker without changing its required postimage', () => {
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
  expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(entry.replaces).toEqual([predicate]);
  expect(entry.proofs).toEqual([predicate]);
  expect(proofIsRunnable(predicate)).toBe(true);
  // The live preimage is intentionally NOT accepted as the desired postimage.
  expect(sql).toContain("md5(p.definition) IS DISTINCT FROM '52e7b71547751e500fa10b59185bd456'");
  expect(predicate).not.toContain('52e7b71547751e500fa10b59185bd456');
});

for (const corruption of ['obsolete-hash', 'obsolete-replacement'] as const) {
  it(`refuses ${corruption} instead of guessing that the normalized marker is equivalent`, () => {
    const directory = resolve(__dirname, '../../supabase/migrations');
    const file = '20261029011340_legacy_postflop_void_preserves_original_principal.sql';
    const sql = readFileSync(resolve(directory, file), 'utf8');
    const registry = JSON.parse(
      readFileSync(resolve(__dirname, '../../scripts/ci/migration-live-proofs.json'), 'utf8')
    );
    const entry = registry.entries.find((item: any) => item.file === file);
    if (corruption === 'obsolete-hash') {
      entry.sha256 = '53431ffdabd682f27dc4718775eaa149ae13fc91e2c43910b789cd40782411a7';
    } else {
      entry.replaces = [`SELECT ${entry.proofs[0]} AS installed;`];
    }
    expect(() => resolveDeclaredProofs(sql, registry, directory)).toThrow(
      corruption === 'obsolete-hash'
        ? 'external live proof migration bytes changed'
        : 'external live proof replacement does not match inline declarations'
    );
  });
}
