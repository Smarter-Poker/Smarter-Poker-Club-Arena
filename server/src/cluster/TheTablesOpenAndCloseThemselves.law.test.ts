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
  it('settlement executes moves after the leavers, at the end of the hand', () => {
    const step = SETTLEMENT.slice(
      SETTLEMENT.indexOf("runStep('leave_pending'"),
      SETTLEMENT.indexOf("runStep('table_unlock'")
    );
    expect(step).toMatch(/await processLeavePending\(/);
    expect(step).toMatch(/await this\.executePendingSeatMoves\(\);/);
    expect(step.indexOf('processLeavePending(')).toBeLessThan(
      step.indexOf('executePendingSeatMoves()')
    );
  });

  it('an idle table executes them too', () => {
    const idle = DEALING.slice(
      DEALING.indexOf("'leave_pending',"),
      DEALING.indexOf('THE TOURNAMENT COUNTERPART')
    );
    expect(idle).toMatch(/await this\.executePendingSeatMoves\(\);/);
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
      BASE.indexOf('protected isContinuityActive')
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

  it('reports how many horses could sit, per table, for the open rule', () => {
    expect(FLEET).toMatch(/this\.lastEligibleByTable\.set\(table\.id, pool\.length\);/);
    expect(FLEET).toMatch(/eligibleHorseCount\(tableId: string\): number/);
  });
});

describe('the columns part is its own, lock-timed transactions', () => {
  it('says why, and takes each lock on its own', () => {
    expect(COLS).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect((COLS.match(/^BEGIN;$/gm) ?? []).length).toBe(3);
    expect(COLS).toMatch(/realtime/);
  });
});
