/**
 * THE BATCH FLOOR GUARD (Dan 2026-08-30).
 *
 * On 2026-08-30 a full-body `CREATE OR REPLACE` of
 * `fn_aggregate_gto_street_next`, built from a copy of the body fetched
 * before #1849 landed, silently reverted that migration's measured batch
 * floor from `greatest(25, ...)` back to `greatest(200, ...)`. The deployed
 * driver passes 100; the clamp raised it to 200; and 200 is the timeout
 * cliff (~8s, one call in three cancelled) that #1849 existed to escape.
 * The aggregation cursor froze until someone re-measured the throughput.
 *
 * Nothing caught it: the migration gate checks that declared objects EXIST,
 * not that a later migration failed to overwrite an earlier one's tuning.
 *
 * This is the cheap guard. It reads the migrations as text and asserts that
 * the LAST one to define the function does not re-raise the floor above what
 * the driver sends. It cannot see production — but the clobber came in
 * through a migration, and this is where it would come in again.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const FN = 'fn_aggregate_gto_street_next';

/**
 * Every migration that declares the aggregator's batch clamp, oldest first.
 *
 * Only a REAL declaration counts — `v_batch integer := ...` at the start of
 * a line. A migration that patches the clamp surgically (reading `prosrc`
 * and replacing the text, which is the safe way to touch this function
 * while other agents are shipping to it) mentions both the old and the new
 * value inside string literals and must not be mistaken for a declaration.
 */
const CLAMP_DECL = /^[ \t]*v_batch\s+integer\s*:=\s*greatest\(\s*(\d+)\s*,/m;

function clampMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      return (
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}`, 'i').test(sql) &&
        CLAMP_DECL.test(sql)
      );
    });
}

describe('the V30 batch floor cannot be silently raised again', () => {
  it('there is at least one migration declaring the aggregator batch clamp', () => {
    expect(clampMigrations().length).toBeGreaterThan(0);
  });

  /**
   * The driver sends 100. Any clamp floor above that is the clobber bug:
   * the SQL would quietly round the batch back up onto the cliff.
   */
  it('the newest migration that declares the clamp does not floor above the batch the driver sends', () => {
    const files = clampMigrations();
    const newest = files[files.length - 1];
    const sql = readFileSync(join(MIGRATIONS, newest), 'utf8');

    const m = sql.match(CLAMP_DECL);
    expect(m, `no batch clamp declaration found in ${newest}`).not.toBeNull();

    const floor = Number(m![1]);
    const driverSrc = readFileSync(
      join(REPO, 'server', 'src', 'services', 'GtoAggregationDriver.ts'),
      'utf8'
    );
    const b = driverSrc.match(/const\s+BATCH\s*=\s*(\d+)/);
    expect(b, 'no BATCH constant in GtoAggregationDriver.ts').not.toBeNull();
    const driverBatch = Number(b![1]);

    expect(
      floor,
      `${newest} clamps the batch floor to ${floor}, but the driver sends ${driverBatch}. ` +
        'A floor above what the driver sends silently rounds every call back up - ' +
        'that is the 2026-08-30 clobber, and 200 is the measured timeout cliff.'
    ).toBeLessThanOrEqual(driverBatch);
  });

  it('the driver batch stays under the measured cliff', () => {
    const driverSrc = readFileSync(
      join(REPO, 'server', 'src', 'services', 'GtoAggregationDriver.ts'),
      'utf8'
    );
    const b = driverSrc.match(/const\s+BATCH\s*=\s*(\d+)/);
    // 200 measured at ~8s with one call in three cancelled (57014);
    // 100 measured at ~0.9s. Anything at or above 200 is the cliff.
    expect(Number(b![1])).toBeLessThan(200);
  });
});
