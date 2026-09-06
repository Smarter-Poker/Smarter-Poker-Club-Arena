import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A CLOSED TABLE OWNS NO MAIN INDEX (binding)
 *
 * `fn_closed_cluster_main_releases_index` holds one invariant: a cluster
 * table that is closed or soft-deleted carries no `main_index`. The function
 * was correct on the day it was written. Its TRIGGER was not:
 *
 *   BEFORE INSERT OR UPDATE OF lifecycle, is_deleted
 *
 * That watches the write that CLOSES a table and is blind to the write that
 * STAMPS one. A renumber pass writes `main_index` and `name` and touches
 * neither watched column, so it walks straight past the guard. On 2026-09-05
 * at 10:57:38 CDT, three minutes after the migration that created the guard
 * had nulled them, one statement stamped `main_index` 2..2993 on 2,935 closed
 * tables - every one `role='main'`, every one belonging to the single game
 * (37ac7634, NLH 0.05/0.10 Classic) whose R3 repair had looped and opened
 * 3,000 Main 1 tables that morning. No other game had one; 542 closed cluster
 * tables correctly held NULL.
 *
 * THE GENERAL LESSON, which is what this law is really pinning: a guard whose
 * trigger column list is NARROWER than the invariant its function enforces is
 * a guard that reads as armed while being unreachable. `pg_get_triggerdef`
 * prints it, `tgenabled` says 'O', the catalogue says it exists, and it never
 * fires for the write that breaks the rule.
 *
 * So the column list is pinned here, all four of it: closing a table
 * (`lifecycle`), deleting it (`is_deleted`), stamping it (`main_index`), and
 * making it a cluster table while it already carries one (`cluster_id`).
 *
 * AND THE SHAPE OF THE MIGRATION IS PINNED TOO, because it was bought with a
 * deadlock. Any trigger change on `public.tables` needs ACCESS EXCLUSIVE, and
 * the cluster controller writes that table every five seconds. The first
 * attempt put the trigger DDL and the repair UPDATE in one transaction and
 * deadlocked against the tick; nothing applied. The shipped file is two
 * transactions: the data first, then the DDL holding NOTHING else, opening by
 * asking for the lock explicitly under a short `lock_timeout` so it can only
 * wait for a quiet moment or fail cleanly. Put them back together and the
 * next agent re-buys the deadlock.
 *
 * Verify on production:
 *   select count(*) from tables
 *    where cluster_id is not null and main_index is not null
 *      and (lifecycle = 'closed' or coalesce(is_deleted, false));
 * must be 0.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const TRIGGER = 'trg_tables_closed_main_releases_index';
const FUNCTION = 'fn_closed_cluster_main_releases_index';

/** SQL with every `--` comment line removed, so the ROLLBACK note at the top
 *  of the file - which quotes the OLD narrow trigger on purpose - is never
 *  mistaken for a declaration. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** The LAST migration that declares `what`, which is the one production has. */
function latestDeclaring(what: string): { file: string; sql: string } {
  let found = { file: '', sql: '' };
  for (const f of migrationFiles()) {
    const sql = stripComments(readFileSync(resolve(MIGRATIONS, f), 'utf8'));
    if (sql.includes(what)) found = { file: f, sql };
  }
  return found;
}

/** The statement beginning at `from`, up to and including its terminating `;`. */
function statementAt(sql: string, from: number): string {
  const end = sql.indexOf(';', from);
  return sql.slice(from, end < 0 ? undefined : end + 1);
}

/** The single migration this law was written for. */
function theMigration(): string {
  const file = migrationFiles().find((f) => f.endsWith('_a_closed_table_owns_no_main_index.sql'));
  expect(file, 'the migration that widened the trigger must stay in the tree').toBeDefined();
  return readFileSync(resolve(MIGRATIONS, file as string), 'utf8');
}

