import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STUCK_THAW_MIGRATION,
  stuckThawRequest,
  validateStuckThaw,
  bindStuckThawTransaction,
} from '../scripts/ci/stuck-thaw-migration-admission.mjs';
const sql = readFileSync(`supabase/migrations/${STUCK_THAW_MIGRATION}`, 'utf8');
const token = '00000000-0000-0000-0000-000000000001';
const reason = "Restore the failed original thaw's typed trigger without clearing its freeze";
const request = stuckThawRequest(STUCK_THAW_MIGRATION, sql, reason, token, false);
const state = {
  phase: 'counting_down',
  enforce_freeze: true,
  ownership_token: token,
  announced_at: '2026-10-13T13:53:00.001Z',
  break_started_at: '2026-10-13T13:55:00.001Z',
  break_ends_at: '2026-10-13T14:00:00.001Z',
  observed_at: '2026-10-13T15:20:00Z',
  thaw_count: 0,
};
describe('one exact emergency repair retains the original maintenance owner', () => {
  it('defaults to the ordinary refusal path', () =>
    expect(stuckThawRequest(STUCK_THAW_MIGRATION, sql, null, null, false)).toBeNull());
  it.each([
    ['other.sql', sql, reason, token, false],
    [STUCK_THAW_MIGRATION, sql + ' ', reason, token, false],
    [STUCK_THAW_MIGRATION, sql, reason, token, true],
    [STUCK_THAW_MIGRATION, sql, '', token, false],
    [STUCK_THAW_MIGRATION, sql, reason, 'wrong', false],
  ])('refuses unbound or mixed emergency options', (file, source, auditReason, owner, conflict) =>
    expect(() => stuckThawRequest(file, source, auditReason, owner, conflict)).toThrow()
  );
  it('accepts only the inspected overdue uncredited owner', () =>
    expect(() => validateStuckThaw([state], request)).not.toThrow());
  it.each([
    { phase: 'last_hand' },
    { enforce_freeze: false },
    { ownership_token: '00000000-0000-0000-0000-000000000002' },
    { thaw_count: 1 },
    { announced_at: '2026-10-13T14:53:00.001Z' },
    { observed_at: '2026-10-13T15:55:00Z' },
    { observed_at: '2026-10-13T14:10:00Z' },
  ])('refuses changed boundary %j', (change) =>
    expect(() => validateStuckThaw([{ ...state, ...change }], request)).toThrow()
  );
  it('binds audit reason and fresh locked admission before original DDL without modifying source bytes', () => {
    const bound = bindStuckThawTransaction(sql, request);
    expect(bound.indexOf('pg_advisory_xact_lock(530090,1)')).toBeLessThan(
      bound.indexOf('DO $launch_transport$')
    );
    expect(bound).toContain(
      "set_config('ca.break_window_migration_override','Restore the failed original thaw''s typed trigger"
    );
    expect(bound).toContain('FOR UPDATE');
    expect(bound).toContain('STUCK_THAW_ADMISSION_CHANGED');
    expect(bound).not.toMatch(
      /DELETE FROM|UPDATE public\.engine_maintenance_break|SET enforce_freeze/
    );
    expect(
      bound.replace(
        /\nSET LOCAL statement_timeout='8s';[\s\S]*?END \$ca_stuck_thaw_admission\$;\n/,
        ''
      )
    ).toBe(sql);
  });
  it('the existing owning installer retains exact original history and dispatch-only default', () => {
    const installer = readFileSync('scripts/ci/apply-recorded-migration.mjs', 'utf8');
    expect(installer).toContain('if (refusal && !stuckThaw)');
    expect(installer).toContain('const exactSQLLiteral = historyTag + sql + historyTag');
    expect(installer).toContain('bindStuckThawTransaction(transactionBody, stuckThaw)');
    const workflow = readFileSync('.github/workflows/apply-merged-migration.yml', 'utf8');
    expect(workflow).toContain('STUCK_THAW_REASON: ${{ inputs.stuck_thaw_reason }}');
    expect(workflow).toContain(
      '--stuck-thaw-reason "$STUCK_THAW_REASON" --stuck-thaw-owner "$STUCK_THAW_OWNER"'
    );
  });
});
