/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TABLES OPEN AND CLOSE THEMSELVES (Operation Table Stakes, Slice 2 + 6;
 *  OPORD 1.4 section 18). 2026-09-05.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "HOW DO WE MAKE THE TABLES SMART? TO OPEN AND CLOSE AUTOMATICALLY
 * WITHOUT ANY HUMAN DOING ANYTHING EVER?" This file pins the wiring that
 * answers it, so it cannot be unplugged quietly:
 *
 *   - the controller runs on the leader beside the fleet, and stops with it;
 *   - the SQL tick does its steps in the OPORD's order and a move is not a
 *     leave (no wallet);
 *   - the engine announces a move at the start of a hand and executes it at
 *     the end of one, and on every idle tick;
 *   - the fleet never counts a cluster table in a name family and never seeds
 *     a breaking one;
 *   - Main 1 is kept alive by the controller, not by row flags (R3);
 *   - the thaw gives the cluster clocks back (18.5);
 *   - the scope is must-move games only (R9).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SQL = read('supabase/migrations/20260905010500_cluster_controller_slice_2.sql');
const COLS = read('supabase/migrations/20260905010000_cluster_columns_slice_2.sql');
const GAME_SERVER = read('server/src/GameServer.ts');
const FLEET = read('server/src/services/HorseFleetManager.ts');
const BASE = read('server/src/engine/ServerTableEngineBase.ts');
const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
const CONTROLLER = read('server/src/cluster/ClusterController.ts');
const MOVES = read('server/src/services/supabase/seatMoves.ts');
const STABLE_HAND = read('server/src/services/StableHandController.ts');
const STABLE_HAND_EXECUTOR = read('server/src/services/StableHandExecutor.ts');
const STABLE_HAND_SNAPSHOT = read('server/src/services/StableHandSnapshot.ts');
const TICK_FIX = read('supabase/migrations/20260905030000_cluster_tick_survives_safeupdate.sql');
const ROTATOR = read('server/src/services/HorseSessionRotator.ts');
const LIFECYCLE = read('server/src/services/HorseLifecycleManager.ts');
const DEEP_DIVE = read(
  'supabase/migrations/20260905050000_the_move_survives_the_hand_and_a_game_seats_you_once.sql'
);

