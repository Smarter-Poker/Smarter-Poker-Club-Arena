/**
 * LIGHTNING 2.0 PHASE 3: A LIGHTNING-CAPABLE GAME OPENS AS A FEEDER
 *
 * The specification calls this its single most important product rule and
 * marks it a HARD REQUIREMENT: a new Lightning-capable Cluster is created with
 * exactly ONE physical table, that table has role = FEEDER, and the Cluster
 * runs ordinary MUST-MOVE seating until there is population for anything else.
 *
 * The estate did the opposite in two places, and the second is the one that
 * matters: the creation path opened ('main', 1), and the tick's ROLES step
 * promoted a lone live feeder back to Main 1 within five seconds. Changing only
 * the creation path would have been undone automatically.
 *
 * Two halves, because the rule has two homes:
 *
 *   (a) the migration, 20260921025523, which is a set of ASSERTED SUBSTITUTIONS
 *       against live function bodies. Nothing in it is a CREATE OR REPLACE of
 *       the functions it edits, so the only thing standing between a bad
 *       anchor and a silently mangled production function is the count guard
 *       before each replace and the read-back from the catalogue after all of
 *       them. Those are what this half pins.
 *
 *   (b) the board, src/components/lobby/lobbyEntries.ts. R10 says a game is ONE
 *       row, and that row used to be identified by a property of the row alone
 *       (role = main AND main_index = 1), which answers "none of them" for a
 *       feeder-first Cluster. Which table stands for a game is a property of
 *       the CLUSTER, so it is answered by a pass over the whole board.
 *
 * LIGHTNING_P3_MIGRATION overrides the file under test, so mutation testing
 * never has to touch the migration in the repository. It is the same mechanism
 * scripts/dev/test-lightning-phase3-feeder-first.sh takes as
 * LIGHTNING_PHASE3_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  cashEntry,
  clusterFronts,
  isClusterFront,
  isHiddenClusterMember,
  withClusterFigures,
  type LobbyTableRow,
} from '../src/components/lobby/lobbyEntries';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql';
const MIGRATION =
  process.env.LIGHTNING_P3_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
/**
 * Comment-stripped, so no pin can be satisfied by prose. Used only where the
 * text being pinned is the migration's OWN code. The replacement strings this
 * file assembles carry `--` comment lines of their own inside SQL string
 * literals, and the strip eats those, so anything about the text being INSTALLED
 * is asserted against SQL instead.
 */
const CODE = SQL.replace(/--[^\n]*/g, '');

/** The three asserted-substitution blocks, in file order. */
const DO_BLOCKS = [...SQL.matchAll(/DO \$do\$[\s\S]*?END \$do\$;/g)].map((m) => m[0]);

/** The one function this migration creates outright. */
const FRONT_TABLE = CODE.slice(
  CODE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_front_table(p_game_id uuid)'),
  CODE.indexOf('$fn$;') + 5
);

/** The post-apply read-back, which asks the catalogue rather than the variables. */
const READ_BACK = SQL.slice(SQL.indexOf('DO $assert$'), SQL.indexOf('END $assert$;') + 13);

// ===========================================================================
//  (a) THE MIGRATION
// ===========================================================================

