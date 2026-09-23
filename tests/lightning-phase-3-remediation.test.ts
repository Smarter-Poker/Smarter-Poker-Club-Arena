/**
 * LIGHTNING 2.0 PHASE 3 REMEDIATION: THE EPOCH FOLLOWS ITS GAME, AND THE
 * FRONT TABLE IS THE MAIN GAME.
 *
 * An adversarial audit of 20260921025504 and 20260921025523, run against the
 * live catalogue after both had been applied, found one blocker and two
 * majors. Neither of those files is edited - a migration that has run is
 * history - so 20260921044045 repairs all three from outside, which makes it
 * almost entirely a set of ASSERTED SUBSTITUTIONS against live function
 * bodies. Nothing in it is a CREATE OR REPLACE of the five functions it edits,
 * so the only thing standing between a bad anchor and a silently mangled
 * production function is the count guard before each replace and the read-back
 * from the catalogue after all of them.
 *
 * Three decisions here could be undone later without anything failing to
 * compile, and each of the three was found by mutating a copy of the migration
 * rather than by reading it:
 *
 *   1. AN INVARIANT THAT NOTHING MAINTAINS IS NOT AN INVARIANT.
 *      20260921025504 backfilled cash_cluster_epoch once and declared in its
 *      own proof that every cash_games row has an open epoch row. Nothing
 *      wrote to the table afterwards, so the first Cluster created after it
 *      applied had no epoch row at all and no Lightning row could ever have
 *      named it. The epoch now FOLLOWS its game, on an AFTER trigger.
 *
 *   2. A SUCCESSOR MUST NOT START BEFORE ITS PREDECESSOR ENDED. The catch-up
 *      is THREE statements because one cannot do it, and the third dates the
 *      recovered epoch from max(ended_at) and never from the Cluster's
 *      created_at. Dated from creation the two epochs overlap for the whole
 *      life of the first, and cash_cluster_epoch_ends_after_it_starts cannot
 *      see that: the CHECK compares a row against itself, never against its
 *      siblings.
 *
 *   3. WHICH TABLE STANDS FOR A GAME IS A PROPERTY OF THE CLUSTER. The front
 *      table is re-cut as three index lookups under one coalesce, no boolean
 *      sorted and no DESC anywhere, and the three SEAT CHANGE readers that
 *      20260921025523 said it had migrated and had not now ask it too.
 *
 * Half (b) is the browser, which asks the same question and answered it from a
 * row alone. src/services/cashGameLobby.ts takes the server's answer as an
 * argument, and falls back to the pre-Lightning rule only for a payload that
 * does not carry one.
 *
 * LIGHTNING_P3R_MIGRATION overrides the file under test, so mutation testing -
 * copying the migration to a scratch directory, breaking one line of the copy
 * and watching this suite go red - never has to touch the migration in the
 * repository. It is the same mechanism its sibling takes as
 * LIGHTNING_P3_MIGRATION.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import {
  isMainOne,
  lobbyTableLabel,
  mustMoveListRows,
  type LobbyListEntry,
  type LobbyTable,
} from '../src/services/cashGameLobby';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql';
const MIGRATION =
  process.env.LIGHTNING_P3R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
/**
 * Comment-stripped, so no pin below can be satisfied by prose. Used only where
 * the text being pinned is the migration's OWN code. The replacement strings
 * the DO blocks assemble carry `--` comment lines of their own inside SQL
 * string literals and the strip eats those, so anything about the text being
 * INSTALLED is asserted against SQL instead.
 */
const CODE = SQL.replace(/--[^\n]*/g, '');

/** One span of text, from an anchor to the end of its terminator. '' if absent. */
function span(hay: string, from: string, to: string): string {
  const a = hay.indexOf(from);
  if (a < 0) return '';
  const b = hay.indexOf(to, a + from.length);
  return b < 0 ? '' : hay.slice(a, b + to.length);
}

/** The two functions this migration writes out in full. */
const EPOCH_FN = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_epoch_follows_its_game()',
  '$fn$;'
);
const FRONT_TABLE = span(
  CODE,
  'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_front_table(p_game_id uuid)',
  '$fn$;'
);

/** The five asserted-substitution blocks, in file order. */
const DO_BLOCKS = [...SQL.matchAll(/DO \$do\$[\s\S]*?END \$do\$;/g)].map((m) => m[0]);
const [WRITER, LOBBY, DOOR, PLANNER, TICK] = DO_BLOCKS;

/** The catch-up: the three statements between the trigger and the block that audits them. */
const CATCH_UP = span(CODE, 'CREATE TRIGGER trg_cash_games_epoch_follows_its_game', 'DO $$');
const AT_CLOSE_STALE = CATCH_UP.indexOf('UPDATE public.cash_cluster_epoch e');
const AT_GENESIS = CATCH_UP.indexOf("'genesis', g.created_at");
const AT_RECOVERED = CATCH_UP.indexOf("'recovered',");
const statementAt = (i: number): string =>
  i < 0 ? '' : CATCH_UP.slice(CATCH_UP.lastIndexOf('INSERT INTO', i), CATCH_UP.indexOf(';', i) + 1);
