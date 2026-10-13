import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read(
  'supabase/migrations/20261012224150_original_retirement_evidence_certifies_finite_inventory_boun.sql'
);
const runnerPath = 'scripts/qualification/original-retirement-boundary/run-native.py';

describe('an original inventory gap needs its financial evidence', () => {
  it('binds every maintained native source and financial input to its exact bytes', () => {
    const binding = JSON.parse(
      read('scripts/qualification/original-retirement-boundary/source-binding.json')
    ) as { sourceFiles: Record<string, string> };
    expect(Object.keys(binding.sourceFiles).length).toBeGreaterThan(65);
    for (const [path, digest] of Object.entries(binding.sourceFiles))
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(process.cwd(), path)))
          .digest('hex'),
        path
      ).toBe(digest);
    expect(binding.sourceFiles[runnerPath]).toBeDefined();
    expect(
      binding.sourceFiles[
        'scripts/qualification/original-retirement-boundary/run-installer-native.py'
      ]
    ).toBeDefined();
  });
  it('retains the original raw readers and immutable sealed financial authority', () => {
    for (const guard of [
      'original_inventory_install_postimage_refused',
      'original_inventory_certificate_unknown_or_replayed',
      'original_inventory_certificate_canonical_reproof_refused',
      'raw_sealed_projection_or_cache_refused',
      'original_inventory_restoration_evidence_is_immutable',
      'dd5e733acc7ed72e69b98d009ac124a6',
    ])
      expect(migration).toContain(guard);
    expect(migration).not.toMatch(
      /^CREATE(?: OR REPLACE)? FUNCTION public\.fn_union_pnl_inventory_(?:population|state|as_of)\(/im
    );
  });

  it('executes native financial qualification and retains failures in the existing accounting lane', () => {
    const workflow = read('.github/workflows/ci.yml');
    const start = workflow.indexOf(
      '- name: Original inventory restoration admits only qualified finite financial evidence'
    );
    expect(start).toBeGreaterThan(0);
    const steps = workflow.slice(start, workflow.indexOf('- name: Hand index writers', start));
    for (const guard of [
      'if: matrix.shard == 3',
      'PG_BIN: /usr/lib/postgresql/17/bin',
      'set -euo pipefail',
      `python3 ${runnerPath} --output`,
      'if: always()',
      'if-no-files-found: error',
    ])
      expect(steps).toContain(guard);
    const runner = read(runnerPath);
    for (const guard of [
      'PG_BIN',
      'ON_ERROR_STOP=1',
      "run('exact-installer'",
      "run('certificate-concurrency'",
      "run('raw245'",
      "run('cache-generation'",
      "run('retention'",
      "run('current-seven'",
    ])
      expect(runner).toContain(guard);
  });
});