/** The columns a `CREATE TRIGGER ... UPDATE OF a, b, c ON ...` watches. */
function watchedColumns(createTrigger: string): string[] {
  const m = /UPDATE\s+OF\s+([\s\S]*?)\s+ON\s/i.exec(createTrigger);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

const REQUIRED = ['lifecycle', 'is_deleted', 'main_index', 'cluster_id'];

describe('a closed table owns no main index', () => {
  it('the live declaration of the trigger watches all four columns', () => {
    const { file, sql } = latestDeclaring(`CREATE TRIGGER ${TRIGGER}`);
    expect(file, `no migration declares ${TRIGGER}`).not.toBe('');

    const create = statementAt(sql, sql.lastIndexOf(`CREATE TRIGGER ${TRIGGER}`));
    const watched = watchedColumns(create);

    for (const col of REQUIRED) {
      expect(
        watched,
        `${file} declares ${TRIGGER} without watching ${col}. A write that ` +
          `touches only ${col} would not fire the guard, and the invariant ` +
          `would be unreachable for exactly that write - which is how 2,935 ` +
          `closed tables got a main_index on 2026-09-05.`
      ).toContain(col);
    }
  });

  it('the old two-column trigger is never the live declaration again', () => {
    const { file, sql } = latestDeclaring(`CREATE TRIGGER ${TRIGGER}`);
    const create = statementAt(sql, sql.lastIndexOf(`CREATE TRIGGER ${TRIGGER}`));
    const watched = watchedColumns(create);

    expect(
      watched.length,
      `${file} narrows ${TRIGGER} back to ${watched.join(', ')}. That is the ` +
        `defect this law exists for: the guard watches the write that closes ` +
        `a table and not the write that stamps one.`
    ).toBeGreaterThan(2);
    expect(watched.slice().sort().join(',')).not.toBe(['is_deleted', 'lifecycle'].join(','));
  });

  it('the function still releases the index when a cluster table is closed or deleted', () => {
    // The DEFINITION, not the `EXECUTE FUNCTION` reference the trigger makes.
    const declares = `CREATE OR REPLACE FUNCTION public.${FUNCTION}()`;
    const { file, sql } = latestDeclaring(declares);
    expect(file, `no migration defines ${FUNCTION}`).not.toBe('');

    // Dollar-quoted, so it is not `statementAt`: the body is full of `;`.
    const start = sql.lastIndexOf(declares);
    const close = sql.indexOf('$fn$;', start + declares.length);
    expect(close, 'the function body must stay dollar-quoted as $fn$').toBeGreaterThan(start);
    const body = sql.slice(start, close);
    expect(body, 'the guard must still test lifecycle').toMatch(/NEW\.lifecycle\s*=\s*'closed'/);
    expect(body, 'the guard must still test is_deleted').toMatch(/NEW\.is_deleted/);
    expect(body, 'closed OR deleted, never AND').toMatch(
      /NEW\.lifecycle\s*=\s*'closed'\s*OR\s*coalesce\(NEW\.is_deleted/i
    );
    expect(body, 'it must only act on cluster tables').toMatch(
      /NEW\.cluster_id\s+IS\s+NOT\s+NULL/i
    );
    expect(body, 'the release is a null, and it is what makes it a BEFORE guard').toMatch(
      /NEW\.main_index\s*:=\s*NULL/i
    );
  });

  it('the cleanup nulls the column and never deletes a row', () => {
    const sql = stripComments(theMigration());

    expect(sql, 'the repair is an UPDATE to NULL').toMatch(
      /UPDATE\s+public\.tables[\s\S]{0,200}?SET\s+main_index\s*=\s*NULL/i
    );
    // A table row is a played hand, a seat history and a ledger reference.
    // The defect was a wrong VALUE in one column, so the repair clears that
    // column. Deleting the rows would destroy the evidence and the history.
    expect(
      /\bDELETE\s+FROM\b/i.test(sql),
      'this migration must never DELETE. The 2,935 rows are real closed ' +
        'tables that were wrongly stamped; only the stamp is wrong.'
    ).toBe(false);
    expect(/\bTRUNCATE\b/i.test(sql), 'and it must never TRUNCATE').toBe(false);
  });

  it('the DDL is its own transaction, takes the lock first, and bounds the wait', () => {
    const sql = stripComments(theMigration());

    // Split on transaction boundaries and find the one carrying the DDL.
    const blocks = sql
      .split(/\bBEGIN\s*;/i)
      .slice(1)
      .map((b) => b.split(/\bCOMMIT\s*;/i)[0]);
    expect(blocks.length, 'the file is two transactions on purpose').toBeGreaterThanOrEqual(2);

    const ddl = blocks.filter((b) => /DROP\s+TRIGGER/i.test(b));
    expect(ddl.length, 'exactly one transaction carries the trigger DDL').toBe(1);
    const block = ddl[0];

    const lockAt = block.search(/LOCK\s+TABLE\s+public\.tables\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE/i);
    expect(
      lockAt,
      'the DDL transaction must ask for ACCESS EXCLUSIVE on public.tables ' +
        'explicitly. It is going to take that lock either way; asking first, ' +
        'holding nothing else, is what makes the wait a wait instead of a ' +
        'deadlock against the five-second cluster tick.'
    ).toBeGreaterThanOrEqual(0);
    expect(
      lockAt,
      'the lock must be taken BEFORE the DROP TRIGGER, not acquired ' +
        'implicitly part-way through the transaction'
    ).toBeLessThan(block.search(/DROP\s+TRIGGER/i));

    expect(
      block,
      'lock_timeout must be set in the DDL transaction, so it fails cleanly ' +
        'having held nothing rather than queueing behind the tick'
    ).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=/i);

    expect(
      /UPDATE\s+public\.tables/i.test(block),
      'the DDL transaction must hold NOTHING else. Putting the repair UPDATE ' +
        'in here is the first attempt, and it deadlocked against the cluster ' +
        'controller and rolled back whole.'
    ).toBe(false);
  });
});