const GENESIS_INSERT = statementAt(AT_GENESIS);
const RECOVERED_INSERT = statementAt(AT_RECOVERED);

/** The DO block that audits the catch-up, and the post-apply read-back. */
const CATCH_UP_AUDIT = span(SQL, 'DO $$', 'END $$;');
const READ_BACK = span(SQL, 'DO $assert$', 'END $assert$;');

// ===========================================================================
//  (a) THE MIGRATION
// ===========================================================================

describe('Phase 3 remediation: the epoch follows its game', () => {
  it('writes the trigger function as a definer with a pinned search_path and no browser reach', () => {
    // SECURITY DEFINER because it writes cash_cluster_epoch, which is revoked
    // from every browser role; the search_path is pinned so a caller cannot
    // shadow public.cash_cluster_epoch with one of their own. The COMMENT is
    // the only place a reader of the catalogue alone learns why it exists.
    expect(EPOCH_FN).toBeTruthy();
    expect(EPOCH_FN).toContain('SECURITY DEFINER');
    expect(EPOCH_FN).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_epoch_follows_its_game() FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).toMatch(
      /COMMENT ON FUNCTION public\.fn_cash_cluster_epoch_follows_its_game\(\) IS\s+'/
    );
  });

  it('fires AFTER INSERT and after the two columns that can move, one row at a time', () => {
    // UPDATE OF two named columns rather than bare UPDATE: every other write
    // to cash_games - the tick stamping last_tick_at every five seconds, a
    // host editing a blind - would otherwise run this function for nothing.
    // FOR EACH ROW because the work is per Cluster, and AFTER because the row
    // it files must be the row that committed.
    expect(CODE).toMatch(
      /CREATE TRIGGER trg_cash_games_epoch_follows_its_game\s+AFTER INSERT OR UPDATE OF cluster_epoch, cluster_mode ON public\.cash_games\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.fn_cash_cluster_epoch_follows_its_game\(\);/
    );
    // Dropped first, or re-running the file raises 42710 and rolls back a
    // migration whose whole point is that it can be re-applied.
    expect(CODE).toContain(
      'DROP TRIGGER IF EXISTS trg_cash_games_epoch_follows_its_game ON public.cash_games;'
    );
  });

  it('refuses an epoch that goes backwards, and refuses it as a check violation', () => {
    // A reusable epoch would make every historical Lightning row ambiguous,
    // which is the whole reason the epoch became a row. The ERRCODE is stated
    // rather than left at P0001 so a caller can tell this refusal apart from
    // any other RAISE in the same transaction.
    expect(EPOCH_FN).toContain('IF NEW.cluster_epoch < OLD.cluster_epoch THEN');
    expect(EPOCH_FN).toContain('CLUSTER_EPOCH_GOES_FORWARD');
    expect(EPOCH_FN).toMatch(
      /CLUSTER_EPOCH_GOES_FORWARD[\s\S]{0,400}?USING ERRCODE = 'check_violation'/
    );
  });

  it('ends the open row BEFORE it opens the successor', () => {
    // cash_cluster_epoch_current is UNIQUE on (cluster_id) WHERE ended_at IS
    // NULL. Insert first and the statement raises 23505 against the row it is
    // succeeding, so the order here is not a style choice.
    const moves = EPOCH_FN.slice(
      EPOCH_FN.indexOf('IF NEW.cluster_epoch IS DISTINCT FROM OLD.cluster_epoch THEN')
    );
    const ends = moves.indexOf('SET ended_at = clock_timestamp()');
    const opens = moves.indexOf('INSERT INTO public.cash_cluster_epoch');
    expect(ends).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(-1);
    expect(ends).toBeLessThan(opens);
    expect(moves).toContain('WHERE cluster_id = NEW.id AND ended_at IS NULL;');
  });

  it('takes the successor reason from the session and files an unexplained bump as unstated', () => {
    // ca.epoch_reason is a SET LOCAL a conversion sets in its own transaction,
    // exactly like ca.break_window_migration_override. The `true` is the
    // missing_ok: without it a session that never set it raises 42704 and the
    // bump fails. Refusing an unexplained bump would make the history LESS
    // complete, not more, so it files as 'unstated' instead.
    expect(EPOCH_FN).toContain(
      "coalesce(nullif(current_setting('ca.epoch_reason', true), ''), 'unstated')"
    );
  });

  it('moves the mode of the OPEN epoch only', () => {
    // A FINISHED epoch's mode is what that epoch RAN under, which is why
    // cash_cluster_epoch carries its own copy rather than joining cash_games.
    // Without the ended_at predicate one mode change rewrites a Cluster's
    // whole history to the regime it is in today.
    const modeMoves = EPOCH_FN.slice(
      EPOCH_FN.indexOf('IF NEW.cluster_mode IS DISTINCT FROM OLD.cluster_mode THEN')
    );
    expect(modeMoves).toContain('SET mode = NEW.cluster_mode');
    expect(modeMoves).toContain('WHERE cluster_id = NEW.id AND ended_at IS NULL;');
  });
});

