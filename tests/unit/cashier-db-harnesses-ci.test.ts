/**
 * The cashier launch's database qualifications run in CI (2026-10-09).
 *
 * Each migration the cashier launch wrote is qualified by one PostgreSQL 17
 * harness that replays it over production's live text and fails on the live
 * body before it passes on the new one. A harness nobody runs is a claim, not
 * a qualification: this pins every one into the required accounting_postgres
 * job, and pins the classifier so an edit to a harness or its fixture alone
 * still selects that job.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const HARNESSES = [
  [
    'test-chip-request-approval-db-postgres.py',
    'chip-request-approval-db/scenario.sql',
    '20261010003544_a_chip_request_approval_key_belongs_to_its_approver.sql',
  ],
  [
    'test-union-send-db-postgres.py',
    'union-send-db/scenario.sql',
    '20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe.sql',
  ],
  [
    'test-cashier-arena-names-db-postgres.py',
    'cashier-arena-names-db/scenario.sql',
    '20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql',
  ],
  [
    'test-finance-gate-db-postgres.py',
    'finance-gate-db/scenario.sql',
    '20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql',
  ],
  [
    'test-cashier-statement-db-postgres.py',
    'cashier-statements/db-one-move-once.sql',
    '20261012030847_the_statement_counts_each_move_once_and_names_its_wallet.sql',
  ],
  [
    'test-tournament-chat-default-db-postgres.py',
    'tournament-chat-default-db/fixture.sql',
    '20261012040851_tournament_chat_is_off_by_default.sql',
  ],
] as const;

type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };

describe('the cashier database qualifications run in the required accounting job', () => {
  const job = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs.accounting_postgres;

  it.each(HARNESSES)(
    '%s qualifies a migration that exists, from fixtures that exist',
    (harness, fixture, migration) => {
      const source = readFileSync(`scripts/ci/${harness}`, 'utf8');
      expect(existsSync(`tests/fixtures/${fixture}`)).toBe(true);
      expect(existsSync(`supabase/migrations/${migration}`)).toBe(true);
      expect(source).toContain(migration);
    }
  );

  it.each(HARNESSES)('%s runs once, in shard 2, on PostgreSQL 17', (harness) => {
    const steps = (job.steps as Step[]).filter((s) => s.run?.includes(harness));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      if: 'matrix.shard == 2',
      run: `python3 scripts/ci/${harness}`,
      env: { PG_BIN: '/usr/lib/postgresql/17/bin' },
    });
  });

  it.each(HARNESSES)('an edit to %s or its fixture alone selects that job', (harness, fixture) => {
    for (const path of [`scripts/ci/${harness}`, `tests/fixtures/${fixture}`]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({ server: true, tests: true });
    }
  });

  it('selects nothing for a harness that is not one of these', () => {
    expect(classifyChangedPaths(['scripts/ci/test-unrelated-db-postgres.py'])).toMatchObject({
      server: false,
    });
  });
});
