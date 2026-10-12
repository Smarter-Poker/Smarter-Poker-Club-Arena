import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('V31 immutable rollback extraction', () => {
  it('restores the exact original function body including blank comment lines', () => {
    const runner = readFileSync(
      'scripts/ci/probes/horse-phase4-certified-solver/run-pg17.sh',
      'utf8'
    );
    const expression = runner.match(
      /awk '([^']+)' \\\n\s+"\$ROOT\/supabase\/migrations\/20261007030040[^\n]+/
    );
    expect(expression).not.toBeNull();
    const restored = execFileSync(
      'awk',
      [
        expression![1],
        'supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql',
      ],
      { encoding: 'utf8' }
    );
    const original = readFileSync(
      'supabase/migrations/20261007014629_the_solver_compacts_only_its_matching_verified_source_nodes.sql',
      'utf8'
    );
    const body = (sql: string) => {
      const match = sql.match(
        /CREATE OR REPLACE FUNCTION public\.fn_gto_v31_build_cell\([^]*?AS \$fn\$([^]*?)\$fn\$/i
      );
      expect(match).not.toBeNull();
      return match![1];
    };
    expect(body(restored)).toBe(body(original));
    expect(
      execFileSync('awk', ['{sub(/^-- ?/, "");print}'], {
        input: '--\n-- \n--   x\n',
        encoding: 'utf8',
      })
    ).toBe('\n\n  x\n');
  });
});
