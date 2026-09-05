/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLOSED TABLE OWNS NO INDEX (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `NLH 0.05/0.10 Classic` created 2,994 tables between 13:01 and 15:29 UTC on
 * 2026-09-05 - one every five seconds - ending with 26,721 seats holding 50
 * players. Two facts had to be true together:
 *
 *   1. `fn_cash_cluster_tick` rule R3 ("an enabled game always has Main 1
 *      open") looked up `main_index = 1 ... ORDER BY created_at LIMIT 1`,
 *      with no preference for a row that is actually alive.
 *   2. The renumber pass at the bottom of the same function walks
 *      `v_census`, and `fn_cash_cluster_census` EXCLUDES closed tables - so a
 *      table that closed while holding `main_index = 1` keeps it forever,
 *      invisible to the only pass that would take it away.
 *
 * The cluster held TWO rows at index 1: a corpse from 21:38 the previous
 * evening and the live game from 22:08. R3 read the corpse, saw
 * `lifecycle = 'closed'`, opened a replacement, and the renumber gave that
 * replacement the next free index (2,986 by the end) - never 1. R3 sits ABOVE
 * the OPEN rule's `v_live_tables < v_table_cap` check, so the nine-table cap
 * never applied to any of it.
 *
 * IT COST MORE THAN DISK. `fn_cash_cluster_census` builds its array with two
 * correlated subqueries per table inside a tick holding `FOR UPDATE` on the
 * game row. At three thousand tables, `atomic_table_buyin` and the engine's
 * `ClusterController` wake RPC began returning 57014 against the 8s
 * service_role ceiling - 241 wake failures in thirty minutes. The runaway is
 * therefore also why horses could not buy in anywhere on the floor.
 *
 * THE LAW IS ON THE DATA, NOT IN R3. An ordering clause inside a 33KB
 * function that six migrations touched in one day is exactly the kind of line
 * a later rewrite drops without noticing, because `ORDER BY created_at` does
 * not look load-bearing. The invariant - AT MOST ONE ROW ANSWERS TO A GIVEN
 * `main_index` - is a property of the data, so it is enforced on the data and
 * R3's query cannot return the wrong row because the wrong row cannot exist.
 *
 * Registry: docs/laws.d/a-closed-table-owns-no-index.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

const migrationText = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');

describe('a closed table owns no index', () => {
  const all = migrationText();

  it('a trigger releases main_index when a cluster table closes or is deleted', () => {
    expect(all).toContain('fn_closed_cluster_main_releases_index');
    expect(all).toContain('trg_tables_closed_main_releases_index');
    // BEFORE, so the row never lands holding the index in the first place.
    expect(all).toMatch(
      /CREATE TRIGGER trg_tables_closed_main_releases_index\s+BEFORE INSERT OR UPDATE OF lifecycle, is_deleted ON public\.tables/
    );
  });

  it('the release covers deleted rows as well as closed ones', () => {
    const fn = all.slice(all.indexOf('fn_closed_cluster_main_releases_index'));
    expect(fn).toContain("NEW.lifecycle = 'closed' OR coalesce(NEW.is_deleted, false) = true");
    expect(fn).toContain('NEW.main_index := NULL');
  });

  it('a cluster cannot exceed its own declared table ceiling', () => {
    expect(all).toContain('fn_cluster_table_ceiling');
    expect(all).toContain('trg_tables_cluster_table_ceiling');
    const fn = all.slice(all.indexOf('CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling'));
    // The ceiling is read from the game, never hard-coded.
    expect(fn).toContain('cap_mains');
    expect(fn).toContain('allow_second_feeder');
  });

  it('the ceiling SKIPS the insert rather than raising inside the tick', () => {
    // Slice from the DEFINITION forward. The trigger name also appears in the
    // migration's ROLLBACK comment ABOVE it, so anchoring the end on the name
    // yields an empty string and a test that passes on nothing.
    const from = all.indexOf('CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling');
    const fn = all.slice(
      from,
      all.indexOf('CREATE TRIGGER trg_tables_cluster_table_ceiling', from)
    );
    expect(fn.length).toBeGreaterThan(200);
    // A raise here would abort a transaction that also carries seat moves and
    // roster writes. A refused table must never cost a player a seat.
    expect(fn).toContain('RETURN NULL');
    expect(fn).not.toMatch(/RAISE EXCEPTION/);
    // And it is recorded, so a cluster pressing on its cap is visible.
    expect(fn).toContain('table_refused_at_ceiling');
  });

  it('the backfill released every index a corpse was already holding', () => {
    expect(all).toMatch(
      /UPDATE public\.tables SET main_index = NULL[\s\S]{0,400}lifecycle = 'closed' OR coalesce\(is_deleted, false\) = true/
    );
  });

  it('the migration asserts the invariant instead of assuming it', () => {
    const mig = readFileSync(
      join(
        MIGRATIONS,
        '20260905155032_main_1_is_the_live_one_and_a_closed_table_owns_no_index.sql'
      ),
      'utf8'
    );
    expect(mig).toContain('closed cluster main(s) still hold an index');
    expect(mig).toContain('still answered by two live tables');
    // Tier 3 by CLAUDE.md section 2: one transaction, one schema reload.
    expect(mig).toContain('BEGIN;');
    expect(mig).toContain('COMMIT;');
    expect(mig).toContain('ROLLBACK');
  });
});
