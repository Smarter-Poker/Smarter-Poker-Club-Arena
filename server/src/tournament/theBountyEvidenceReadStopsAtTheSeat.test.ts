/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A READ THAT CANNOT FINISH INSIDE ITS OWN TIMEOUT (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `loadPersistedBountyEvidence` proves a bust before a bounty elimination is
 * allowed to mutate anything. It searched the whole of a table's settlement
 * history for the newest row that wrote this player to zero:
 *
 *     Index Scan using settlement_idempotency_keys_pkey
 *       Index Cond: (table_id = ...)
 *       Filter: (result @> ...) AND (status = 'succeeded')
 *       Rows Removed by Filter: 5613
 *     Execution Time: 8523.518 ms
 *
 * `service_role`'s statement timeout is 8s. So the read did not return slowly,
 * it ERRORED - and `defer()` re-armed, and the next sweep ran the same query,
 * and it errored again. Every bust in a bounty event on a long-running table
 * sat in that loop.
 *
 * Read at 06:58 the same morning: sixteen RUNNING tournaments with no hand
 * dealt for over an hour, TEN of them bounty events, each holding between 2 and
 * 13 players at zero chips who could not be eliminated. Busted players keeping
 * their seats meant no table could reach two live players, so no hand could be
 * dealt at all.
 *
 * The bound added below is NOT a new rule. Twenty lines further down, a
 * settlement older than `seatJoinedAt` is already refused - a rebuy starts a
 * new seat generation and an older zero must never authorise it - so every row
 * before the seat was read off disk and then thrown away. Pushing that same
 * condition into the query, against the matching partial index, took it to
 * 88.5 ms.
 *
 * These pins are on the SHAPE of the read, because the shape is the fix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceStatement } from '../testHelpers/sourceWindow.js';

const ELIM = readFileSync(resolve(__dirname, './TournamentManagerEliminations.ts'), 'utf8');
const EVIDENCE = sliceMethod(
  ELIM,
  'loadPersistedBountyEvidence(\n    userId: string,\n    tableId: string,\n    seatJoinedAt: string\n  ): Promise<PersistedKnockoutEvidence | null>'
);
const READ = sliceStatement(ELIM, 'const { data: settlementRow, error: settlementErr }');

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909070610_the_bounty_evidence_read_stops_at_the_seat.sql'
  ),
  'utf8'
);
/**
 * The migration's header EXPLAINS that production got the index with
 * CONCURRENTLY, so a negative pin against the raw file matches its own prose
 * and fails on documentation. Same rule as `testHelpers/sourceWindow`: a pin
 * aims at code, never at a comment. Line comments are all this file has.
 */
const MIGRATION_SQL = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('the bounty evidence read stops at the seat', () => {
  it('the windows under test are real', () => {
    expect(EVIDENCE.length).toBeGreaterThan(500);
    expect(READ).toContain("from('settlement_idempotency_keys')");
  });

  it('bounds the scan at the seat generation it is already required to be inside', () => {
    // Without this the query reads the table's entire history and the guard
    // below throws most of it away - which is what timed out.
    expect(READ, 'the read must not scan before the seat it is proving').toContain(
      ".gte('completed_at', seatJoinedAt)"
    );
  });

  it('still asks for the newest match, and only one', () => {
    // The bound narrows the range; it must not change which row wins.
    expect(READ).toContain(".order('completed_at', { ascending: false })");
    expect(READ).toContain('.limit(1)');
    expect(READ).toContain(".eq('status', 'succeeded')");
    expect(READ).toContain("contains('result'");
  });

  it('keeps the seat-generation guard that the bound mirrors', () => {
    // If this guard is ever removed the bound above stops being equivalent and
    // becomes a behaviour change. They live and die together.
    expect(EVIDENCE).toContain('predates this seat generation');
    expect(EVIDENCE).toMatch(/settlementAt\s*<\s*joinedAt/);
  });

  it('an unreadable answer still defers instead of being read as "no evidence"', () => {
    // The whole defect was an error being retried for ever; the refusal itself
    // is correct and must stay. UNKNOWN is not NONE (CLAUDE.md 10.86 rule 2).
    expect(EVIDENCE).toContain('accepted zero-stack settlement is unreadable');
    expect(EVIDENCE).toContain('no exact accepted zero-stack settlement exists yet');
  });

  it('the index the plan depends on is recorded in a migration', () => {
    // A query tuned to an index that exists only on production is a query that
    // works until somebody rebuilds the database from these files.
    expect(MIGRATION_SQL).toContain('idx_settlement_idem_table_completed_succeeded');
    expect(MIGRATION_SQL).toMatch(/\(table_id,\s*completed_at DESC\)/);
    expect(MIGRATION_SQL).toMatch(/WHERE status = 'succeeded'/);
    expect(MIGRATION_SQL).toContain('IF NOT EXISTS');
  });

  it('the migration does not try to run CONCURRENTLY inside a transaction', () => {
    // Production got it with CONCURRENTLY so no settlement write was blocked on
    // a live 3.2 GB table; the recorded copy cannot use it, and must not.
    expect(MIGRATION_SQL).not.toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(MIGRATION_SQL).not.toMatch(/^BEGIN;/m);
  });

  it('says how it reached production, so the next index build is not re-learned', () => {
    // The prose is load-bearing here: the first attempt timed out and left the
    // index indisvalid=false at 168 MB, which is worse than no index at all
    // because the planner ignores it and every write still maintains it.
    expect(MIGRATION).toContain('CREATE INDEX CONCURRENTLY');
    expect(MIGRATION).toMatch(/indisvalid/);
  });
});