describe('Phase 3: one definition of a cluster front table', () => {
  it('creates fn_cash_cluster_front_table as an invoker with a pinned search_path', () => {
    // SECURITY INVOKER deliberately: both callers are already SECURITY DEFINER,
    // so this runs with their privileges and adds no new reach of its own. A
    // definer here would be a third privileged door for no gain.
    expect(FRONT_TABLE).toBeTruthy();
    expect(FRONT_TABLE).toContain('SECURITY INVOKER');
    expect(FRONT_TABLE).not.toContain('SECURITY DEFINER');
    expect(FRONT_TABLE).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it('keeps it out of the browser roles and states the service_role grant', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_front_table(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_front_table(uuid) TO service_role;'
    );
  });

  it('leads its ORDER BY with the live Main 1, which is the whole function', () => {
    // True sorts after false ascending, so DESC puts a live Main 1 first when
    // one exists. Drop this term and the function returns the OLDEST live table
    // for every cluster in the estate - which for all 166 of them that have a
    // Main 1 is a different table whenever the feeder was created first, and
    // the must-move lobby would start listing the main game's own players as
    // movers.
    expect(FRONT_TABLE).toContain(
      "ORDER BY (t.role = 'main' AND t.main_index = 1) DESC, t.created_at, t.id"
    );
    // t.id is the tie-break, so the answer is never arbitrary.
    expect(FRONT_TABLE).toMatch(/ORDER BY[^\n]*, t\.id\s*\n\s*LIMIT 1;/);
  });

  it('asks only of live, undeleted tables', () => {
    expect(FRONT_TABLE).toContain("t.lifecycle <> 'closed'");
    expect(FRONT_TABLE).toContain('coalesce(t.is_deleted, false) = false');
  });
});

describe('Phase 3: every substitution is guarded before it happens', () => {
  it('edits three live bodies, and does so as substitutions rather than restatements', () => {
    // Restating a body this large is how a transcription error reaches
    // production. The three functions edited here are a base definition plus
    // patches, so the file on disk is not what is running at all.
    expect(DO_BLOCKS.length).toBe(3);
    expect(CODE).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_cash_game_create_impl_20260905/
    );
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_cluster_tick/);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_cluster_open_table/);
  });

  it('counts each anchor and refuses unless it occurs exactly once, in all three', () => {
    // An anchor that occurs twice would be replaced twice; an anchor that
    // occurs zero times would be replaced nowhere and the migration would
    // commit a body it never changed. `<> 1` is the only reading that refuses
    // both. It is one deletable line per substitution.
    for (const [i, block] of DO_BLOCKS.entries()) {
      expect(block, `DO block ${i + 1} performs an unguarded substitution`).toContain(
        'IF v_n <> 1 THEN'
      );
      expect(block).toMatch(/RAISE EXCEPTION 'the live/);
    }
  });

  it('guards EVERY substitution, not merely one per block', () => {
    const guards = (SQL.match(/IF v_n <> 1 THEN/g) ?? []).length;
    const replaces = (SQL.match(/v_src := replace\(v_src, v_find/g) ?? []).length;
    expect(replaces).toBeGreaterThanOrEqual(8);
    expect(guards).toBe(replaces);
  });

  it('is re-runnable: each block returns early when its own edit is already in', () => {
    // Without this a second application re-patches an already-patched body,
    // which either finds no anchor and raises, or finds one and doubles the
    // edit. Each block recognises its own work by a string only that work
    // could have installed.
    for (const [i, block] of DO_BLOCKS.entries()) {
      expect(block, `DO block ${i + 1} is not idempotent`).toMatch(
        /IF position\([\s\S]{0,200}? in v_src\) > 0 THEN[\s\S]{0,300}?RAISE NOTICE[\s\S]{0,300}?RETURN;/
      );
    }
    expect(SQL).toContain("IF position('LIGHTNING_NEEDS_MUST_MOVE' in v_src) > 0 THEN");
    expect(SQL).toContain("IF position('lone_feeder_is_the_cluster' in v_src) > 0 THEN");
    expect(SQL).toContain(
      "IF position('the cluster''s first table stands for the game' in v_src) > 0 THEN"
    );
  });
});