describe('Phase 3 remediation: the catch-up repairs both shapes of damage, in order', () => {
  it('is three statements, because one INSERT cannot repair both', () => {
    // ON CONFLICT takes ONE arbiter, and the primary key (cluster_id, epoch)
    // is not the index a stale open row violates - cash_cluster_epoch_current
    // is. Inserting the current epoch beside a stale open one raises 23505 and
    // rolls the whole migration back, on precisely the damage it exists to
    // repair. So: close the stale open rows, THEN give a Cluster born in the
    // window its genesis, THEN give a Cluster whose epoch moved its successor.
    expect(AT_CLOSE_STALE).toBeGreaterThan(-1);
    expect(AT_GENESIS).toBeGreaterThan(AT_CLOSE_STALE);
    expect(AT_RECOVERED).toBeGreaterThan(AT_GENESIS);
    expect(CATCH_UP).toContain('SET ended_at = clock_timestamp()');
    expect(CATCH_UP).toContain('AND e.epoch IS DISTINCT FROM g.cluster_epoch;');
  });

  it('gives a Cluster born in the window a genesis, dated when it was born', () => {
    // Guarded on the Cluster having NO epoch row at all. Any narrower guard
    // would file a second genesis beside an existing one, and two rows
    // claiming to be one Cluster's genesis is a contradiction on the face of
    // the table.
    expect(GENESIS_INSERT).toContain("'genesis'");
    expect(GENESIS_INSERT).toContain('g.created_at');
    expect(GENESIS_INSERT).toContain(
      'NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id)'
    );
  });

  it('dates the successor from when its predecessor ended, and NEVER from the Cluster birth', () => {
    // This is the whole point of the third statement. started_at is the
    // timestamp the UPDATE above just wrote, so the successor begins exactly
    // where the epoch it succeeds finished. Dated from the Cluster's
    // created_at instead, the successor would start twenty days before its
    // predecessor ended and the two would overlap for the whole life of the
    // first - and cash_cluster_epoch_ends_after_it_starts cannot see it,
    // because that CHECK compares a row against itself and never against a
    // sibling. It is also not a genesis: 20260921025504's own column comment
    // says started_by carries the conversion reason after the first epoch.
    expect(RECOVERED_INSERT).toContain("'recovered'");
    expect(RECOVERED_INSERT).toContain(
      'coalesce((SELECT max(e.ended_at) FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id)'
    );
    expect(RECOVERED_INSERT).not.toContain('g.created_at');
    expect(RECOVERED_INSERT).not.toContain("'genesis'");
  });

  it('then counts both shapes of damage and refuses to commit on either', () => {
    // An assertion, not a hope: a catch-up that dated a successor from its
    // Cluster's birth passes every statement above and fails the second count
    // here. Nothing enforces the overlap as a constraint - an EXCLUDE over a
    // tstzrange would need btree_gist for the uuid half - so this block is the
    // only place it is checked at all.
    expect(CATCH_UP_AUDIT).toBeTruthy();
    expect(CATCH_UP_AUDIT).toMatch(/RAISE EXCEPTION '% cluster\(s\) still have no open epoch row'/);
    expect(CATCH_UP_AUDIT).toMatch(/RAISE EXCEPTION '% pair\(s\) of epochs overlap in time/);
    expect(CATCH_UP_AUDIT).toContain(
      "WHERE b.started_at < coalesce(a.ended_at, 'infinity'::timestamptz)"
    );
    expect(CATCH_UP_AUDIT).toContain('ON b.cluster_id = a.cluster_id AND b.epoch > a.epoch');
  });
});

describe('Phase 3 remediation: the front table is three lookups and no sort', () => {
  it('is re-cut as a coalesce of three subselects with no DESC in it at all', () => {
    // `ORDER BY (t.role = 'main' AND t.main_index = 1) DESC` is NULLS FIRST by
    // default and that expression is NULL - not false - for a row with role
    // 'main' and a NULL main_index, so such a row outranked the real Main 1.
    // The sort also lost the index condition the old subselect had: measured
    // on production the tick worklist went from 6.13 ms / 1,265 buffers to
    // 13.97 / 2,644, and it runs every five seconds. No boolean is sorted
    // here, so there is no NULL to sort first and nothing to re-plan.
    expect(FRONT_TABLE).toBeTruthy();
    expect(FRONT_TABLE).toContain('SELECT coalesce(');
    expect(FRONT_TABLE).not.toContain('DESC');
    expect([...FRONT_TABLE.matchAll(/SELECT t\.id FROM public\.tables t/g)].length).toBe(3);
  });

  it('leads with the Main 1 lookup, and its second arm refuses a breaking table', () => {
    // Arm order IS the rule. The Main 1 lookup short-circuits for every
    // Cluster that has one, which is what keeps the answer identical to what
    // every reader was already finding. The second arm excludes 'breaking'
    // because a breaking table refuses every player it is sent
    // (TABLE_CLOSING), so it must not be what the controller keys its
    // eligible-horse map on; the third arm takes one anyway, because a game
    // that still exists is better represented by a closing table than by
    // nothing at all.
    const arms = FRONT_TABLE.split('SELECT t.id FROM public.tables t').slice(1);
    expect(arms.length).toBe(3);
    expect(arms[0]).toContain("t.role = 'main' AND t.main_index = 1");
    expect(arms[1]).toContain("t.lifecycle NOT IN ('closed', 'breaking')");
    expect(arms[1]).not.toContain('main_index');
    expect(arms[2]).toContain("t.lifecycle <> 'closed'");
    expect(arms[2]).not.toContain('breaking');
    for (const arm of arms) {
      expect(arm).toContain('coalesce(t.is_deleted, false) = false');
      // t.id is the tie-break, so the answer is never arrival-ordered.
      expect(arm).toContain('ORDER BY t.created_at, t.id LIMIT 1');
    }
  });

  it('stays an invoker with a pinned search_path, out of the browser and granted to service_role', () => {
    // SECURITY INVOKER deliberately: every caller is already SECURITY DEFINER,
    // so this runs with their privileges and adds no new reach of its own. A
    // definer here would be another privileged door for no gain.
    expect(FRONT_TABLE).toContain('SECURITY INVOKER');
    expect(FRONT_TABLE).not.toContain('SECURITY DEFINER');
    expect(FRONT_TABLE).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_front_table(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_front_table(uuid) TO service_role;'
    );
    expect(SQL).toMatch(/COMMENT ON FUNCTION public\.fn_cash_cluster_front_table\(uuid\) IS\s+'/);
  });
});

describe('Phase 3 remediation: every substitution is guarded before it happens', () => {
  it('edits five live bodies, and does so as substitutions rather than restatements', () => {
    // Restating a body this large is how a transcription error reaches
    // production. All five of these functions are a base definition plus
    // patches, so the file on disk is not what is running at all.
    expect(DO_BLOCKS.length).toBe(5);
    for (const fn of [
      'fn_cash_cluster_open_table',
      'fn_cash_game_lobby',
      'fn_cash_seat_change_request',
      'fn_cash_seat_change_plan',
      'fn_cash_cluster_tick',
    ]) {
      expect(CODE, `${fn} is restated rather than substituted`).not.toContain(
        `CREATE OR REPLACE FUNCTION public.${fn}`
      );
      expect(CODE).toContain(`pg_get_functiondef('public.${fn}`);
    }
  });

  it('guards EVERY replace with <> 1, not merely one per block', () => {
    // An anchor that occurs twice would be replaced twice; an anchor that
    // occurs zero times would be replaced nowhere and the migration would
    // commit a body it never changed. `<> 1` is the only reading that refuses
    // both, and it is one deletable line per substitution - so the count is
    // asserted against the number of replaces rather than against a constant.
    const guards = (SQL.match(/IF v_n <> 1 THEN/g) ?? []).length;
    const replaces = (SQL.match(/v_src := replace\(/g) ?? []).length;
    expect(replaces).toBeGreaterThanOrEqual(14);
    expect(guards).toBe(replaces);
    for (const [i, block] of DO_BLOCKS.entries()) {
      const blockGuards = (block.match(/IF v_n <> 1 THEN/g) ?? []).length;
      const blockReplaces = (block.match(/v_src := replace\(/g) ?? []).length;
      expect(blockReplaces, `DO block ${i + 1} substitutes nothing`).toBeGreaterThan(0);
      expect(
        blockGuards,
        `DO block ${i + 1} guards ${blockGuards} of its ${blockReplaces} substitutions`
      ).toBe(blockReplaces);
      expect(block).toMatch(/RAISE EXCEPTION 'the live/);
    }
  });

  it('is re-runnable: each block recognises its own work and returns early', () => {
    // Without this a second application re-patches an already-patched body,
    // which either finds no anchor and raises or finds one and doubles the
    // edit. Each block recognises its own work by a string only that work
    // could have installed, and says so rather than failing silently.
    for (const [i, block] of DO_BLOCKS.entries()) {
      expect(block, `DO block ${i + 1} is not idempotent`).toMatch(
        /IF position\([\s\S]{0,200}? in v_src\) > 0 THEN[\s\S]{0,300}?RAISE NOTICE[\s\S]{0,300}?RETURN;/
      );
    }
    expect(WRITER).toContain(
      "IF position('lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false' in v_src) > 0 THEN"
    );
    for (const block of [LOBBY, DOOR, PLANNER, TICK]) {
      expect(block).toContain("IF position('fn_cash_cluster_front_table' in v_src) > 0 THEN");
    }
  });

  it('makes the cluster writer count LIVE tables, which is the reopened-feeder defect', () => {
    // v_n was `count(*) FROM public.tables WHERE cluster_id = p_game_id` -
    // every row, closed and deleted included. On the R3 reopen path the closed
    // row is still there, so v_n >= 1, the name fell through to
    // `<game> Feeder`, and the lone-feeder guard then stopped the ROLES step
    // ever renaming it. The lobby printed "NLH 1/2 Action Feeder" as the name
    // of the game, which is verbatim the defect 20260921025523 says it fixed.
    expect(WRITER).toContain(
      "'  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id' || chr(10) ||"
    );
    expect(WRITER).toContain(
      "'     AND lifecycle <> ''closed'' AND coalesce(is_deleted, false) = false;'"
    );
  });
});

describe('Phase 3 remediation: the front table is read once and compared, never called per row', () => {
  it('hoists it into a local in BOTH the planner and the tick', () => {
    // Both scans walk unnest(v_census), and PostgreSQL does not cache a STABLE
    // call across the rows of a scan even when its argument is constant. In
    // the predicate that is one index lookup per census row per request; in a
    // local it is one per call. Drop the declaration and the body does not
    // compile at all, which is why the DECLARE line is pinned beside the
    // assignment rather than assumed from it.
    expect(PLANNER).toContain("'  v_seat_a integer; v_seat_b integer;' || chr(10) ||");
    expect(PLANNER).toContain("'  v_front uuid;' || chr(10);");
    expect(PLANNER).toContain("'  v_front := public.fn_cash_cluster_front_table(p_game_id);'");
    expect(TICK).toContain("'  g record; t record; r record;' || chr(10) ||");
    expect(TICK).toContain("'  v_front uuid;' || chr(10);");
    expect(TICK).toContain("'  v_front := public.fn_cash_cluster_front_table(g.id);'");
  });

  it('compares every converted predicate against the local, and never against a call', () => {
    // IS DISTINCT FROM, not NOT (=): fn_cash_cluster_front_table answers NULL
    // for a Cluster whose every table has closed, and `NOT (c.id = NULL)` is
    // NULL, which would empty the filter and route nobody anywhere.
    expect(PLANNER).toContain("'WHERE c.id = r.from_table_id AND c.id = v_front) THEN'");
    expect((PLANNER.match(/AND c\.id IS DISTINCT FROM v_front/g) ?? []).length).toBe(2);
    expect(TICK).toContain("'   WHERE c.id IS DISTINCT FROM v_front AND c.lifecycle = ''live'''");
    for (const block of [PLANNER, TICK]) {
      expect(block).not.toMatch(/c\.id IS DISTINCT FROM public\.fn_cash_cluster_front_table/);
      expect(block).not.toMatch(/c\.id = public\.fn_cash_cluster_front_table/);
    }
    // The break step's candidate was `NOT (c.role = 'main' AND c.main_index =
    // 1)`, which on a feeder-first Cluster admits the one table the game has.
    // It was saved only by the NEXT guard, `IF v_remaining_tables >= 1`, and
    // being saved by a different clause than the one written for the job is
    // not a rule.
    expect(TICK).toContain("'   WHERE NOT (c.role = ''main'' AND c.main_index = 1)");
  });
});

describe('Phase 3 remediation: nothing the edited bodies already refused may be swallowed', () => {
  it('names all seven of the seat-change door refusals before it executes', () => {
    // A replace that ate one of these would be invisible until a player hit
    // it: the function would still compile, still grant seat changes, and
    // silently stop refusing the one table a seat change may never go to.
    const codes = [
      'SEAT_CHANGE_NOT_FROM_MAIN',
      'SEAT_CHANGE_NEVER_TO_MAIN',
      'SEAT_CHANGE_TABLE_CLOSING',
      'SEAT_CHANGE_SAME_TABLE',
      'SEAT_CHANGE_NO_OTHER_TABLE',
      'SEAT_CHANGE_TABLE_UNAVAILABLE',
      'NOT_IN_GAME',
    ];
    for (const code of codes) {
      expect(DOOR, `${code} is not checked for survival`).toContain(
        `position('${code}' in v_src) = 0`
      );
    }
    expect([...DOOR.matchAll(/position\('([^']+)' in v_src\) = 0/g)].length).toBe(codes.length);
    expect(DOOR).toMatch(/RAISE EXCEPTION 'a refusal did not survive/);
    // The guard runs before the EXECUTE, or it guards nothing.
    expect(DOOR.indexOf("position('SEAT_CHANGE_NOT_FROM_MAIN' in v_src) = 0")).toBeLessThan(
      DOOR.indexOf('EXECUTE v_src;')
    );
  });

  it('names the planner four surviving steps before it executes', () => {
    const steps = [...PLANNER.matchAll(/position\('([^']+)' in v_src\) = 0/g)].map((m) => m[1]);
    expect(steps.sort()).toEqual(
      [
        'now_on_main_one',
        'seat_change_returned',
        'seat_change_used_at = NULL',
        'swap_move_id',
      ].sort()
    );
    expect(PLANNER).toMatch(/RAISE EXCEPTION 'a sibling step did not survive/);
    expect(PLANNER.indexOf("position('now_on_main_one' in v_src) = 0")).toBeLessThan(
      PLANNER.indexOf('EXECUTE v_src;')
    );
  });

  it('names the tick eleven surviving steps before it executes', () => {
    // One string per tick step, taken from the step's own event kind or action
    // key. The tick is the hot path for every Cluster every five seconds; a
    // replace that swallowed a step would quietly stop breaking tables,
    // planning moves, opening feeders or renumbering mains.
    const steps = [...TICK.matchAll(/position\('([^']+)' in v_src\) = 0/g)].map((m) => m[1]);
    expect(steps.length).toBe(11);
    for (const step of [
      'lone_feeder_is_the_cluster',
      'feeder_became_main1',
      'main_renumbered',
      'main1_reopened',
      'move_planned',
      'feeder_abandoned',
      'table_opening_hold',
      'fn_cash_seat_change_plan',
      'fn_cash_cluster_census',
      'status_followed_lifecycle',
      'opening_hold_rested_until',
    ]) {
      expect(steps, `${step} is not checked for survival`).toContain(step);
    }
    expect(TICK).toMatch(/RAISE EXCEPTION 'a sibling step did not survive/);
    expect(TICK.indexOf("position('lone_feeder_is_the_cluster' in v_src) = 0")).toBeLessThan(
      TICK.indexOf('EXECUTE v_src;')
    );
  });

  it('checks the cluster writer kept its own four refusals and the comment a proof pins', () => {
    for (const guard of [
      'ROLE_INVALID',
      'MAIN_INDEX_INVALID',
      'LIFECYCLE_INVALID',
      'GAME_NOT_FOUND',
    ]) {
      expect(WRITER, `${guard} is not checked for survival`).toContain(
        `position('${guard}' in v_src) = 0`
      );
    }
    // 20260921025523's eleventh @live-proof pins this comment line, so an edit
    // that ate it fails that file's law as well as this one.
    expect(WRITER).toContain(
      "position('the cluster''s first table stands for the game' in v_src) = 0"
    );
    expect(WRITER).toMatch(/RAISE EXCEPTION 'a sibling guard did not survive/);
    expect(WRITER.indexOf("position('ROLE_INVALID' in v_src) = 0")).toBeLessThan(
      WRITER.indexOf('EXECUTE v_src;')
    );
  });
});

describe('Phase 3 remediation: the file ends by asking the catalogue what it kept', () => {
  it('re-reads all six bodies with pg_get_functiondef rather than trusting a variable', () => {
    // The variables above say what was SENT. This asks what the database KEPT.
    // A substitution that produced a body PostgreSQL parsed differently than
    // intended passes every check before this one and fails here.
    expect(READ_BACK).toBeTruthy();
    const reads = [...READ_BACK.matchAll(/pg_get_functiondef\('public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(
      [
        'fn_cash_cluster_front_table',
        'fn_cash_cluster_open_table',
        'fn_cash_cluster_tick',
        'fn_cash_game_lobby',
        'fn_cash_seat_change_plan',
        'fn_cash_seat_change_request',
      ].sort()
    );
    // Not from v_src or any variable the blocks above assembled.
    expect(READ_BACK).not.toMatch(/\bv_src\b/);
  });

  it('proves the old Main 1 predicate is GONE from the lobby, the door and the planner', () => {
    // Asserting the new predicate arrived is half a test: a body can carry
    // both, and a body that carries both still judges a feeder-first Cluster
    // by a column that answers NULL for it. Each of the three is checked for
    // the ABSENCE of the predicate it replaced, and says which body it means.
    expect(READ_BACK).toContain(
      "IF position('me.role = ''main'' AND me.main_index = 1' in v_lob) > 0 THEN"
    );
    expect(READ_BACK).toMatch(/RAISE EXCEPTION 'the live lobby still judges the caller by Main 1'/);
    expect(READ_BACK).toContain("IF position('main_index = 1' in v_req) > 0 THEN");
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the live seat-change door still carries a Main 1 predicate'/
    );
    expect(READ_BACK).toContain("IF position('main_index = 1' in v_pln) > 0 THEN");
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the live planner still carries a Main 1 predicate'/
    );
    // And the new answers are in all three, plus the tick's break step.
    expect(READ_BACK).toContain("position('front_table_id' in v_lob) = 0");
    expect(READ_BACK).toContain(
      "position('me.table_id = public.fn_cash_cluster_front_table(g.id)' in v_req) = 0"
    );
    expect(READ_BACK).toContain(
      "position('  v_front := public.fn_cash_cluster_front_table(p_game_id);' in v_pln) = 0"
    );
    expect(READ_BACK).toContain(
      "position('  v_front := public.fn_cash_cluster_front_table(g.id);' in v_tck) = 0"
    );
  });

  it('re-reads the front table itself and refuses a DESC in the live body', () => {
    expect(READ_BACK).toContain(
      "IF position('coalesce(' in v_fnt) = 0 OR position('DESC' in v_fnt) > 0 THEN"
    );
    expect(READ_BACK).toMatch(/RAISE EXCEPTION 'the live front table is not the coalesced form'/);
  });

  it('proves the answer did not move, and that the proof was not vacuous', () => {
    // Every Cluster with a live Main 1 must still get that Main 1. The second
    // query is what makes the first mean something: a comparison over zero
    // rows passes trivially.
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the re-cut front table changed the answer for % cluster\(s\)/
    );
    expect(READ_BACK).toContain('IF v_bad < 1 THEN');
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'no cluster has a live Main 1, so the comparison above proved nothing'/
    );
    // NON-VACUITY, NOT A PRODUCTION HEADCOUNT. The first draft demanded 100,
    // which made the migration refuse to apply to a fresh db reset, a preview
    // branch or any CI database - a guard that stops the file running exactly
    // where it most needs to run. One is the whole requirement: the comparison
    // had something to compare.
    expect(SQL).not.toContain('v_bad < 100');
    expect(SQL).not.toMatch(/v_bad < \d\d+/);
  });

  it('is the last thing in the file before COMMIT', () => {
    // A read-back that runs before the last substitution reads a body that is
    // about to change.
    expect(SQL.slice(SQL.indexOf('END $assert$;'))).toBe('END $assert$;\n\nCOMMIT;\n');
    expect(SQL.indexOf('DO $assert$')).toBeGreaterThan(SQL.lastIndexOf('END $do$;'));
    expect(SQL.indexOf('DO $assert$')).toBeGreaterThan(
      SQL.lastIndexOf('CREATE OR REPLACE FUNCTION')
    );
  });
});

describe('Phase 3 remediation: scope and safety', () => {
  it('is one transaction, and takes the lock the tick takes', () => {
    // Every DDL statement fires Supabase's schema-cache reload, which takes
    // about 28 seconds on this database, so ten loose statements mean ten
    // reloads. The EXCLUSIVE lock is the same one 20260921025504 takes and for
    // the same reason: the tick locks cash_games before it writes.
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    expect(CODE).toContain("SET LOCAL lock_timeout = '8s';");
    expect(CODE).toContain('LOCK TABLE public.cash_games IN EXCLUSIVE MODE;');
  });

  it('declares live proofs, every one of them a single parenthesised SELECT', () => {
    // The harness wraps each in a SELECT and expects a single true-ish scalar,
    // so a proof that is two statements, or one that does not close its own
    // parenthesis, is not a proof at all - it is a syntax error at verify time.
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(20);
    for (const p of proofs) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
    }
    const all = proofs.join('\n');
    expect(all).toContain('trg_cash_games_epoch_follows_its_game');
    expect(all).toContain('fn_cash_cluster_front_table');
    expect(all).toContain('CLUSTER_EPOCH_GOES_FORWARD');
  });

  it('counts no population, compares no threshold and converts nothing', () => {
    // lightning_enabled is a capability flag and cluster_mode stays where it
    // is; the population predicate is spec Phase 4 and the conversion is
    // Phase 5. This file repairs Phases 2 and 3 and stops.
    //
    // ABSENCES ARE NOT A TEST. A file containing nothing but `BEGIN;` and
    // `COMMIT;` passes every not.toMatch below, so each is paired with a
    // presence that proves this is the file under test and that it did the
    // work whose absence of side effects is being asserted.
    expect(CODE).toContain('trg_cash_games_epoch_follows_its_game');
    expect(CODE).toContain('fn_cash_cluster_front_table');
    expect(CODE.length).toBeGreaterThan(5000);

    // The three thresholds the spec names for Phase 4, in any spelling.
    expect(CODE).not.toMatch(/\b(18|27|12)\b/);
    expect(CODE).not.toMatch(/\bpopulation\b/i);
    expect(CODE).not.toMatch(/thresholds?/i);
    // cluster_mode is READ here - the epoch row copies it - and never written.
    expect(CODE).not.toMatch(/UPDATE\s+public\.cash_games\b/i);
    expect(CODE).not.toMatch(/SET\s+cluster_mode/i);
    expect(CODE).toContain('NEW.cluster_mode');
    // The two Lightning relations get an index and not a row.
    expect(CODE).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.lightning_/i);
    expect(CODE).toContain('CREATE INDEX IF NOT EXISTS lightning_pool_session_by_epoch');
  });
});

// ===========================================================================
//  (b) THE BROWSER ASKS THE SAME QUESTION
// ===========================================================================

const table = (over: Partial<LobbyTable> = {}): LobbyTable => ({
  id: 't-main1',
  name: 'NLH 1/2 Action',
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  status: 'running',
  max_players: 6,
  seated: 4,
  open_seats: 2,
  seat_change_queue: 0,
  seats: [],
  ...over,
});

const feeder = (over: Partial<LobbyTable> = {}): LobbyTable =>
  table({
    id: 't-feeder',
    name: 'NLH 1/2 Action Feeder',
    role: 'feeder',
    main_index: null,
    ...over,
  });

const listed = (over: Partial<LobbyListEntry> = {}): LobbyListEntry => ({
  position: 1,
  user_id: 'u-1',
  alias: 'Ada',
  table_id: 't-feeder',
  table_name: 'NLH 1/2 Action Feeder',
  role: 'feeder',
  main_index: null,
  joined_at: '2026-09-21T04:40:45Z',
  ...over,
});

describe('Phase 3 remediation in the browser: which table is the main game', () => {
  it('falls back to the pre-Lightning rule when the payload names no front table', () => {
    // A lobby payload read before 20260921044045 does not carry the id, and a
    // client that started answering NULL for every table the moment it met one
    // would break every Cluster in the estate rather than the one shape that
    // needed fixing. Absent the id it answers exactly as it always did.
    expect(isMainOne(table())).toBe(true);
    expect(isMainOne(table({ role: 'main', main_index: 2 }))).toBe(false);
    expect(isMainOne(feeder())).toBe(false);
    // null and undefined both mean "the payload did not say".
    expect(isMainOne(table(), null)).toBe(true);
    expect(isMainOne(feeder(), undefined)).toBe(false);
  });

  it('answers purely from the id once the server has named one', () => {
    // This is the whole repair. A Lightning-capable Cluster opens as a single
    // FEEDER, so `role = main AND main_index = 1` answers "none of them" for
    // the only table the game has; and on a Cluster mid-renumber a row that
    // still says Main 1 may no longer be the table that stands for the game.
    // Given the id, neither column is consulted at all.
    const lone = feeder();
    expect(isMainOne(lone, lone.id)).toBe(true);
    const main1 = table();
    expect(isMainOne(main1, 't-feeder')).toBe(false);
  });

  it('keeps Main 1 / Main 3 / Feeder when the payload names no front table', () => {
    // The one-argument answers are pinned in tests/must-move-lobby.test.tsx.
    // What is pinned HERE is that adding the second argument did not disturb
    // them: passing null is the case every pre-20260921044045 payload takes.
    expect(lobbyTableLabel(table(), null)).toBe('Main 1');
    expect(lobbyTableLabel(table({ main_index: 3 }), null)).toBe('Main 3');
    expect(lobbyTableLabel(feeder(), null)).toBe('Feeder');
  });

  it('calls the feeder that IS the game the Main Game, and still calls Main 1 Main 1', () => {
    // Naming the game's only table "Feeder" names the game after one of its
    // own parts, and every other sentence in the modal calls that table the
    // main game. A real Main 1 keeps its number, because a Cluster that HAS
    // one has other tables to tell it apart from.
    const lone = feeder();
    expect(lobbyTableLabel(lone, lone.id)).toBe('Main Game');
    const main1 = table();
    expect(lobbyTableLabel(main1, main1.id)).toBe('Main 1');
    // A feeder that is NOT the front is still a feeder.
    expect(lobbyTableLabel(lone, 't-main1')).toBe('Feeder');
  });

  it('carries the row own table id into the must-move list, and never labels a row Main Game', () => {
    // fn_cash_game_must_move_list excludes the front table by construction -
    // the list is who is NOT in the main game - so no row here can be it, and
    // mustMoveListRows deliberately passes no front table id. The id still
    // travels, because the label reads it and a row without one could never be
    // told apart from the front table if a caller ever did supply one.
    const rows = mustMoveListRows(
      [
        listed({ position: 2, user_id: 'u-2' }),
        listed({
          position: 1,
          user_id: 'u-1',
          alias: null,
          role: 'main',
          main_index: 2,
          table_id: 't-main2',
          table_name: 'NLH 1/2 Action Main 2',
        }),
      ],
      'u-1'
    );
    expect(rows.map((r) => r.position)).toEqual([1, 2]);
    expect(rows.map((r) => r.tableLabel)).toEqual(['Main 2', 'Feeder']);
    expect(rows.map((r) => r.name)).toEqual(['Player', 'Ada']);
    expect(rows.map((r) => r.me)).toEqual([true, false]);
    for (const r of rows) expect(r.tableLabel).not.toBe('Main Game');
  });
});

describe('Phase 3 remediation in the browser: the server answer reaches every reader', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const MODAL = read('src/components/table/MustMoveLobbyModal.tsx');
  const SERVICE = read('src/services/cashGameLobby.ts');

  it('hands lobby.front_table_id to isMainOne and to BOTH lobbyTableLabel call sites', () => {
    // The button and the door must forbid the same table or the modal offers a
    // Request that fn_cash_seat_change_request will refuse. One call site left
    // asking the row alone is enough to reintroduce that disagreement, so the
    // call sites are counted rather than spot-checked.
    expect(MODAL).toContain('const frontTableId = lobby?.front_table_id ?? null;');
    expect(MODAL).toContain('isMainOne(t, frontTableId)');
    expect(MODAL).not.toMatch(/isMainOne\(\s*t\s*\)/);
    const labelCalls = [...MODAL.matchAll(/lobbyTableLabel\(([^)]*)\)/g)].map((m) => m[1]);
    expect(labelCalls.length).toBe(2);
    for (const args of labelCalls) {
      expect(args, `lobbyTableLabel(${args}) does not pass the front table`).toContain(
        'front_table_id'
      );
    }
  });

  it('declares front_table_id on CashGameLobby, and passes the row id into the label', () => {
    // Optional, because a payload read before 20260921044045 does not carry
    // it and the fallback above is what serves that payload.
    const start = SERVICE.indexOf('export interface CashGameLobby {');
    expect(start).toBeGreaterThan(-1);
    const iface = SERVICE.slice(start, SERVICE.indexOf('\n}', start));
    expect(iface).toMatch(/front_table_id\?: string \| null;/);
    expect(SERVICE).toContain('id: e.table_id,');
  });
});
