/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TEMPLATE IS THE WHOLE GAME, NOT ONLY ITS CREATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lane C of the 2026-09-09 must-move audit
 * (docs/audits/2026-09-09-must-move-audit/lane-C.md). Each block below is a
 * defect that was live on production at 18:00 UTC that day, and the assertion
 * is the shape of the thing that stops it coming back.
 *
 * These read the MIGRATION rather than the database, for the reason
 * tests/unit/vpipFloorIsTheTemplates.test.ts already gives: a unit test cannot
 * reach production, and a test that needs a live connection to state a rule is
 * a test that gets skipped. The live numbers were read separately and are
 * recorded in the migration header and in the lane report.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const migrations = path.join(root, 'supabase/migrations');

const FILE = readdirSync(migrations).find((f) =>
  f.includes('the_promise_is_pinned_the_ensure_knows_its_template')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');

describe('the trigger pins the whole promise, not half of it', () => {
  it('all four contract fields come from the template on every write', () => {
    /* 20260907190515 pinned vpip_floor and vpip_window only, so a direct
       UPDATE of ruleset_snapshot could put an ante or a bomb pot back onto a
       game the lobby sells as "No Antes, No Bombs". */
    const body = SQL.slice(SQL.indexOf('fn_cash_game_floor_from_template'));
    for (const key of ['vpip_floor', 'vpip_window', 'regular_ante', 'bombs']) {
      expect(body).toMatch(new RegExp(`'${key}',\\s*v_def->'${key}'`));
    }
  });

  it('bombs is replaced whole, so a stale member cannot survive underneath', () => {
    // `||` on the object, never jsonb_set on a member inside it.
    expect(SQL).toMatch(/NEW\.ruleset_snapshot\s*\|\|\s*jsonb_build_object/);
  });
});

describe('fn_cash_game_ensure ensures the game it was asked for', () => {
  it('the template is part of the key it matches on', () => {
    /* It matched (club, variant, sb, bb) alone, so a Stable Hand order for
       Classic NLH 1/2 was answered with "NLH 1/2 Action" - measured on the
       platform club, where 29 stake keys carry more than one template. */
    const m = SQL.match(
      /SELECT \* INTO g FROM public\.cash_games[\s\S]{0,400}?ORDER BY enabled DESC, created_at LIMIT 1;/
    );
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/template_name = v_t/);
  });

  it('handedness is one of the template seat_choices', () => {
    expect(SQL).toMatch(/seat_choices/);
    expect(SQL).toMatch(/p_handedness = ANY \(v_choices\)/);
  });

  it('the snapshot it writes carries table_mode', () => {
    expect(SQL).toMatch(/'table_mode', 'must_move'/);
  });
});

describe('a band with no game is never handed to a horse', () => {
  it('the projection falls to the lowest band that HAS a game', () => {
    const body = SQL.slice(SQL.indexOf('fn_project_stake_band'));
    // the fold-down arm, then the new lowest-available arm, then fail-open
    expect(body).toMatch(/ORDER BY a\.ord DESC\s*LIMIT 1\)/);
    expect(body).toMatch(/ORDER BY a\.ord ASC\s*LIMIT 1\)/);
    expect(body).toMatch(/p_band\s*\)/);
  });

  it('the assertion uses a case that can actually FAIL on the old body', () => {
    /* CLAUDE.md 10.86. The first draft asserted project('high', {micro}) =
       'micro', which the OLD function already answered correctly - a check
       that cannot fail. The broken arm is the one where nothing is at or
       BELOW the wanted rung. */
    expect(SQL).toMatch(/fn_project_stake_band\('micro', ARRAY\['low', 'mid'\]\)/);
    expect(SQL).toMatch(/ABORT: fn_project_stake_band\(micro, \{low,mid\}\) answered/);
  });
});

describe('the reconciler edit composes with the other lane that rewrites it', () => {
  it('fn_cash_apply_ruleset is edited by anchored replacement, never retyped', () => {
    /* Lane E (20260909181230) replaces that whole body in the same audit.
       Retyping it here would drop its run-it-N-times work, or lose this,
       depending on apply order. */
    expect(SQL).toMatch(/pg_get_functiondef\('public\.fn_cash_apply_ruleset\(uuid\)'::regprocedure\)/);
    expect(SQL).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_apply_ruleset/);
  });

  it('every anchor is proved present exactly once before it is used', () => {
    expect(SQL).toMatch(/anchor appears % time\(s\)/);
    expect(SQL).toMatch(/IF v_hits <> 1 THEN/);
  });

  it('the seat ceiling never drops below an occupied chair', () => {
    /* Two PLO5 Classic tables carried max_players 7 on a 6-handed game and one
       had a player in seat 7. The ceiling follows the seats DOWN, at the tick
       after that chair empties. */
    expect(SQL).toMatch(/max_players = GREATEST\(g\.handedness,/);
    expect(SQL).toMatch(/max\(ts\.seat_number\)[\s\S]{0,160}ts\.left_at IS NULL/);
    expect(SQL).toMatch(/ABORT: the seat ceiling was written below an occupied chair/);
  });
});

describe('the shape the house requires of a migration', () => {
  it('one transaction, per the production DDL policy', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('it asserts its own result and aborts if the board moved', () => {
    expect(SQL).toMatch(/ABORT: % game\(s\) still disagree with their template promise/);
    expect(SQL).toMatch(/ABORT: % live table\(s\) still disagree with their game/);
  });

  it('the tables are corrected through the platform own idempotent path', () => {
    /* Never a hand-written UPDATE on `tables`: fn_cash_apply_ruleset is the
       only function allowed to map a snapshot onto a cluster. */
    expect(SQL).toMatch(/sum\(public\.fn_cash_apply_ruleset\(id\)\)/);
    expect(SQL).not.toMatch(/^\s*UPDATE public\.tables/m);
  });

  it('it is a one-time correction, not a repair job (CLAUDE.md 10.12)', () => {
    expect(SQL).not.toMatch(/cron\.schedule|pg_cron/i);
    expect(SQL).not.toMatch(/_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_/i);
  });

  it('no em dashes anywhere in it', () => {
    expect(SQL).not.toMatch(/—/);
  });
});