describe('Phase 3: nothing the edited bodies already refused may be swallowed', () => {
  it('names all six of the create path refusals before it executes', () => {
    // A replace that ate one of these would be invisible until a host hit it:
    // the function would still compile, still create games, and silently stop
    // refusing a duplicate game or a locked override.
    const create = DO_BLOCKS[0];
    for (const guard of [
      'OVERRIDE_LOCKED',
      'ONE_GAME_PER_BLIND_CATEGORY',
      'GAME_EXISTS',
      'OVERRIDE_INVALID: overrides must be an object',
      'OVERRIDE_INVALID: bombs must be an object',
      'OVERRIDE_INVALID: options must be an object',
    ]) {
      expect(create, `${guard} is not checked for survival`).toContain(
        `position('${guard}' in v_src) = 0`
      );
    }
    expect(create).toMatch(/RAISE EXCEPTION 'a sibling guard did not survive/);
    // The guard runs before the EXECUTE, or it guards nothing.
    expect(create.indexOf("position('OVERRIDE_LOCKED' in v_src) = 0")).toBeLessThan(
      create.indexOf('EXECUTE v_src;')
    );
  });

  it('names at least nine surviving tick steps before it executes', () => {
    // One string per tick step, taken from the step's own event kind or action
    // key. The tick is the hot path for every cluster every five seconds; a
    // replace that swallowed a step would quietly stop breaking tables,
    // planning moves, opening feeders or renumbering mains.
    const tick = DO_BLOCKS[2];
    const survivors = [...tick.matchAll(/position\('([^']+)' in v_src\) = 0/g)].map((m) => m[1]);
    expect(survivors.length).toBeGreaterThanOrEqual(9);
    for (const step of ['feeder_became_main1', 'main_renumbered', 'move_planned']) {
      expect(survivors).toContain(step);
    }
    expect(tick).toMatch(/RAISE EXCEPTION 'a sibling step did not survive/);
    expect(tick.indexOf("position('feeder_became_main1' in v_src) = 0")).toBeLessThan(
      tick.indexOf('EXECUTE v_src;')
    );
  });

  it('checks the cluster writer kept its own four refusals', () => {
    const open = DO_BLOCKS[1];
    for (const guard of [
      'ROLE_INVALID',
      'MAIN_INDEX_INVALID',
      'LIFECYCLE_INVALID',
      'GAME_NOT_FOUND',
    ]) {
      expect(open).toContain(`position('${guard}' in v_src) = 0`);
    }
  });
});

describe('Phase 3: the file ends by asking the catalogue what it kept', () => {
  it('re-reads every edited body with pg_get_functiondef rather than trusting a variable', () => {
    // The variables above say what was SENT. This asks what the database KEPT.
    // A substitution that produced a body PostgreSQL parsed differently than
    // intended passes every check before this one and fails here.
    expect(READ_BACK).toBeTruthy();
    const reads = [...READ_BACK.matchAll(/pg_get_functiondef\('public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(
      [
        'fn_cash_cluster_open_table',
        'fn_cash_cluster_tick',
        'fn_cash_clusters_to_tick',
        'fn_cash_game_create_impl_20260905',
        'fn_cash_game_must_move_list',
      ].sort()
    );
    // Not from v_src, v_new or any variable the blocks above assembled.
    expect(READ_BACK).not.toMatch(/\bv_src\b/);
  });

  it('proves the feeder arrived AND that the ordinary Main 1 path survived', () => {
    // Half of this is the new behaviour and half is everything else: every
    // non-Lightning game in the estate is still created with a Main 1, and a
    // read-back that only checked the new arm would have shipped a create path
    // that made tableless games.
    expect(READ_BACK).toContain(
      "public.fn_cash_cluster_open_table(v_game_id, 'feeder', NULL, 'live', v_uid)"
    );
    expect(READ_BACK).toContain(
      "public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid)"
    );
    expect(READ_BACK).toContain(
      "public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL)"
    );
    expect(READ_BACK).toContain("public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL)");
    expect(READ_BACK).toContain('feeder_became_main1');
  });

  it('proves the front-table answer did not move for a cluster that has a Main 1', () => {
    // And proves the comparison was not vacuous, by refusing to pass when no
    // live cluster has a Main 1 to compare against.
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the front-table definition changed the answer for % existing cluster\(s\)/
    );
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'no live cluster has a Main 1, so the comparison above proved nothing'/
    );
    expect(READ_BACK).toMatch(
      /RAISE EXCEPTION 'the front-table definition invented a table for a cluster that does not exist'/
    );
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

describe('Phase 3: the three readers ask the one definition', () => {
  it('rewires the tick worklist, which is what decides a cluster ever ticks', () => {
    // main1_table_id answered NULL for a feeder-first Cluster, and a NULL there
    // means the ClusterController counts zero eligible horses and never spins
    // an engine: the Cluster would be created and then never tick, never open a
    // second table, and never reach a Lightning threshold at all.
    const worklist = CODE.slice(
      CODE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()'),
      CODE.indexOf('$function$;') + 11
    );
    expect(worklist).toContain('public.fn_cash_cluster_front_table(g.id)');
    expect(worklist).not.toMatch(/t\.role = 'main' AND t\.main_index = 1/);
    // The column keeps its name because eleven call sites in
    // server/src/cluster/ClusterController.ts spell it.
    expect(worklist).toContain('main1_table_id uuid');
  });

  it('rewires the must-move lobby, whose whole job is who is NOT in the main game', () => {
    const list = CODE.slice(
      CODE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_must_move_list(p_game_id uuid)')
    );
    expect(list).toContain('t.id IS DISTINCT FROM public.fn_cash_cluster_front_table(p_game_id)');
    // IS DISTINCT FROM, not <>: a NULL front table would make <> answer NULL
    // for every row and list nobody at all.
    expect(list).not.toMatch(/t\.id <> public\.fn_cash_cluster_front_table/);
  });

  it('keeps both readers definers with pinned search_paths and no browser grant', () => {
    for (const sig of ['fn_cash_clusters_to_tick()', 'fn_cash_game_must_move_list(uuid)']) {
      expect(CODE).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });
});

describe('Phase 3: the flag rides in p_overrides and the signature does not move', () => {
  it('reads lightning_enabled out of the override jsonb', () => {
    // fn_cash_game_create_impl_20260905 is pinned by regprocedure at three
    // sites (20260909035303:87, 20260909181309:131 and :189). Its argument list
    // cannot move without breaking a replay from scratch at all three.
    expect(SQL).toContain("IF v_o ? ''lightning_enabled'' THEN");
    expect(SQL).toContain("v_lightning := (v_o->>''lightning_enabled'')::boolean;");
    // jsonb_typeof rather than a cast: ::boolean on a non-boolean raises 22P02
    // and the caller would see a type error instead of a named refusal.
    expect(SQL).toContain("IF jsonb_typeof(v_o->''lightning_enabled'') <> ''boolean'' THEN");
    expect(SQL).toContain('OVERRIDE_INVALID: lightning_enabled must be true or false');
  });

  it('adds no parameter, renames nothing and drops nothing', () => {
    expect(CODE).not.toMatch(/ALTER FUNCTION/i);
    expect(CODE).not.toMatch(/\bRENAME\b/i);
    expect(CODE).not.toMatch(/DROP FUNCTION public\.fn_cash_game_create_impl_20260905/);
    // Every mention of the function names the same nine-argument signature.
    const sigs = [...SQL.matchAll(/fn_cash_game_create_impl_20260905\(([^)]*)\)/g)].map(
      (m) => m[1]
    );
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      expect(s).toBe('uuid,text,text,numeric,numeric,integer,jsonb,text,boolean');
    }
  });

  it('refuses a Lightning-capable game that is not a Cluster', () => {
    // A manual (R9) table has no controller and lives and dies with its host,
    // so it can never grow tables, move players or convert a population.
    expect(SQL).toContain('LIGHTNING_NEEDS_MUST_MOVE');
    expect(SQL).toContain('IF v_lightning AND NOT v_must_move THEN');
  });
});

describe('Phase 3: scope and safety', () => {
  it('is a single transaction', () => {
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it('counts no population, compares no threshold and converts nothing', () => {
    // lightning_enabled is a capability flag; cluster_mode stays 'must_move'.
    // The population predicate is spec Phase 4 and the conversion is Phase 5.
    expect(CODE).not.toMatch(/SET\s+cluster_mode/i);
    expect(CODE).not.toMatch(/UPDATE\s+public\.cash_games/i);
    expect(CODE).not.toMatch(/thresholds?/i);
    expect(CODE).not.toMatch(/lightning_pool_session|lightning_instance|lightning_reservation/);
  });

  it('declares live proofs, every one of them a single parenthesised SELECT', () => {
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(10);
    for (const p of proofs) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
    }
    expect(proofs.join('\n')).toContain('fn_cash_cluster_front_table');
  });
});

// ===========================================================================
//  (b) THE BOARD
// ===========================================================================

const base: LobbyTableRow = {
  id: 't-fleet',
  name: 'NLH 1/2 Action',
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 100,
  max_buy_in: 400,
  current_players: 6,
  max_players: 6,
  status: 'running',
} as LobbyTableRow;

const cluster = (over: Partial<LobbyTableRow> = {}): LobbyTableRow => ({
  ...base,
  id: 't-main-1',
  cluster_id: 'g1',
  role: 'main',
  main_index: 1,
  lifecycle: 'live',
  cluster_must_move: true,
  cluster_template: 'action',
  cluster_state: 'live',
  cluster_players: 57,
  cluster_tables: 10,
  ...over,
});

const feeder = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
  cluster({ role: 'feeder', main_index: null, ...over });

describe('Phase 3 on the board: a game is one row, whatever role that row has', () => {
  it('a cluster whose only table is a feeder is still exactly one row', () => {
    // This is the defect Phase 3 closes on the client. Under the old predicate
    // the only row of a feeder-first Cluster was a hidden cluster member, so
    // the game did not appear on the board at all.
    const board = withClusterFigures([feeder({ id: 't-feeder-1' })]);
    expect(board.filter((r) => isClusterFront(r)).map((r) => r.id)).toEqual(['t-feeder-1']);
    expect(board.filter((r) => isHiddenClusterMember(r))).toEqual([]);
    expect(cashEntry(board[0]).game?.tables).toBe(1);
  });

  it('a cluster with a Main 1 and an older feeder fronts on the Main 1', () => {
    // The feeder sorts FIRST by id here, deliberately: the rule is not "the
    // lowest id" but "Main 1 when there is one", and only an id ordering that
    // would have chosen the feeder proves which of the two decided.
    const board = withClusterFigures([
      feeder({ id: 't-aaa-feeder' }),
      cluster({ id: 't-zzz-main' }),
    ]);
    expect(board.filter((r) => isClusterFront(r)).map((r) => r.id)).toEqual(['t-zzz-main']);
    expect(board.filter((r) => isHiddenClusterMember(r)).map((r) => r.id)).toEqual([
      't-aaa-feeder',
    ]);
  });

  it('two rows both claiming Main 1 still yield ONE front', () => {
    // A duplicate main_index is a database defect, not a board defect, and the
    // board must not respond to it by painting the same game twice. The id is
    // the tie-break, so the answer is deterministic rather than arrival-ordered.
    const board = withClusterFigures([cluster({ id: 't-b' }), cluster({ id: 't-a' })]);
    expect(board.filter((r) => isClusterFront(r)).map((r) => r.id)).toEqual(['t-a']);
    expect(clusterFronts([cluster({ id: 't-b' }), cluster({ id: 't-a' })]).get('g1')).toBe('t-a');
  });

  it('an un-stamped row falls back to the old predicate, so nothing that worked stops', () => {
    // A bare realtime payload, a fixture, or a caller that skipped the stamp
    // has never seen the whole cluster and cannot answer a question about it.
    // It answers the pre-Lightning way instead, which is right for every
    // cluster that has a Main 1 and wrong only for the one shape that did not
    // exist before Phase 3.
    expect(isClusterFront(cluster({ id: 't-main-1' }))).toBe(true);
    expect(isHiddenClusterMember(cluster({ id: 't-main-1' }))).toBe(false);
    const lone = feeder({ id: 't-feeder-1' });
    expect(isClusterFront(lone)).toBe(false);
    expect(isHiddenClusterMember(lone)).toBe(true);
    // Stamped, the same row answers from the stamp.
    expect(isClusterFront(withClusterFigures([lone])[0])).toBe(true);
  });

  it('a fleet table is neither a front nor a hidden member', () => {
    expect(isClusterFront(base)).toBe(false);
    expect(isHiddenClusterMember(base)).toBe(false);
    expect(clusterFronts([base]).size).toBe(0);
    expect(cashEntry(base).game).toBeUndefined();
  });
});

describe('Phase 3 on the board: the stamp does not churn the rows it did not change', () => {
  it('returns the row ITSELF when nothing about it moved', () => {
    // An existing performance contract, and it is about React, not about
    // arithmetic: the board keys on these objects, and returning a fresh copy
    // of every row on every realtime tick re-renders the whole list. The
    // identity check below is `toBe`, not `toEqual`, because a copy with equal
    // contents is exactly the regression being forbidden.
    const settled = cluster({
      id: 't-main-1',
      current_players: 6,
      cluster_players: 6,
      cluster_tables: 1,
      cluster_front: true,
    });
    const out = withClusterFigures([settled]);
    expect(out[0]).toBe(settled);
  });

  it('is idempotent: a second pass returns the objects the first pass produced', () => {
    const first = withClusterFigures([
      feeder({ id: 't-aaa-feeder' }),
      cluster({ id: 't-zzz-main' }),
    ]);
    const second = withClusterFigures(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('a row with no cluster is handed back untouched', () => {
    const out = withClusterFigures([base]);
    expect(out[0]).toBe(base);
  });
});
