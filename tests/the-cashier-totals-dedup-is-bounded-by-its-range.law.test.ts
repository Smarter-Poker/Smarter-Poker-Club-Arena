import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const text = (f: string) => readFileSync(resolve(DIR, f), 'utf8');

const INDEX = 'idx_chip_tx_club_time_idempotency_key';

/** A migration line that is not a `--` comment. */
const liveLines = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

/**
 * THE CASHIER TOTALS DE-DUPLICATION IS BOUNDED BY THE RANGE IT WAS ASKED FOR.
 *
 * fn_cashier_statement_totals answered HTTP 500 for real club admins: 21 calls,
 * mean 3,482 ms, max 7,968.7 ms against the 8s statement_timeout, measured on
 * production 2026-09-30. Three earlier migrations had already given both branch
 * scans purpose-built covering indexes, and both were index-only and optimal -
 * so the cost was somewhere nobody had read.
 *
 * It was the omitted_movements CTE, which excludes a chip_ledger movement that a
 * chip_transactions receipt already mirrors. Its first arm filters club and
 * range, but the only index able to serve `metadata ? 'idempotency_key'` is
 * ux_chip_transactions_idempotency_key, keyed on the extracted key alone and
 * carrying neither column. So the planner scanned that index IN FULL - every
 * idempotent receipt on the platform, for every club, for all time - and visited
 * the heap once per entry to filter: 1,154 entries and 828 cold random reads to
 * find 8, 2,709 ms of a 6,038 ms call. A one-day range cost exactly as much as a
 * ninety-two-day one, and the cost grew with platform history rather than with
 * what was asked for.
 *
 * Two things keep that fixed, and this law pins both, because either alone fails
 * SILENTLY - the plan reverts, no test breaks, and the timeout comes back:
 *   1. the partial index exists and is built CONCURRENTLY on a live money table;
 *   2. the CTE still constrains club_id and BOTH ends of created_at, which is
 *      the only reason that index can be range-scanned.
 */
describe('the cashier totals dedup is bounded by its range', () => {
  it('declares the partial index that bounds the dedup to one club and one range', () => {
    const declaring = FILES.filter((f) =>
      new RegExp(`CREATE INDEX[\\s\\S]*${INDEX}`).test(text(f))
    );
    expect(
      declaring,
      `no migration declares ${INDEX}; without it the dedup scans every idempotent receipt ever written`
    ).not.toHaveLength(0);

    const sql = liveLines(text(declaring[declaring.length - 1])).replace(/\s+/g, ' ');

    // Leading keys, in this order: a range scan needs club_id then created_at.
    expect(sql).toMatch(
      new RegExp(
        `${INDEX}\\s+ON\\s+public\\.chip_transactions\\s*\\(\\s*club_id\\s*,\\s*created_at\\s*,`
      )
    );
    // The extracted key is carried so the arm stays index-only (no heap visit).
    expect(sql).toMatch(/\(\s*\(\s*metadata\s*->>\s*'idempotency_key'\s*\)\s*\)/);
    // Partial, so it holds ~1,154 rows rather than all 1,050,406.
    expect(sql).toMatch(/WHERE\s+metadata\s*\?\s*'idempotency_key'/);
  });

  it('builds it CONCURRENTLY, because chip_transactions is on the live money path', () => {
    const declaring = FILES.filter((f) =>
      new RegExp(`CREATE INDEX[\\s\\S]*${INDEX}`).test(text(f))
    );
    const sql = liveLines(text(declaring[declaring.length - 1])).replace(/\s+/g, ' ');
    // A plain CREATE INDEX holds SHARE for the whole build and blocks every
    // INSERT into chip_transactions (CLAUDE.md section 2 rule 7).
    expect(sql).toMatch(new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX}`));
    expect(sql).not.toMatch(new RegExp(`CREATE INDEX (?!CONCURRENTLY)[\\w\\s]*${INDEX}`));
  });

  it('never drops it in a later migration', () => {
    const declaring = FILES.filter((f) =>
      new RegExp(`CREATE INDEX[\\s\\S]*${INDEX}`).test(text(f))
    );
    const declaredIn = declaring[declaring.length - 1];

    // Only migrations AFTER the one that builds it. The declaring migration
    // names the DROP itself, twice and on purpose: once as its online rollback
    // and once inside the RAISE EXCEPTION that tells an operator how to clear
    // an INVALID build. Neither is a drop; both are instructions.
    const droppers = FILES.filter(
      (f) => f > declaredIn && new RegExp(`DROP INDEX[^;]*${INDEX}`).test(liveLines(text(f)))
    );
    expect(
      droppers,
      `${droppers.join(', ')} drops ${INDEX}; the cashier totals timeout returns the moment it goes`
    ).toHaveLength(0);
  });

  it('keeps the club and both range bounds on the arm the index serves', () => {
    // Until 20261007041535 the arm sat in a materialized CTE beside the totals
    // scan; from it on the totals read the same arm first, into an array
    // (tests/two-owner-screens-read-what-they-show.law.test.ts). Either way the
    // newest carrier is the one production runs.
    const CARRIER =
      /WITH omitted_movements AS MATERIALIZED|EXECUTE \$omissions\$SELECT coalesce\(array_agg\(omitted\.id\)/;
    const carrying = FILES.filter((f) => CARRIER.test(text(f)));
    expect(carrying, 'no migration carries the omitted-movement arm any more').not.toHaveLength(0);

    const sql = text(carrying[carrying.length - 1]).replace(/\s+/g, ' ');
    const start = sql.search(CARRIER);
    const arm = sql.slice(start, sql.indexOf(' UNION ', start));

    // Drop any one of these three and the index stops being range-scannable:
    // the planner falls back to the all-time scan and nothing says so.
    expect(arm).toMatch(/represented\.metadata \? 'idempotency_key'/);
    expect(arm).toMatch(/represented\.club_id\s*=\s*\$1/);
    expect(arm).toMatch(/represented\.created_at\s*>=\s*\$3/);
    expect(arm).toMatch(/represented\.created_at\s*<\s*\$4/);
  });
});
