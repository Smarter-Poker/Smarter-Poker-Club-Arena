import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(
    root,
    'supabase/migrations/20261012161442_an_original_unchanged_stack_is_proved_from_its_accepted_pred.sql'
  ),
  'utf8'
);
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const probe = readFileSync(
  resolve(root, 'scripts/dev/probe-original-unchanged-stack-pg17.sh'),
  'utf8'
);
describe('original unchanged stacks retain a distinct primary-evidence contract', () => {
  it('adds a separate per-hand certificate and preserves the existing late-credit reader and consumer', () => {
    expect(migration).toContain('d3f0d6d189f378cab4446e2573792721');
    expect(migration).toContain('7e443fd75f3b1ece7cd0713a6b8fc0a5');
    expect(migration).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION public\.fn_union_pnl_prove_late_seat_credit/
    );
    expect(migration).not.toMatch(
      /\b(?:UPDATE|DELETE FROM|INSERT INTO)\s+public\.(?:chip_ledger|player_wallets|table_seats|union_pnl_cash_outcomes)\b/i
    );
    expect(migration).toContain('original_stack_unchanged_since_accepted_predecessor');
    expect(migration).toContain('prev_receipt.accepted_request');
    expect(migration).toContain('intervening_original_input');
    expect(migration).toContain('earning_club_id');
  });
  it('enforces the native originals, rollback, concurrency and negative controls through the existing accounting job', () => {
    const start = workflow.indexOf(
      '- name: Original unchanged cash stacks retain signed predecessor evidence'
    );
    expect(start).toBeGreaterThan(0);
    const step = workflow.slice(start, workflow.indexOf('- name: Agent downline', start));
    expect(step).toContain('if: matrix.shard == 3');
    expect(step).toContain('PGBIN: /usr/lib/postgresql/17/bin');
    expect(step).toContain('bash scripts/dev/probe-original-unchanged-stack-pg17.sh');
    expect(step).toContain('set -euo pipefail');
    expect(step).toContain('if: always()');
    expect(step).toContain('if-no-files-found: error');
    expect(probe).toContain('rollback-install.sql');
    expect(probe).toContain('real-cases.sql');
    expect(probe).toContain('concurrency.py');
    expect(probe).not.toContain('DATABASE_URL');
  });
});