describe('the controller is wired on the leader, beside the fleet', () => {
  it('is constructed with the fleet census, the engine door and the engine map', () => {
    expect(GAME_SERVER).toMatch(/private clusterController = new ClusterController\(\{/);
    expect(GAME_SERVER).toMatch(
      /eligibleHorseCount: \(tableId\) => this\.horseFleet\.eligibleHorseCount\(tableId\)/
    );
    expect(GAME_SERVER).toMatch(
      /ensureEngine: \(tableId\) => this\.ensureCashTableEngine\(tableId\)/
    );
    expect(GAME_SERVER).toMatch(/hasEngine: \(tableId\) => this\.tableEngines\.has\(tableId\)/);
  });

  it('starts right after the fleet on the leader path and stops with it', () => {
    const start = GAME_SERVER.indexOf('this.clusterController.start();');
    const fleetStart = GAME_SERVER.indexOf(
      "reportError(err, 'GameServer.horse_fleet_start_failed')"
    );
    expect(start).toBeGreaterThan(fleetStart);
    expect(GAME_SERVER).toMatch(/this\.horseFleet\.stop\(\);\s*this\.clusterController\.stop\(\);/);
  });

  it('honours the freeze before any I/O and again inside the SQL', () => {
    expect(CONTROLLER).toMatch(/if \(frozen\(\)\) \{\s*summary\.skippedFrozen = true;/);
    expect(SQL).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s*RETURN jsonb_build_object\('ok', false, 'skipped', 'frozen'\)/
    );
  });

  it('ticks every 5 seconds and passes the horse demand for Main 1', () => {
    expect(CONTROLLER).toMatch(/export const CLUSTER_TICK_MS = 5000;/);
    expect(CONTROLLER).toMatch(/p_eligible_horses: eligible/);
  });
});

describe('the SQL tick does the steps in the OPORD order', () => {
  it('RECONCILE, MUST-MOVE, OPEN, PROMOTE, BREAK, ROLES, WAKE/SLEEP', () => {
    const body = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick'));
    const order = [
      '-- ── 1. RECONCILE',
      '-- ── 2. MUST-MOVE',
      '-- ── 3. OPEN',
      '-- ── 4. PROMOTE',
      '-- ── 5. BREAK',
      '-- ── 6. ROLES',
      '-- ── 7. WAKE / SLEEP',
    ];
    let at = -1;
    for (const step of order) {
      const next = body.indexOf(step);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
  });

  it('locks the game row and refuses a manual game (R9)', () => {
    expect(SQL).toMatch(
      /SELECT \* INTO g FROM public\.cash_games WHERE id = p_game_id FOR UPDATE;/
    );
    expect(SQL).toMatch(
      /IF NOT g\.must_move THEN RETURN jsonb_build_object\('ok', false, 'reason', 'manual_game'\)/
    );
  });

  it('opens a feeder only on two buyers, holds one buyer for 60 s, never a ghost table', () => {
    expect(SQL).toMatch(/IF v_buyers >= 2 THEN/);
    expect(SQL).toMatch(/ELSIF v_buyers = 1 THEN/);
    expect(SQL).toMatch(/g\.opening_hold_since < v_now - interval '60 seconds'/);
    expect(SQL).toMatch(/'table_opening_hold_expired'/);
  });

  it('never breaks Main 1, and only after five minutes of the condition holding', () => {
    expect(SQL).toMatch(/WHERE NOT \(role = 'main' AND main_index = 1\) AND lifecycle = 'live'/);
    expect(SQL).toMatch(/r\.break_eligible_since <= v_now - interval '5 minutes'/);
    expect(SQL).toMatch(/SET break_eligible_since = NULL/);
  });

  it('keeps Main 1 alive itself (R3), not through the lifecycle-pass flags', () => {
    expect(SQL).toMatch(/IF g\.enabled AND \(v_main1\.id IS NULL OR v_main1\.status NOT IN/);
    // The cluster writer sets all three flags false for every cluster table.
    const writer = SQL.slice(
      SQL.indexOf('fn_cash_cluster_open_table('),
      SQL.indexOf('fn_cash_game_create(')
    );
    expect(writer).toMatch(/auto_extension, auto_restart, auto_create_table,/);
    expect(writer).toMatch(/^\s*false, false, false,\s*$/m);
    const create = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_create'),
      SQL.indexOf('-- 3. A move is not a leave')
    );
    expect(create).not.toMatch(/v_must_move, v_must_move, false/);
    expect(create).toMatch(/fn_cash_cluster_open_table\(v_game_id, 'main', 1, 'live', v_uid\)/);
  });

  it('derives dormant | live; nobody sets it', () => {
    expect(SQL).toMatch(
      /CASE WHEN v_seated_total = 0 AND coalesce\(p_eligible_horses, 0\) = 0 THEN 'dormant' ELSE 'live' END/
    );
  });
});

describe('a move is not a leave', () => {
  const exec = SQL.slice(
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute'),
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
  );

  it('writes no wallet row and closes no session', () => {
    expect(exec).not.toMatch(
      /wallet_transactions|club_members|fn_credit_and_log|fn_cash_session_close/
    );
  });

  it('empties the old chair without an exit of chips, then fills the new one', () => {
    const zero = exec.indexOf('SET stack = 0 WHERE id = src.id');
    const left = exec.indexOf('SET left_at = clock_timestamp()');
    const fill = exec.indexOf('INSERT INTO public.table_seats');
    expect(zero).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(zero);
    expect(fill).toBeGreaterThan(left);
  });

  it('the session follows the player with its clock untouched', () => {
    expect(exec).toMatch(
      /UPDATE public\.cash_player_session\s+SET scope_id = dst\.id, table_id = dst\.id/
    );
    expect(exec).not.toMatch(/stay_remaining_ms|baseline\s*=/);
  });

  it('keeps seniority: the new chair carries the source joined_at', () => {
    expect(exec).toMatch(/joined_at = src\.joined_at/);
  });

  it('is refused while frozen and thawed with everything else', () => {
    expect(exec).toMatch(/IF public\.fn_platform_frozen\(\) THEN/);
    expect(SQL).toMatch(/'cluster_move_expires_at'/);
    expect(SQL).toMatch(/'cluster_break_eligible_since'/);
  });
});

describe('the engine executes at the hand boundary and announces at the start', () => {
  /* 2026-09-05, the deep dive after the first live cycle. Three things the
     first cut got wrong, each now a pin:
       - a move was announced at load_seats and executed in the leave_pending
         sweep on the SAME iteration, milliseconds later, before the hand the
         notice referred to; the announcement now sits immediately before
         dealHand and the idle-branch execute is in the idle branch;
       - settlement executed every pending move, announced or not, so a move
         planned mid-hand landed unannounced; settlement executes announced
         moves only, and the announcement is written to the row
         (fn_cash_seat_move_announce) so a slow hand cannot expire it;
       - the start() wait-for-players loop never executed a move at all, so a
         lone player on a feeder was planned onto Main 1 every minute and
         never moved (seventeen expired rows, 00:28-00:45 UTC). */
  it('settlement executes ANNOUNCED moves after the leavers, at the end of the hand', () => {
    const step = SETTLEMENT.slice(
      SETTLEMENT.indexOf("runStep('leave_pending'"),
      SETTLEMENT.indexOf("runStep('table_unlock'")
    );
    expect(step).toMatch(/await processLeavePending\(/);
    expect(step).toMatch(/await this\.executePendingSeatMoves\(\{ announcedOnly: true \}\);/);
    expect(step.indexOf('processLeavePending(')).toBeLessThan(
      step.indexOf('executePendingSeatMoves(')
    );
  });

  it('an idle table executes every pending move, in the idle branch and nowhere before the deal', () => {
    const idle = DEALING.slice(
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');"),
      DEALING.indexOf('SPIN REVEAL HOLD')
    );
    expect(idle).toMatch(
      /'idle_seat_moves',\s*ServerTableEngineBase\.DEAL_STEP_BUDGET_MS,\s*this\.executePendingSeatMoves\(\)/
    );
    // The pre-deal sweeps must not execute: a move announced for THIS hand
    // would land before it.
    const preDeal = DEALING.slice(
      DEALING.indexOf("'load_seats',"),
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');")
    );
    expect(preDeal).not.toMatch(/executePendingSeatMoves\(/);
  });

  it('the wait-for-players loop executes them too (a lone feeder player is not stranded)', () => {
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/await this\.executePendingSeatMoves\(\)\.catch\(/);
    expect(wait).toMatch(/await this\.stopIfClusterTableClosed\(\)\.catch\(/);
  });

  it('the announcement is made immediately before the deal and written to the row', () => {
    const beforeDeal = DEALING.slice(
      DEALING.indexOf('if (this.hasOpenBountyReveal()) {'),
      DEALING.indexOf('await this.dealHand(activePlayers);')
    );
    expect(beforeDeal).toMatch(
      /'announce_seat_moves',\s*ServerTableEngineBase\.DEAL_STEP_BUDGET_MS,\s*this\.announcePendingSeatMoves\(\)/
    );
    const announce = BASE.slice(
      BASE.indexOf('protected async announcePendingSeatMoves'),
      BASE.indexOf('protected async executePendingSeatMoves')
    );
    expect(announce).toMatch(/await announceSeatMoves\(fresh\)/);
    expect(MOVES).toMatch(/fn_cash_seat_move_announce/);
    expect(MOVES).toMatch(/pending\.filter\(\(m\) => m\.announced_at != null\)/);
  });

  it('a player is told once at the start of the hand, and never asked', () => {
    expect(DEALING).toMatch(
      /'announce_seat_moves',\s*ServerTableEngineBase\.DEAL_STEP_BUDGET_MS,\s*this\.announcePendingSeatMoves\(\)/
    );
    expect(BASE).toMatch(/type: 'seat_move_pending'/);
    expect(MOVES).toMatch(/Seat Open On \$\{where\}\. Moving After This Hand\./);
    const notice = MOVES.slice(MOVES.indexOf('export function seatMoveNotice'));
    expect(notice).not.toMatch(/stay or go|Stay Or Go/i);
    // The two sentences a player reads carry no question and no em dash.
    for (const line of notice.match(/`[^`]*`/g) ?? []) {
      expect(line).not.toMatch(/[?\u2014]/);
    }
  });

  it('forgets the mover without cashing out: no atomicCashout in the move path', () => {
    const fn = BASE.slice(
      BASE.indexOf('protected async executePendingSeatMoves'),
      BASE.indexOf('private lastClusterClosedCheckAt')
    );
    expect(fn).toMatch(/this\.chipContinuity\.forget\(m\.player_id\)/);
    expect(fn).not.toMatch(/atomicCashout|markSeatAsLeft|leaveTable\(/);
    expect(fn).toMatch(/type: 'seat_moved'/);
  });

  it('only a cluster table does any of this', () => {
    expect(BASE).toMatch(
      /if \(this\.isTournamentTable\(\) \|\| !this\.tableInfo\?\.cluster_id\) return \[\];/
    );
  });
});

describe('the fleet keeps its hands off cluster tables', () => {
  it('a cluster table is in no name family (surplus, spawn)', () => {
    expect(FLEET).toMatch(
      /\.filter\(\(t\) => !t\.cluster_id\)\s*\.filter\(\(t\) => t\.name === config\.name/
    );
    expect(FLEET).toMatch(/\(t\) => !t\.cluster_id && \(t\.name === config\.name/);
  });

  it('a breaking table gets no horses (18.3: no new sit-ins)', () => {
    expect(FLEET).toMatch(
      /if \(table\.lifecycle === 'breaking' \|\| table\.lifecycle === 'closed'\) continue;/
    );
  });

  it('reports how many horses could sit, per table, for the open rule - full tables included', () => {
    /* 2026-09-05: the count used to be written only for a table with a seat
       to fill and never cleared, so a FULL Main 1 - the one state in which
       the open rule needs it - reported a stale number for ever. Built fresh
       per cycle and swapped whole; a cluster table that has nothing to fill
       still runs the candidate filter (countOnly) and answers. */
    expect(FLEET).toMatch(
      /nextEligible\.set\(table\.id, pool\.length\);\s*if \(countOnly\) continue;/
    );
    expect(FLEET).toMatch(/this\.lastEligibleByTable = nextEligible;/);
    expect(FLEET).toMatch(
      /if \(seatsAllowed <= 0\) \{\s*if \(!table\.cluster_id\) continue;\s*countOnly = true;/
    );
    expect(FLEET).toMatch(/eligibleHorseCount\(tableId: string\): number/);
  });

  it('one seat per game: a horse at any table of a game is no candidate for another of them', () => {
    expect(FLEET).toMatch(/clusterByTableId\.get\(tid\) === table\.cluster_id\) return false;/);
  });

  it('a planned arrival holds its seat: pending moves count as occupied', () => {
    expect(FLEET).toMatch(
      /\.from\('cash_seat_moves'\)\s*\.select\('to_table_id'\)\s*\.eq\('state', 'pending'\)/
    );
    expect(FLEET).toMatch(
      /occupiedNumbers\.size \+ \(pendingMovesByTable\.get\(table\.id\) \?\? 0\)/
    );
  });

  it('inside a game the mains are seeded before the feeder', () => {
    expect(FLEET).toMatch(/t\.role === 'feeder' \? 1000 : Number\(t\.main_index \?\? 999\)/);
  });

  it('the stale-seat sweep and the rotator drain leave cluster tables alone', () => {
    expect(LIFECYCLE).toMatch(/if \(tableRow\?\.cluster_id\) continue;/);
    expect(ROTATOR).toMatch(
      /if \(t\?\.cluster_id\) continue;\s*if \(!isRetiringTable\(t\)\) continue;/
    );
  });

  it('an engine on a closed, empty cluster table stops itself', () => {
    expect(BASE).toMatch(/protected async stopIfClusterTableClosed\(\)/);
    expect(DEALING).toMatch(
      /'idle_cluster_closed',\s*ServerTableEngineBase\.DEAL_STEP_BUDGET_MS,\s*this\.stopIfClusterTableClosed\(\)/
    );
  });

  it('discovery re-checks the map after its awaits, so a controller wake cannot double an engine', () => {
    expect(GAME_SERVER).toMatch(
      /if \(!\(await claimTable\(row\.table_id\)\)\) continue;[\s\S]{0,1200}this\.tableEngines\.has\(row\.table_id\) \|\|\s*this\.tableEngineStartPromises\.has\(row\.table_id\)/
    );
  });
});

describe('a cluster table is never retired, parked or duplicated by the Stable Hand', () => {
  /* Live, 2026-09-05 00:10 UTC: the exotic/limit trim flagged 25 enabled
     Main 1s retire_when_empty; fleet refused to seed, rotator drained,
     retireSurplusTables closed, the tick reopened (R3). Every 30 s. */
  it('the snapshot carries cluster_id and the planner reads it', () => {
    expect(STABLE_HAND_SNAPSHOT).toMatch(/current_players, cluster_id'/);
    expect(STABLE_HAND_SNAPSHOT).toMatch(
      /clusterId: t\.cluster_id \? String\(t\.cluster_id\) : null/
    );
    expect(STABLE_HAND).toMatch(/clusterId\?: string \| null;/);
  });

  it('the per-variant trim skips cluster tables and opens nothing beside a cluster', () => {
    expect(STABLE_HAND).toMatch(
      /if \(t\.clusterId\) \{\s*clusteredVariants\.add\(key\);\s*return;\s*\}/
    );
    expect(STABLE_HAND).toMatch(/!clusteredVariants\.has\(variant\)/);
  });

  it('the night park never takes a cluster table', () => {
    expect(STABLE_HAND).toMatch(/t\.humansSeated === 0 && t\.humansWaiting === 0 && !t\.clusterId/);
  });

  it('the flag writer itself refuses a cluster row', () => {
    expect(STABLE_HAND_EXECUTOR).toMatch(/select\('id, settings, cluster_id'\)/);
    expect(STABLE_HAND_EXECUTOR).toMatch(/if \(row\.cluster_id\) continue;/);
  });

  it('the fleet never counts a cluster table as retiring or parked', () => {
    expect(FLEET).toMatch(/if \(t\.cluster_id\) continue;\s*if \(isRetiringTable\(t/);
  });
});

describe('the tick survives the PostgREST session (safeupdate)', () => {
  /* authenticator preloads safeupdate: no UPDATE or DELETE without WHERE,
     inside SECURITY DEFINER functions included. The temp-table census had
     four; every production tick failed for 13 minutes on 2026-09-05. */
  it('the census is an array of a composite type, not a temp table', () => {
    expect(TICK_FIX).toMatch(/CREATE TYPE public\.cash_cluster_census_row AS \(/);
    expect(TICK_FIX).toMatch(/RETURNS public\.cash_cluster_census_row\[\]/);
    const tick = TICK_FIX.slice(
      TICK_FIX.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick'),
      TICK_FIX.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick')
    );
    expect(tick).not.toMatch(/CREATE TEMP TABLE|pg_temp\.cluster_census|DELETE FROM/);
    expect(tick).toMatch(/FROM unnest\(v_census\) c/);
  });

  it('the migration asserts it and the probe checks every fn_cash_* body', () => {
    expect(TICK_FIX).toMatch(/still uses the temp-table census/);
    expect(TICK_FIX).toMatch(/has a DELETE; safeupdate would refuse/);
    const probe = read('scripts/dev/probe-cluster-controller.sql');
    expect(probe).toMatch(/SAFEUPDATE statements without WHERE in fn_cash_\*/);
  });

  it('ticks games in a bounded pool, not one after another', () => {
    expect(CONTROLLER).toMatch(/export const CLUSTER_TICK_CONCURRENCY = 8;/);
    expect(CONTROLLER).toMatch(/await Promise\.all\(workers\);/);
  });
});

describe('the controller cannot go silent', () => {
  /* Live 2026-09-04 22:10 UTC: `await ensureEngine()` on a Main 1 with one
     player seated waits for the second player (engine.start() returns only
     when the table can deal). The pass never ended, the inTick latch held,
     and every tick after it returned early - eleven minutes with no error
     and no log line, found only from cash_games.last_tick_at. */
  it('the wake is never awaited - the engine map is the proof of the wake', () => {
    expect(CONTROLLER).toMatch(/void this\.deps\s*\.ensureEngine\(tableId\)/);
    expect(CONTROLLER).not.toMatch(/await this\.deps\.ensureEngine\(/);
  });

  it('a stuck pass is reported and the latch released, not honoured forever', () => {
    expect(CONTROLLER).toMatch(/export const CLUSTER_TICK_STALL_MS = 120_000;/);
    expect(CONTROLLER).toMatch(
      /if \(heldMs < CLUSTER_TICK_STALL_MS\) return this\.lastSummary \?\? summary;/
    );
    expect(CONTROLLER).toMatch(/'ClusterController\.tick_stalled'/);
  });
});

describe('the columns part is its own, lock-timed transactions', () => {
  it('says why, and takes each lock on its own', () => {
    expect(COLS).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect((COLS.match(/^BEGIN;$/gm) ?? []).length).toBe(3);
    expect(COLS).toMatch(/realtime/);
  });
});

describe('the deep dive after the first live cycle (20260905050000)', () => {
  it('a move lives three minutes and the announcement extends it', () => {
    expect(DEEP_DIVE).toMatch(
      /ALTER COLUMN expires_at SET DEFAULT now\(\) \+ interval '3 minutes'/
    );
    expect(DEEP_DIVE).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_cash_seat_move_announce\(p_move_ids uuid\[\]\)/
    );
    expect(DEEP_DIVE).toMatch(
      /expires_at\s*=\s*GREATEST\(expires_at, clock_timestamp\(\) \+ interval '5 minutes'\)/
    );
  });

  it('the executor declares itself, refuses to move nothing, and gives the mover a fresh entry', () => {
    const exec = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute'),
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit')
    );
    expect(exec).toMatch(/set_config\('app\.cash_seat_move', 'on', true\)/);
    expect(exec).toMatch(/IF coalesce\(src\.stack, 0\) <= 0 THEN/);
    expect(exec).toMatch(/note = 'busted'/);
    expect(exec).toMatch(/entry_hold = 'waiting', entry_post_agreed = false/);
    expect(exec).not.toMatch(/entry_post_agreed = src\.entry_post_agreed/);
  });

  it('the cap exempts the declared move and nothing else; the door refuses a second seat in one game', () => {
    const cap = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit'),
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_refuse_seat_on_closed_cluster_table')
    );
    expect(cap).toMatch(/current_setting\('app\.cash_seat_move', true\) = 'on'/);
    expect(cap.replace(/--.*$/gm, '')).not.toMatch(/t\.cluster_id = v_cluster/);
    const door = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_refuse_seat_on_closed_cluster_table'),
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table')
    );
    expect(door).toMatch(/ALREADY_IN_GAME/);
    expect(door).toMatch(/TABLE_CLOSING/);
  });

  it('the planner skips a busted or leaving seat, and never plans a player onto a table they sit at', () => {
    const tick = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
    );
    expect(tick).toMatch(/coalesce\(ts\.stack, 0\) > 0/);
    expect(tick).toMatch(/coalesce\(ts\.leave_pending, false\) = false/);
    expect(tick).toMatch(/d\.table_id = t\.id AND d\.user_id = ts\.user_id AND d\.left_at IS NULL/);
  });

  it('an abandoned opening feeder closes, and OPEN waits two minutes after it', () => {
    const tick = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
    );
    expect(tick).toMatch(/'feeder_abandoned'/);
    expect(tick).toMatch(/interval '3 minutes'/);
    expect(tick).toMatch(/e\.kind = 'feeder_abandoned' AND e\.at > v_now - interval '2 minutes'/);
  });

  it('a second chair on a breaking table goes home through the table-close cash-out', () => {
    const tick = DEEP_DIVE.slice(
      DEEP_DIVE.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
    );
    expect(tick).toMatch(
      /atomic_seat_cashout_locked\(r\.user_id, t\.id, r\.seat_number, 'forced'\)/
    );
    expect(tick).toMatch(/'second_chair_cashed_out'/);
    // The same three calls fn_cashout_seats_for_closing_table makes.
    expect(tick).toMatch(/fn_ensure_club_wallet\(r\.user_id, r\.club_id\)/);
    expect(tick).toMatch(/fn_ca_declare_ledger\('table_cashout', 'table_stack', t\.id\)/);
  });

  it('Big Blind Ante means the big blind posts it: the writer sets the flag', () => {
    expect(DEEP_DIVE).toMatch(/ante_enabled, ante, ante_bb, big_blind_ante_enabled,/);
    expect(DEEP_DIVE).toMatch(/\(v_ante = 'bb'\),/);
  });

  it('no temp table and no bare UPDATE or DELETE in any body (safeupdate)', () => {
    const code = DEEP_DIVE.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/CREATE TEMP TABLE/);
    for (const stmt of code.match(/\b(UPDATE|DELETE FROM) public\.\w+[\s\S]*?;/g) ?? []) {
      expect(stmt, stmt.slice(0, 80)).toMatch(/\bWHERE\b/);
    }
  });
});

/**
 * THE MUST MOVE LOBBY (Dan 2026-09-05, 20260905060000). The roster is the
 * must-move order, a seat change once per stay (never from or to Main 1),
 * swaps land both chairs at once, and the two entries: a seat change posts,
 * a move by the game does not. The floor is for winners.
 */
const LOBBY = read(
  'supabase/migrations/20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql'
);

describe('the must move lobby: the roster is the order, the seat change is once, a swap is two', () => {
  const tick = LOBBY.slice(LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick'));
  const exec = LOBBY.slice(
    LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute'),
    LOBBY.indexOf('-- ── The floor is for winners')
  );

  it('the roster row survives a move and closes when the last chair empties', () => {
    expect(LOBBY).toMatch(/CREATE TABLE IF NOT EXISTS public\.cash_game_roster/);
    expect(LOBBY).toMatch(/idx_cash_game_roster_open[\s\S]*WHERE left_at IS NULL/);
    // The trigger lets a declared move through and never refuses a seat.
    expect(LOBBY).toMatch(
      /IF current_setting\('app\.cash_seat_move', true\) IS DISTINCT FROM 'on'[\s\S]*UPDATE public\.cash_game_roster SET left_at = now\(\)/
    );
    expect(LOBBY).toMatch(/EXCEPTION WHEN OTHERS THEN\s*RAISE WARNING 'fn_cash_game_roster_track/);
    expect(LOBBY).toMatch(/AFTER INSERT OR UPDATE OF left_at, user_id ON public\.table_seats/);
  });

  it('the planner fills Main 1 from the whole list and orders by the roster, not the chair', () => {
    expect(tick).toMatch(/\(t\.main_index = 1 AND c\.id <> t\.id\)/);
    expect(tick).toMatch(
      /ORDER BY c\.breaking DESC,\s*coalesce\(\(SELECT r2\.joined_at FROM public\.cash_game_roster r2/
    );
    // The break step too.
    expect(tick).toMatch(
      /ORDER BY coalesce\(\(SELECT r2\.joined_at FROM public\.cash_game_roster r2[\s\S]*?ts\.joined_at\),\s*ts\.joined_at\s*LOOP/
    );
    // Seat changes are planned after the mains are filled and before OPEN.
    const seatChangeAt = tick.indexOf('fn_cash_seat_change_plan(g.id, v_now)');
    expect(seatChangeAt).toBeGreaterThan(tick.indexOf('MUST-MOVE (1.3 s9.5)'));
    expect(seatChangeAt).toBeLessThan(tick.indexOf('3. OPEN (18.3)'));
  });

  it('the list is everyone in the game but Main 1, in join order', () => {
    expect(LOBBY).toMatch(
      /fn_cash_game_must_move_list[\s\S]*?NOT \(t\.role = 'main' AND t\.main_index = 1\)[\s\S]*?ORDER BY r\.joined_at, r\.id/
    );
  });

  it('a seat change is once per roster row, never from Main 1, never to Main 1', () => {
    const door = LOBBY.slice(
      LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_request')
    );
    expect(door).toMatch(/SEAT_CHANGE_NOT_FROM_MAIN/);
    expect(door).toMatch(/SEAT_CHANGE_NEVER_TO_MAIN/);
    expect(door).toMatch(/SEAT_CHANGE_USED/);
    expect(door).toMatch(/UPDATE public\.cash_game_roster SET seat_change_used_at = now\(\)/);
    // Cancel gives the button back; a planned move is already the engine's.
    expect(door).toMatch(
      /status = 'requested';\s*GET DIAGNOSTICS v_n = ROW_COUNT;[\s\S]*?SET seat_change_used_at = NULL/
    );
    // The door takes the tick's lock.
    expect(door).toMatch(/FROM public\.cash_games WHERE id = p_game_id FOR UPDATE/);
  });

  it('a request takes an open chair on a table that is not Main 1, else swaps with a partner', () => {
    const plan = LOBBY.slice(
      LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_plan')
    );
    expect(plan).toMatch(/NOT \(c\.role = 'main' AND c\.main_index = 1\)/);
    expect(plan).toMatch(/\(r\.to_table_id IS NULL OR c\.id = r\.to_table_id\)/);
    expect(plan).toMatch(/\(r\.to_table_id IS NULL OR q\.from_table_id = r\.to_table_id\)/);
    expect(plan).toMatch(/\(q\.to_table_id IS NULL OR q\.to_table_id = r\.from_table_id\)/);
    expect(plan).toMatch(
      /UPDATE public\.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a/
    );
    expect(plan).toMatch(/'swap_planned'/);
  });

  it('a swap is not a reservation anywhere a pending move is counted', () => {
    expect(LOBBY).toMatch(
      /fn_cash_game_open_seats[\s\S]*?m\.state = 'pending' AND m\.swap_move_id IS NULL/
    );
    expect(tick).toMatch(
      /m\.to_table_id = t\.id AND m\.state = 'pending' AND m\.swap_move_id IS NULL/
    );
    expect(FLEET).toMatch(/\.eq\('state', 'pending'\)\s*\.is\('swap_move_id', null\)/);
  });

  it('the swap holds the first side and lands both chairs from the second, in one transaction', () => {
    const swap = LOBBY.slice(
      LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute'),
      LOBBY.indexOf('-- ── The executor: entry by reason')
    );
    expect(swap).toMatch(/ORDER BY id FOR UPDATE/);
    expect(swap).toMatch(/'waiting_partner', 'held', true/);
    expect(swap).toMatch(/PERFORM set_config\('app\.cash_seat_move', 'on', true\)/);
    expect(swap).toMatch(/WHERE id = b\.id;[\s\S]*?WHERE id = a\.id;/);
    expect(swap).toMatch(/'swap', true/);
    expect(exec).toMatch(
      /IF m\.swap_move_id IS NOT NULL THEN\s*RETURN public\.fn_cash_seat_swap_execute\(m\.id\)/
    );
  });

  it('entry by reason: a seat change posts, a move by the game does not', () => {
    expect(exec).toMatch(
      /v_hold := CASE WHEN m\.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END/
    );
    expect(exec).toMatch(/v_agreed := \(m\.reason = 'seat_change'\)/);
    expect(LOBBY).toMatch(
      /entry_hold = ANY \(ARRAY\['waiting'::text, 'posting'::text, 'moved'::text\]\)/
    );
    // The engine honours both on arrival.
    expect(DEALING).toMatch(
      /entryHold === 'moved'[\s\S]*?persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\)/
    );
    expect(DEALING).toMatch(
      /entryHold === 'waiting' && entryAgreed[\s\S]*?this\.postBBWhenClear\.add\(p\.user_id\)/
    );
    // And on a restart before the first deal.
    expect(BASE).toMatch(
      /else if \(hold === 'moved'\)[\s\S]*?persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\)/
    );
  });

  it('a held swap side is out of the deal, and released when its move is gone', () => {
    expect(BASE).toMatch(/protected heldForSwap: Set<string> = new Set\(\)/);
    expect(DEALING).toMatch(
      /!this\.waitingForBB\.has\(p\.user_id\) &&[\s\S]*?!this\.isHeldForSwap\(p\.user_id\)/
    );
    expect(BASE).toMatch(
      /!this\.waitingForBB\.has\(p\.user_id\) &&\s*!this\.heldForSwap\.has\(p\.user_id\)/
    );
    expect(BASE).toMatch(
      /for \(const uid of this\.heldForSwap\) \{\s*if \(!liveHeld\.has\(uid\)\) this\.heldForSwap\.delete\(uid\)/
    );
    expect(DEALING).toMatch(
      /this\.knownPlayerIds\.delete\(id\);[\s\S]*?this\.heldForSwap\.delete\(id\)/
    );
    expect(BASE).toMatch(/type: 'seat_move_held'/);
    // A swap landed from this side tells the partner's table.
    expect(BASE).toMatch(
      /this\.hub\?\.emitEvent\(m\.partner\.from_table_id, \{\s*type: 'seat_moved'/
    );
    expect(MOVES).toMatch(/res\.reason === 'waiting_partner' && res\.held/);
  });

  it('the floor is for winners: written only above the session baseline', () => {
    const close = LOBBY.slice(
      LOBBY.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_session_close')
    );
    expect(close).toMatch(
      /IF v_s\.id IS NULL OR p_stack <= COALESCE\(v_s\.baseline, 0\) THEN RETURN; END IF;/
    );
    expect(LOBBY).toMatch(/COALESCE\(s\.baseline, 0\) >= c\.required_stack/);
  });

  it('the notices are title case with no em dash, and name the reason', () => {
    expect(MOVES).toMatch(/Seat Change Granted\. Swapping To \$\{where\} After This Hand\./);
    expect(MOVES).toMatch(/Seat Change Granted\. Moving To \$\{where\} After This Hand\./);
    expect(MOVES).not.toMatch(/—/);
    expect(BASE).toMatch(/Seat Change: Waiting For The Other Table To Finish Its Hand\./);
  });

  it('no temp table and no bare UPDATE or DELETE in any body (safeupdate)', () => {
    const code = LOBBY.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/CREATE TEMP TABLE/);
    for (const stmt of code.match(/\b(UPDATE|DELETE FROM) public\.\w+[\s\S]*?;/g) ?? []) {
      expect(stmt, stmt.slice(0, 80)).toMatch(/\bWHERE\b/);
    }
  });
});

/**
 * GATE 5 - THE SNAPSHOT IS THE RULE (2026-09-05). A game's ruleset_snapshot
 * is written onto every open table by the tick, every tick; a table can
 * never carry a rule its game does not have.
 */
const GATE5 = read('supabase/migrations/20260905033729_the_snapshot_is_the_rule.sql');

describe('gate 5: the snapshot is the rule on every table', () => {
  it('the tick reconciles the ruleset before it plans anything', () => {
    const tick = GATE5.slice(
      GATE5.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
    );
    const apply = tick.indexOf('v_n := public.fn_cash_apply_ruleset(g.id);');
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(tick.indexOf('MUST-MOVE (1.3 s9.5)'));
  });

  it('the applier maps the snapshot exactly as the opener does, and touches only rows that differ', () => {
    const fn = GATE5.slice(
      GATE5.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_apply_ruleset'),
      GATE5.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_apply_ruleset')
    );
    for (const line of [
      "v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;",
      "v_vpip_window := coalesce((s->>'vpip_window')::integer, 40);",
      "WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'",
      "big_blind_ante_enabled = (v_ante = 'bb')",
      'maintain_percent_min = v_vpip',
      "AND t.lifecycle <> 'closed'",
      't.maintain_percent_min IS DISTINCT FROM v_vpip',
      "'ruleset_applied'",
    ]) {
      expect(fn).toContain(line);
    }
    // Never a straddle on a cash game (R2), even if a row somehow got one.
    expect(fn).toMatch(
      /straddle_enabled = false, auto_utg_straddle = false, voluntary_straddle = false/
    );
  });
});
