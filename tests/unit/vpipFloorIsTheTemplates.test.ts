/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE VPIP FLOOR IS THE TEMPLATE'S, AND ONLY THE TEMPLATE'S
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07: "vpip for action is supposed to be 30% and vpip for madness
 * is 50%. we fixed and updated that a couple days ago."
 *
 * The default WAS fixed on 2026-09-05 and the rule still did not hold, because
 * a game's floor is copied into `ruleset_snapshot` once at creation and every
 * action and madness game predated the change. Fixing a default does nothing
 * for a row that already exists - that is the lesson worth pinning, not the
 * two numbers.
 *
 * These read the migration rather than the database: a unit test cannot reach
 * production, and a test that needs a live connection to state a rule is a
 * test that gets skipped. The live numbers were verified separately and are
 * recorded in the migration header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const migrations = path.join(root, 'supabase/migrations');

const MIGRATION = readdirSync(migrations).find((f) =>
  f.includes('the_vpip_floor_is_the_template_s_not_a_stale_snapshot')
)!;
const SQL = readFileSync(path.join(migrations, MIGRATION), 'utf8');

describe('the rule is enforced where the value enters, not where it is read', () => {
  it('a BEFORE trigger on cash_games normalises the floor on every write', () => {
    /* NOT a patched create function. `fn_cash_game_create_impl` is one writer;
       an admin edit, a backfill and the next creation path somebody adds are
       others. The floor is a property of the TEMPLATE, so it is enforced at
       the one place every writer must pass through. */
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_game_floor_from_template/);
    expect(SQL).toMatch(/BEFORE INSERT OR UPDATE OF ruleset_snapshot, template_name, variant/);
    expect(SQL).toMatch(/ON public\.cash_games/);
    expect(SQL).toMatch(/fn_cash_template_defaults\(NEW\.template_name, NEW\.variant\)/);
    // Both fields, or a stale window survives a corrected floor.
    expect(SQL).toMatch(/'\{vpip_floor\}'/);
    expect(SQL).toMatch(/'\{vpip_window\}'/);
  });

  it('the tables are corrected through the platform’s own idempotent path', () => {
    /* Never a hand-written UPDATE on `tables`: fn_cash_apply_ruleset is the
       only function allowed to map a snapshot onto a cluster, it skips rows
       that already agree, and it writes the cash_cluster_events audit row. */
    expect(SQL).toMatch(
      /SELECT sum\(public\.fn_cash_apply_ruleset\(id\)\) FROM public\.cash_games/
    );
    expect(SQL).not.toMatch(/UPDATE public\.tables/);
  });

  it('it asserts its own result and aborts if the board moved', () => {
    expect(SQL).toMatch(/ABORT: % games still disagree with their template floor/);
    expect(SQL).toMatch(/ABORT: % live tables still disagree with their game/);
  });

  it('it is a one-time correction, not a repair job (CLAUDE.md 10.12)', () => {
    // Nothing scheduled, nothing sweeping, nothing that runs twice.
    expect(SQL).not.toMatch(/cron\.schedule|pg_cron/i);
    expect(SQL).not.toMatch(/_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_/i);
  });

  it('runs as a single transaction, per the production DDL policy', () => {
    expect(SQL).toMatch(/^BEGIN;/m);
    expect(SQL).toMatch(/^COMMIT;/m);
  });
});

describe('the two numbers, and nothing between them', () => {
  it('the badge and the game rule agree on which floors exist', () => {
    const badge = readFileSync(
      path.join(root, 'src/components/table/VpipRequirementBadge.tsx'),
      'utf8'
    );
    expect(badge).toMatch(/ALLOWED_VPIP_REQUIREMENTS[^=]*=\s*\[30, 50\]/);
  });

  it('the create flow no longer offers a floor the server would overwrite', () => {
    /* The sliders that stood here set a value the trigger now replaces on
       write. A control that appears to set something and does not is worse
       than no control - the host would have believed their 65% table was a
       65% table. */
    const flow = readFileSync(
      path.join(root, 'src/components/cash/CashGameCreateFlow.tsx'),
      'utf8'
    );
    expect(flow).not.toMatch(/label="VPIP Floor"\s*\n?\s*value=\{overrides\.vpip_floor\}/);
    expect(flow).not.toMatch(/setOverride\('vpip_floor'/);
    expect(flow).not.toMatch(/setOverride\('vpip_window'/);
    // ...and says what the template carries instead.
    expect(flow).toMatch(/cash-create__rule-readout/);
  });
});
