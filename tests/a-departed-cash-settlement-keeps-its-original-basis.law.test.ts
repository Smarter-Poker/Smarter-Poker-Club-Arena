import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read(
  'supabase/migrations/20261012201712_late_departed_seat_settlement_proves_its_original_cash_flow.sql'
);

describe('original late-seat settlement is an explicit nonzero cash-flow class', () => {
  it('binds the original hand, exact funding lineage and wallet rather than current membership', () => {
    expect(migration).toContain('to_jsonb(l)=q.ledger_snapshot');
    expect(migration).toContain('frame.observed_at=q.recognized_at');
    expect(migration).toContain("w.participant->'funding_lineage'");
    expect(migration).toContain('f.id=refs.receipt_id::uuid');
    expect(migration).toContain('credit.amount=w.signed_delta');
    expect(migration).toContain("kind IN('cash_funding','cash_return','cash_late_settlement')");
    expect(migration).not.toMatch(
      /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(?:chip_ledger|club_members|table_seats|union_pnl_cash_outcomes)\b/i
    );
    expect(migration).not.toMatch(/FROM public\.(?:club_members|table_seats)\b/i);
    expect(migration).toContain('original_weekly_accounting_operation_owns_reader_boundary');
    expect(migration).toContain('late_settlement_installation_requires_thawed_platform');
    expect(migration).toContain('late_settlement_installed_postimage_or_access_differs');
  });
  it('executes the actual protected SQL in the existing native accounting lane and retains failure evidence', () => {
    const workflow = read('.github/workflows/ci.yml');
    const start = workflow.indexOf(
      '- name: Departed cash settlement retains original wallet and felt basis'
    );
    expect(start).toBeGreaterThan(0);
    const step = workflow.slice(start, workflow.indexOf('- name: Hand index writers', start));
    expect(step).toContain('if: matrix.shard == 3');
    expect(step).toContain('PGBIN: /usr/lib/postgresql/17/bin');
    expect(step).toContain('bash scripts/dev/probe-late-seat-flow-pg17.sh');
    expect(step).toContain('set -euo pipefail');
    expect(step).toContain('if: always()');
    expect(step).toContain('if-no-files-found: error');
    const probe = read('scripts/dev/probe-late-seat-flow-pg17.sh');
    expect(probe).toContain('"${PSQL[@]}" -f "$MIG"'); // The real provider is used, never a remote URL.
    expect(probe).toContain('admission-refusals.py');
    expect(probe).toContain('boundaries.sql');
    expect(probe).toContain('pg_get_functiondef');
    expect(probe).not.toContain('DATABASE_URL');
  });
  it('keeps every retained native input bound to its exact captured or reviewed bytes', () => {
    const binding = JSON.parse(read('tests/fixtures/late-seat-flow/source-binding.json')) as {
      sourceFiles: Record<string, string>;
    };
    for (const [path, expected] of Object.entries(binding.sourceFiles)) {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
        path
      ).toBe(expected);
    }
  });
});
