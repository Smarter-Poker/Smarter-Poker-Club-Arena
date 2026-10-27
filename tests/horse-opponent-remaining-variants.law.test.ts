import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  windowDeclaration,
  validateWindowMigration,
} from '../scripts/ci/maintenance-window-migrations.mjs';

const directory = join(process.cwd(), 'supabase/migrations');
const files = readdirSync(directory).filter((f) =>
  f.endsWith('_horse_opponent_memory_remaining_variants.sql')
);

describe('remaining opponent variant storage uses its maintained owner', () => {
  it('queues the hot profile constraint change for certified maintenance', () => {
    expect(files).toHaveLength(1);
    const file = files[0]!;
    const sql = readFileSync(join(directory, file), 'utf8');
    expect(windowDeclaration(sql)).toBe('daily-maintenance');
    expect(() => validateWindowMigration(file, sql, { preamble: [] })).not.toThrow();
    expect(sql).not.toMatch(/ca\.break_window_migration_override|pg_sleep|pg_advisory_lock\s*\(/i);
  });
  it('keeps the real PostgreSQL producer/read regression in required CI', () => {
    const config = readFileSync(
      join(process.cwd(), 'server/vitest.opponent-memory.config.ts'),
      'utf8'
    );
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(config).toContain('tests/HorseOpponentMemory.postgres.test.ts');
    expect(ci).toContain('npx vitest run --config vitest.opponent-memory.config.ts');
  });
});

describe('Pineapple is included in public opponent memory', () => {
  it('keeps the hot constraint change in the existing bounded certified installer', () => {
    const pineapple = readdirSync(directory).filter((f) =>
      f.endsWith('_horse_opponent_memory_pineapple.sql')
    );
    expect(pineapple).toHaveLength(1);
    const sql = readFileSync(join(directory, pineapple[0]!), 'utf8');
    expect(windowDeclaration(sql)).toBe('daily-maintenance');
    expect(() => validateWindowMigration(pineapple[0], sql, { preamble: [] })).not.toThrow();
    expect(sql).toContain("'pineapple'");
    expect(sql).not.toMatch(/ca\.break_window_migration_override|pg_sleep|pg_advisory_lock\s*\(/i);
    const native = readFileSync(
      join(process.cwd(), 'server/tests/HorseOpponentMemory.postgres.test.ts'),
      'utf8'
    );
    expect(native).toContain('Pineapple public opponent memory exact schema extension');
  });
});
