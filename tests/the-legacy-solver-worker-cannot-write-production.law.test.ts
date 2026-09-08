import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const retiredExecutables = [
  'scripts/piosolver_batch.py',
  'scripts/seed_gto_scenarios.py',
  'scripts/windows_piosolver/.env.example',
  'scripts/windows_piosolver/piosolver_batch_runner.py',
  'scripts/windows_piosolver/requirements.txt',
  'scripts/windows_piosolver/setup.bat',
];

describe('the obsolete solver fleet cannot bypass the certified gateway', () => {
  it.each(retiredExecutables)('%s remains retired', (path) => {
    expect(existsSync(join(root, path))).toBe(false);
  });

  it('keeps an operator-facing tombstone at the old Windows entry point', () => {
    const tombstone = read('scripts/windows_piosolver/README.md');
    expect(tombstone).toContain('RETIRED_UNSAFE_SOLVER_WORKER');
    expect(tombstone).toContain('scripts/horse-solver-v31/');
    expect(tombstone).toMatch(/never receive direct database credentials/i);
    expect(tombstone).not.toMatch(/python\s+piosolver_batch_runner\.py/i);
  });

  it('documents the live V31 boundary instead of the phantom queue', () => {
    const contract = read('docs/SOLVER-DATABASE.md');
    expect(contract).toContain('gto_v31_runtime_cells');
    expect(contract).toContain('zero approved input bundles');
    expect(contract).toMatch(/No solver host receives a Supabase credential/);
    expect(contract).toMatch(/law\s+test prevents those direct-database workers from returning/);
  });
});
