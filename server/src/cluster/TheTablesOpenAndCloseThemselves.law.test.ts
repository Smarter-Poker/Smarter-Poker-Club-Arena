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
const SEATING = read('server/src/engine/ServerTableEngineSeating.ts');
/* PIN MOVED 2026-09-05, TWICE IN THREE MINUTES, AND THAT IS THE POINT.
   `fn_cash_clusters_tick_all` was re-declared WHOLE by 20260906011113 (which
   added `rested_games`, the per-result `state`, and the error entry) and then
   again by 20260906011318 (the balancer), which was written from the older
   20260905091025 body and applied two minutes later - so it silently reverted
   the first. Production was repaired the same hour and 20260906011318 now
   carries BOTH: it is the live definition, so it is what this pins.

   The lesson for whoever moves this next: a migration that re-emits a whole
   function must be written from the LIVE body, not from the migration you
   happen to have open. Ask the database (`md5(prosrc)`), then write. */
const TICK_ALL = read(
  'supabase/migrations/20260906011318_the_feeder_tables_stay_within_one_player_of_each_other.sql'
);
/* PIN MOVED 2026-09-06 (migration 20260906150956, "a pass commits what it
   did"). `fn_cash_clusters_tick_all` was re-declared WHOLE from the live body
   (md5 8dadda13170127ec2b571790d198d79e, 20260906011318's) to add the 5.5 s
   budget, the 2 s lock bound and the oldest-ticked-first order, so THAT file
   is now the live definition of the pass. `fn_cash_cluster_balance` was not
   touched and TICK_ALL above still pins it. Two functions, two handles. */
const TICK_ALL_PASS = read('supabase/migrations/20260906150956_a_pass_commits_what_it_did.sql');
/* `fn_cash_clusters_to_tick` is the OTHER function 20260906011113 re-declared,
   and the balancer did not touch it - so its migration is still the live
   definition of that one, and it keeps its own handle. Two functions changed
   by one migration are two pins, not one. */
const WORKLIST = read(
  'supabase/migrations/20260906011113_the_worklist_reaches_the_game_the_repair_was_written_for.sql'
);
/* PIN MOVED 2026-09-05 (migration 20260906015029). `fn_cash_cluster_tick` was
   re-declared WHOLE by that migration to raise the opening-feeder abandon
   window from 3 minutes to 6, so 20260905050000 is no longer the live
   definition of the abandon block and pinning it would pin a superseded
   function. The feeder-abandon assertions below read the current file; every
   other tick assertion in this describe still reads DEEP_DIVE, where the text
   it pins is unchanged. */
const FEEDER_WINDOW = read(
  'supabase/migrations/20260906015029_an_opening_feeder_is_filled_before_it_is_abandoned.sql'
);
const METRICS = read('server/src/cluster/ClusterMetrics.ts');

describe('the controller is wired on the leader, beside the fleet', () => {
  it('is constructed with the fleet census, the engine door and the engine map', () => {
    expect(GAME_SERVER).toMatch(/private clusterController = new ClusterController\(\{/);
    expect(GAME_SERVER).toMatch(
      /eligibleHorseCount: \(tableId\) => this\.horseFleet\.eligibleHorseCount\(tableId\)/
    );
    // The whole census goes with every pass (one RPC, keyed by Main 1).
    expect(GAME_SERVER).toMatch(/eligibleCounts: \(\) => this\.horseFleet\.eligibleCounts\(\)/);
    expect(FLEET).toMatch(/eligibleCounts\(\): ReadonlyMap<string, number>/);
    expect(GAME_SERVER).toMatch(
      /ensureEngine: \(tableId\) => this\.ensureCashTableEngine\(tableId\)/
    );
    expect(GAME_SERVER).toMatch(/hasEngine: \(tableId\) => this\.tableEngines\.has\(tableId\)/);
  });

  it('starts right after the fleet on the leader path and stops with it', () => {
    const start = GAME_SERVER.indexOf('this.clusterController.start();');
    const fleetStart = GAME_SERVER.indexOf("'GameServer.horse_fleet_start_failed'");
    expect(start).toBeGreaterThan(fleetStart);
    expect(GAME_SERVER).toContain("['HorseFleetManager', () => this.horseFleet.stop()]");
    expect(GAME_SERVER).toContain("['ClusterController', () => this.clusterController.stop()]");
  });

  /* PIN MOVED 2026-09-05, WITH ITS MECHANISM. This read
     `if (frozen()) { summary.skippedFrozen = true;` - the literal shape of
     the local freeze exit. There are TWO freeze exits (ours before any I/O,
     and the SQL's, which sees a break that began between the two checks), and
     only the first one incremented poker_cluster_pass_skipped_frozen_total;
     the second set the summary flag and returned, counting nothing. Both go
     through `frozenSkip` now, which is also what keeps
     theClusterPages.law.test.ts counting exactly one `recordSkippedFrozen`
     call in this file. Same law, one door instead of two. */
  it('honours the freeze before any I/O and again inside the SQL, and counts both', () => {
    expect(CONTROLLER).toMatch(/if \(frozen\(\)\) return this\.frozenSkip\(summary, startedAt\);/);
    expect(CONTROLLER).toMatch(
      /if \(pass\.skipped === 'frozen'\) return this\.frozenSkip\(summary, startedAt\);/
    );
    expect(CONTROLLER).toMatch(
      /private frozenSkip\([^)]*\): ClusterTickSummary \{\s*summary\.skippedFrozen = true;/
    );
    expect(CONTROLLER).toMatch(/clusterMetrics\.recordSkippedFrozen\(\);/);
    expect(SQL).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s*RETURN jsonb_build_object\('ok', false, 'skipped', 'frozen'\)/
    );
  });

  it('ticks every 5 seconds and passes the horse demand for Main 1', () => {
    expect(CONTROLLER).toMatch(/export const CLUSTER_TICK_MS = 5000;/);
    // PIN MOVED 2026-09-05 (one tick RPC per pass): the pass sends the whole
    // census keyed by Main 1 table id; the per-game demand is still passed by
    // the wake, through the per-game RPC.
    expect(CONTROLLER).toMatch(/rpc\('fn_cash_clusters_tick_all', \{ p_eligible: eligible \}\)/);
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
    expect(step).toMatch(/await this\.readCashHandDepartures\(diagnostic\)/);
    expect(step).toMatch(
      /await this\.executePendingSeatMoves\(\{ announcedOnly: true \}, pendingMoves, diagnostic\);/
    );
    expect(step.indexOf('readCashHandDepartures(')).toBeLessThan(
      step.indexOf('executePendingSeatMoves(')
    );
  });

  it('an idle table executes every pending move, in the idle branch and nowhere before the deal', () => {
    const idle = DEALING.slice(
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');"),
      DEALING.indexOf('SPIN REVEAL HOLD')
    );
    expect(idle).toContain('await this.executeIdleSeatMoves();');
    const owner = BASE.slice(
      BASE.indexOf('protected async executeIdleSeatMoves('),
      BASE.indexOf('protected async executePendingSeatMoves(')
    );
    expect(owner).toContain('await this.acquireSeatBoundary()');
    expect(owner).toContain('const raw = this.executePendingSeatMoves()');
    expect(owner).toContain('await Promise.allSettled([raw, budgeted])');
    // The pre-deal sweeps must not execute: a move announced for THIS hand
    // would land before it.
    const preDeal = DEALING.slice(
      DEALING.indexOf("'load_seats',"),
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');")
    );
    expect(preDeal).not.toMatch(/execute(?:Pending|Idle)SeatMoves\(/);
  });

  it('the wait-for-players loop executes them too (a lone feeder player is not stranded)', () => {
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/await this\.executeIdleSeatMoves\(\)\.catch\(/);
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

describe('the fleet keeps the promise that opened a feeder (2026-09-05, 04:30 UTC)', () => {
  /* 36 feeders opened in two hours, 31 abandoned, 2 went live: the fleet ranked
     an opening feeder LAST among cluster tables and gave it a sparse table's
     target (which can be 1), so it never reached the two seats that promote it.
     The controller opened it on this fleet's own count of two buyers. */
  it('an OPENING feeder is seeded before every other table', () => {
    const rank = FLEET.slice(
      FLEET.indexOf('const clusterRank = ('),
      FLEET.indexOf('const orderedTables')
    );
    expect(rank).toMatch(/t\.lifecycle === 'opening'\s*\?\s*-1/);
    expect(rank).toMatch(/t\.role === 'feeder'\s*\?\s*1000/);
    // and the order still asks clusterRank between "cluster first" and "id".
    expect(FLEET).toMatch(
      /Number\(!!b\.cluster_id\) - Number\(!!a\.cluster_id\) \|\|\s*clusterRank\(a\) - clusterRank\(b\) \|\|/
    );
  });

  it('an OPENING feeder is seeded to two in one cycle, whatever the vibe says', () => {
    expect(FLEET).toMatch(
      /const openingFeeder = !!table\.cluster_id && table\.lifecycle === 'opening';/
    );
    // 2026-09-05 (no lone horse): the floor is DEALABLE_MINIMUM (2) and it
    // applies to the opening feeder AND to every cluster table at 0 or 1 -
    // see HorseLoneTable.ts and HorseLoneTable.test.ts.
    expect(FLEET).toMatch(
      /if \(openingFeeder \|\| seedToDealable\) \{\s*seatTarget = Math\.min\(table\.max_players, Math\.max\(seatTarget, DEALABLE_MINIMUM\)\);/
    );
    // The 1-2 trickle for a sparse table cannot leave the feeder at one.
    const trickle = FLEET.slice(
      FLEET.indexOf("if (fill !== 'full' && !humanNeedsRescue) {"),
      FLEET.indexOf('seatsNeeded = Math.min(seatsNeeded, seatBudget);')
    );
    expect(trickle).toMatch(
      /seatsNeeded = seatsToDealable\(\{\s*clusterTable: !!table\.cluster_id,\s*currentCount,\s*seatsNeeded,\s*seatsAllowed,\s*\}\);/
    );
  });

  it('an expired one-buyer hold rests five minutes (20260905041557), and the list knows who asks', () => {
    const REST = read(
      'supabase/migrations/20260905041557_the_must_move_list_knows_who_asks_and_an_expired_opening_hol.sql'
    );
    expect(REST).toMatch(/ADD COLUMN IF NOT EXISTS opening_hold_rested_until timestamptz/);
    expect(REST).toMatch(/opening_hold_rested_until = v_now \+ interval ''5 minutes''/);
    expect(REST).toMatch(
      /g\.opening_hold_rested_until IS NULL OR g\.opening_hold_rested_until <= v_now/
    );
    expect(REST).toMatch(/AND \(auth\.uid\(\) IS NOT NULL OR public\.fn_caller_is_engine\(\)\)/);
  });
});

describe('the fleet keeps its hands off cluster tables', () => {
  it('the fleet no longer spawns, retires or reactivates a table (Gate 7, 2026-09-05)', () => {
    // The name-family machinery (surplus count, #2/#3 overflow spawn, the
    // retirement sweep, the boot-time insert/reactivate) is gone; demand
    // opens a feeder through the controller and thin tables close through
    // its break rule. The only table writer left in the fleet is the
    // cluster opener, reached through fn_cash_game_ensure.
    expect(FLEET).not.toMatch(/private async spawnOverflowTables/);
    expect(FLEET).not.toMatch(/private async retireSurplusTables/);
    expect(FLEET).not.toMatch(/const MAX_TABLES_PER_CONFIG = /);
    expect(FLEET).not.toMatch(/from\('tables'\)\s*\.insert\(/);
    expect(FLEET).toMatch(/supabase\.rpc\('fn_cash_game_ensure'/);
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
       still runs the candidate filter (countOnly) and answers.

       PIN MOVED 2026-09-05 (a buyer is counted once). The answer for a
       cluster table is no longer `pool.length` - the same two free horses
       were counted as buyers for every full Main 1 on the host at once, and
       eleven of twelve feeders opened in an hour were abandoned empty. The
       pool is KEPT per cluster table and `allocateBuyers` hands each horse
       out once, in seeding order, after the loop; a full table asks for the
       open rule's two and no more. Non-cluster tables still report the pool
       size. See HorseBuyerAllocation.test.ts for the allocation itself. */
    expect(FLEET).toMatch(
      /clusterPools\.push\(clusterPool\);\s*\} else \{\s*nextEligible\.set\(table\.id, pool\.length\);\s*\}\s*if \(countOnly\) continue;/
    );
    /* PIN MOVED 2026-09-06 (the feeder reserves the buyers it was opened for).
       The full-table probe is unchanged and still asks for the open rule's
       two; an OPENING feeder now declares a `reserved` claim ahead of it, so
       the ternary has one more branch. The claim is derived from `lifecycle`
       every cycle and stored nowhere, so it dies with the feeder. See
       HorseBuyerAllocation.test.ts for the allocation itself. */
    /* 2026-09-06: a PROBE is a full table, not merely a table the fleet
       stopped seating. `countOnly` is also set when the vibe target is met or
       the trickle produced zero, and calling those a probe booked two horses
       of shared capacity to answer a question the OPEN rule cannot act on
       (it needs v_open_unreserved = 0). The claim follows the SEATS now. */
    expect(FLEET).toMatch(/emptySeats\.length === 0\s*\?\s*FULL_TABLE_BUYER_PROBE/);
    expect(FLEET).toMatch(
      /claim: openingFeeder\s*\?\s*'reserved'\s*:\s*countOnly && emptySeats\.length === 0\s*\?\s*'probe'\s*:\s*'seating',/
    );
    expect(FLEET).toMatch(
      /for \(const \[tableId, n\] of allocateBuyers\(clusterPools, capacityByHorse\)\) \{\s*nextEligible\.set\(tableId, n\);\s*\}\s*this\.lastEligibleByTable = nextEligible;/
    );
    expect(FLEET).not.toMatch(
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
      // 2026-09-06: paged (keyset on id), so a truncated read can no longer
      // UNDERCOUNT reservations and let the fleet fill a reserved seat.
      /\.from\('cash_seat_moves'\)\s*\.select\('id, to_table_id'\)\s*\.eq\('state', 'pending'\)/
    );
    expect(FLEET).toMatch(
      /occupiedNumbers\.size \+ \(pendingMovesByTable\.get\(table\.id\) \?\? 0\)/
    );
  });

  it('inside a game the mains are seeded before a LIVE feeder (an opening one comes first - see above)', () => {
    expect(FLEET).toMatch(
      /t\.lifecycle === 'opening'\s*\?\s*-1\s*:\s*t\.role === 'feeder'\s*\?\s*1000\s*:\s*Number\(t\.main_index \?\? 999\)/
    );
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
    const admission = GAME_SERVER.slice(
      GAME_SERVER.indexOf('private async performCashTableEngineAdmission('),
      GAME_SERVER.indexOf(
        '/**\n   * Get a table engine by ID',
        GAME_SERVER.indexOf('private async performCashTableEngineAdmission(')
      )
    );
    expect(admission).toContain(
      'const lease = await claimTableLease(tableId, requestedLeaseGeneration);'
    );
    expect(admission).toContain('const racedStart = this.tableEngineStartPromises.get(tableId);');
    expect(admission).toContain('const racedEngine = this.tableEngines.get(tableId);');
    expect(admission.indexOf('const racedStart')).toBeGreaterThan(
      admission.indexOf('await claimTableLease(tableId, requestedLeaseGeneration)')
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

  it('ticks every game in ONE call, not one after another and not eight at a time', () => {
    /* PIN MOVED 2026-09-05. This pin used to require the eight-wide pool
       (CLUSTER_TICK_CONCURRENCY = 8, Promise.all(workers)) that kept a 78-game
       pass at ~10 s instead of 66 s. The mechanism it guarded was deliberately
       replaced: the pass is one RPC, fn_cash_clusters_tick_all, and the pool
       is gone because there is nothing left to pool. The behaviour it guarded
       - a pass that finishes inside the cadence however many games there are
       - is what the new shape delivers (~0.7 s server-side for 120 games,
       measured on production before the migration was applied). */
    const pass = CONTROLLER.slice(
      CONTROLLER.indexOf('async tick(): Promise<ClusterTickSummary>'),
      CONTROLLER.indexOf('private async afterGameTick(')
    );
    expect(pass).toMatch(/rpc\('fn_cash_clusters_tick_all'/);
    expect(pass).not.toMatch(/rpc\('fn_cash_cluster_tick'/);
    expect(pass).not.toMatch(/rpc\('fn_cash_clusters_to_tick'/);
    expect(CONTROLLER).not.toMatch(/CLUSTER_TICK_CONCURRENCY/);
    expect(CONTROLLER).not.toMatch(/Promise\.all\(workers\)/);
  });
});

describe('the controller cannot go silent', () => {
  /* Live 2026-09-04 22:10 UTC: `await ensureEngine()` on a Main 1 with one
     player seated waits for the second player (engine.start() returns only
     when the table can deal). The pass never ended, the inTick latch held,
     and every tick after it returned early - eleven minutes with no error
     and no log line, found only from cash_games.last_tick_at. */
  it('the wake never blocks a pass, but shutdown owns and joins its promise', () => {
    expect(CONTROLLER).toMatch(
      /this\.launchLifecycleJob\([\s\S]{0,180}this\.deps\.ensureEngine\(tableId\)\.then/
    );
    expect(CONTROLLER).not.toMatch(/await this\.deps\.ensureEngine\(/);
    expect(CONTROLLER).toMatch(/await Promise\.allSettled\(\[\.\.\.this\.lifecycleJobs\]\)/);
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

  it('an abandoned opening feeder closes after SIX minutes, and OPEN waits two after it', () => {
    /* THE WINDOW MOVED 2026-09-05, and this pin moved with it in the same
       commit. Three minutes is shorter than one worst-case fleet seeding
       cycle (57 to 118 seconds, on a 30-second tick) plus a tick interval, so
       an opening feeder could be closed before the fleet's next cycle ever
       reached it - and the fleet then bought into the closed row and was
       refused TABLE_CLOSING, 15 times in 25 minutes. Measured that night: 22
       feeder_opened, 4 feeder_live, 20 feeder_abandoned in one hour. Six
       minutes is 148s (118 + 30) with a full cycle of margin.
       The 2-minute rest after an abandon is deliberately NOT changed. */
    const tick = FEEDER_WINDOW.slice(
      FEEDER_WINDOW.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick')
    );
    expect(tick).toMatch(/'feeder_abandoned'/);
    expect(tick).toMatch(
      /coalesce\(tb\.opened_at, tb\.created_at\) < v_now - interval '6 minutes'/
    );
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

/**
 * ONE TICK RPC PER PASS, DORMANT GAMES REST, A SEAT CHANGE WAKES ITS GAME
 * (2026-09-05, 20260905091025). 149 games x 12 passes a minute was ~86,000
 * PostgREST round trips an hour, nearly all of them reading rows and changing
 * nothing. The pass is one call; the SQL decides who is due; the engine wakes
 * the game whose seats it just saw change. The law: the controller never makes
 * N RPCs for N games again.
 */
describe('one tick RPC per pass, a rest for dormant games, and a wake on seat change', () => {
  const fn = TICK_ALL_PASS.slice(
    TICK_ALL_PASS.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_clusters_tick_all'),
    TICK_ALL_PASS.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all')
  );

  it('the SQL runs the worklist itself and calls the per-game tick for each due game', () => {
    expect(fn).toMatch(/FROM public\.fn_cash_clusters_to_tick\(\) l/);
    expect(fn).toMatch(/v_res := public\.fn_cash_cluster_tick\(w\.game_id, v_eligible\);/);
    // The eligible map is keyed by Main 1 TABLE id, so the controller sends
    // the fleet census as it is and the pass needs no second call.
    expect(fn).toMatch(
      /coalesce\(\(p_eligible ->> \(l\.main1_table_id::text\)\)::integer, 0\) AS eligible/
    );
    // It wraps the per-game tick; it does not redeclare it.
    expect(TICK_ALL).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_cluster_tick\(/);
  });

  it('one game failing is caught, recorded as a row, and the pass continues', () => {
    expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(fn).toMatch(
      /GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;/
    );
    expect(fn).toMatch(/'controller_tick_error'/);
    expect(fn).toMatch(/jsonb_build_object\('sqlstate', v_sqlstate, 'message', v_message/);
  });

  it('a dormant, empty, unwanted game rests 30 s; anything seated, wanted, live or disabled ticks every pass', () => {
    expect(fn).toMatch(/w\.state = 'live'/);
    expect(fn).toMatch(/OR NOT w\.enabled/);
    expect(fn).toMatch(/OR w\.anyone_seated/);
    expect(fn).toMatch(/OR w\.eligible > 0/);
    expect(fn).toMatch(/OR w\.last_tick_at IS NULL/);
    expect(fn).toMatch(/OR w\.last_tick_at < v_now - interval '30 seconds'/);
    // A seat anywhere in the game, not only at Main 1. Law 10.5: a horse's
    // seat counts exactly like a human's here; the EXISTS reads every seat.
    expect(fn).toMatch(
      /JOIN public\.table_seats ts ON ts\.table_id = t\.id AND ts\.left_at IS NULL\s*WHERE t\.cluster_id = l\.game_id/
    );
    expect(fn).not.toMatch(/is_horse/);
    // The documented constant agrees with the SQL.
    expect(CONTROLLER).toMatch(/export const CLUSTER_DORMANT_REST_S = 30;/);
  });

  it('honours the freeze, is SECURITY DEFINER with a pinned search_path, and only the engine may call it', () => {
    expect(fn).toMatch(
      /IF public\.fn_platform_frozen\(\) THEN\s*RETURN jsonb_build_object\('ok', false, 'skipped', 'frozen'/
    );
    expect(fn).toMatch(/SECURITY DEFINER\s*SET search_path TO 'public', 'pg_temp'/);
    expect(TICK_ALL_PASS).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cash_clusters_tick_all\(jsonb\) FROM PUBLIC, anon, authenticated;/
    );
    expect(TICK_ALL_PASS).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cash_clusters_tick_all\(jsonb\) TO service_role;/
    );
    // One transaction (production DDL policy).
    expect((TICK_ALL_PASS.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((TICK_ALL_PASS.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  /**
   * A PASS COMMITS WHAT IT DID (2026-09-06, 20260906150956). The engine's role
   * has an 8 s statement_timeout; a pass that crossed it was rolled back whole
   * (nine times in three hours, mean 1,187 ms, max 7,993 ms, while the work
   * itself is ~3.3 s for every game). The pass now stops STARTING games at a
   * budget, defers the rest as identity rows, orders the worklist oldest-
   * ticked first so a deferred game is next in line, and bounds one lock
   * wait so a held row costs one game, never the pass.
   */
  it('stops starting games at 5.5 s, defers the rest, and they are first next pass', () => {
    expect(fn).toMatch(/v_budget interval := interval '5500 milliseconds';/);
    expect(fn).toMatch(
      /IF clock_timestamp\(\) - v_now > v_budget THEN\s*v_deferred := v_deferred \+ 1;/
    );
    // Deferred games ride with the rested ones so the controller's map is complete.
    expect(fn).toMatch(/'rested_games', v_rested_games \|\| v_deferred_games/);
    expect(fn).toMatch(/'deferred', v_deferred,/);
    // Oldest-ticked first, never creation order: a budget with creation order
    // would defer the same tail every pass.
    expect(fn).toMatch(/ORDER BY g\.last_tick_at NULLS FIRST, g\.created_at/);
    expect(fn).not.toMatch(/ORDER BY g\.created_at\s*$/m);
    // The budget is checked AFTER the rest test: a resting game is rested, a
    // deferred game was due.
    const rest = fn.indexOf("OR w.last_tick_at < v_now - interval '30 seconds'");
    const budget = fn.indexOf('IF clock_timestamp() - v_now > v_budget THEN');
    const tick = fn.indexOf('v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);');
    expect(rest).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(rest);
    expect(tick).toBeGreaterThan(budget);
  });

  it('bounds one lock wait to 2 s, transaction-locally, inside the per-game sub-block', () => {
    expect(fn).toMatch(/v_lock_wait text := '2000ms';/);
    expect(fn).toMatch(/PERFORM set_config\('lock_timeout', v_lock_wait, true\);/);
    // Set before the loop, so every game's sub-block is under it and a 55P03
    // lands in the EXCEPTION WHEN OTHERS below as a controller_tick_error row.
    expect(fn.indexOf("set_config('lock_timeout'")).toBeLessThan(fn.indexOf('FOR w IN'));
  });

  it('the controller reads deferred, warns on it, and publishes it as a gauge', () => {
    expect(CONTROLLER).toMatch(/summary\.deferred = Number\(pass\.deferred \?\? 0\);/);
    expect(CONTROLLER).toMatch(/due game\(s\) deferred to the next pass/);
    expect(read('server/src/cluster/ClusterMetrics.ts')).toMatch(/'poker_cluster_pass_deferred'/);
  });

  it('no temp table and no bare UPDATE or DELETE in the body (safeupdate)', () => {
    const code = fn.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/CREATE TEMP TABLE/);
    for (const stmt of code.match(/\b(UPDATE|DELETE FROM) public\.\w+[\s\S]*?;/g) ?? []) {
      expect(stmt, stmt.slice(0, 80)).toMatch(/\bWHERE\b/);
    }
  });

  it('the controller never makes N RPCs for N games: one pass, one call, and the summary counts it', () => {
    expect(CONTROLLER).toMatch(/rpcs: number;/);
    const pass = CONTROLLER.slice(
      CONTROLLER.indexOf('async tick(): Promise<ClusterTickSummary>'),
      CONTROLLER.indexOf('private async afterGameTick(')
    );
    expect((pass.match(/await rpc\(/g) ?? []).length).toBe(1);
    expect(pass).toMatch(
      /summary\.rpcs\+\+;\s*const \{ data, error \} = await rpc\('fn_cash_clusters_tick_all'/
    );
    // No loop in the pass body awaits an RPC per result.
    const loop = pass.slice(pass.indexOf('for (const entry of results)'));
    expect(loop).not.toMatch(/await rpc\(/);
  });

  it('the 18.4 dealer wake is unchanged: read from the result, detached from the pass', () => {
    expect(CONTROLLER).toMatch(
      /Number\(result\.seated_total \?\? 0\) > 0 &&\s*!this\.deps\.hasEngine\(g\.main1_table_id\)/
    );
    expect(CONTROLLER).toMatch(
      /const seated = await this\.deps\.seatedCount\(g\.main1_table_id\);/
    );
    expect(CONTROLLER).toMatch(
      /this\.launchLifecycleJob\([\s\S]{0,180}this\.deps\.ensureEngine\(tableId\)\.then/
    );
  });

  it('a wake is debounced per game, leader-only, and cannot throw into the engine', () => {
    expect(CONTROLLER).toMatch(/export const CLUSTER_WAKE_DEBOUNCE_MS = 500;/);
    expect(CONTROLLER).toMatch(
      /wake\(gameId: string\): void \{\s*if \(!this\.running \|\| !gameId\) return;/
    );
    expect(CONTROLLER).toMatch(
      /if \(this\.wakeTimers\.has\(gameId\)\) \{\s*this\.wakesCoalescedCount\+\+;\s*return;/
    );
    expect(CONTROLLER).toMatch(
      /export function wakeCluster\(gameId: string\): void \{\s*try \{\s*activeController\?\.wake\(gameId\);\s*\} catch/
    );
    // The wake ticks ONE game through the per-game RPC with its Main 1 demand.
    const wake = CONTROLLER.slice(
      CONTROLLER.indexOf('private async tickGame(gameId: string)'),
      CONTROLLER.indexOf('private emptySummary()')
    );
    expect(wake).toMatch(
      /rpc\('fn_cash_cluster_tick', \{\s*p_game_id: gameId,\s*p_eligible_horses: eligible,/
    );
    expect(wake).not.toMatch(/fn_cash_clusters_tick_all/);
  });

  /* ── THE WORKLIST REACHES THE GAME THE REPAIR WAS WRITTEN FOR ───────────
     20260906011113. Three findings, all in these two functions. The first is
     a repair that could not reach the state it existed to repair; the other
     two are a gauge nothing set and a rested game nothing could wake. */

  it('a DISABLED game is on the worklist on lifecycle alone, so lifecycle_followed_status can reach it', () => {
    const worklist = WORKLIST.slice(
      WORKLIST.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick'),
      WORKLIST.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_clusters_to_tick')
    );
    expect(worklist).toMatch(/AND \(g\.enabled OR EXISTS \(SELECT 1 FROM public\.tables t/);
    expect(worklist).toMatch(/AND t\.lifecycle <> 'closed'/);
    // The status test is what stranded 14 games at lifecycle='live',
    // status='closed' - never ticked once since the controller was built. The
    // comments still NAME it, so the code is read with them stripped.
    const code = worklist.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/status IN \('waiting'/);
    // And the migration proves it on the live rows before it commits.
    expect(WORKLIST).toMatch(
      /disabled game\(s\) with a live\/closed table are still off the worklist/
    );
  });

  it("the pass returns every game's state and a roster of the games it rested", () => {
    expect(fn).toMatch(/'state', w\.state/);
    expect(fn).toMatch(/v_rested_games := v_rested_games \|\| jsonb_build_object\(/);
    expect(fn).toMatch(/'rested_games', v_rested_games/);
    // The rested entry is IDENTITY ONLY: no 'result' key on it.
    const restedEntry = fn.slice(
      fn.indexOf('v_rested_games := v_rested_games ||'),
      fn.indexOf('CONTINUE;')
    );
    expect(restedEntry).not.toMatch(/'result'/);
  });

  it('the controller folds the rested roster into the row map, so a wake on a dormant game finds Main 1', () => {
    expect(CONTROLLER).toMatch(/rested_games: ClusterTickAllRestedEntry\[\];/);
    expect(CONTROLLER).toMatch(
      /const restedRows = Array\.isArray\(pass\.rested_games\) \? pass\.rested_games : \[\];/
    );
    const pass = CONTROLLER.slice(
      CONTROLLER.indexOf('async tick(): Promise<ClusterTickSummary>'),
      CONTROLLER.indexOf('private async afterGameTick(')
    );
    const restedLoop = pass.slice(pass.indexOf('for (const entry of restedRows)'));
    // Identity only: it teaches rowByGame and the gauge, and nothing else.
    expect(restedLoop).toMatch(/this\.rowByGame\.set\(row\.game_id, \{/);
    expect(restedLoop).not.toMatch(/afterGameTick/);
    expect(restedLoop).not.toMatch(/summary\.ticked\+\+/);
    // summary.rested is the SQL's own count, so a rested game is counted once.
    expect(pass).toMatch(/summary\.rested = Number\(pass\.rested \?\? 0\);/);
    expect(restedLoop).not.toMatch(/summary\.rested/);
  });

  it('poker_cluster_games{state} is set from the pass, not left as a series nothing writes', () => {
    expect(METRICS).toMatch(
      /recordPass\(summary: ClusterTickSummary, rows\?: ClusterRow\[\]\): void/
    );
    expect(CONTROLLER).toMatch(/clusterMetrics\.recordPass\(summary, seen\);/);
    expect(CONTROLLER).toMatch(/const seen: ClusterRow\[\] = \[\];/);
    expect(CONTROLLER).toMatch(
      /state: typeof entry\.state === 'string' \? entry\.state : undefined,/
    );
  });

  it('the engine wakes the game when a seat changes or a hand ends on a cluster table', () => {
    expect(BASE).toMatch(/import \{ wakeCluster \} from '\.\.\/cluster\/ClusterController\.js';/);
    expect(BASE).toMatch(
      /protected wakeClusterGame\(_reason: string\): void \{\s*const gameId = this\.tableInfo\?\.cluster_id;\s*if \(!gameId \|\| this\.isTournamentTable\(\)\) return;/
    );
    // adoptSeatRoster has already retired departed/replaced occupancy mirrors.
    // Compare the retained pre-read roster so that pruning knownPlayerIds
    // cannot hide a departure. An unchanged roster starts false; arrivals
    // and remaining known-player departures are the only later true writes.
    // CashSeatReentry exercises unknown proof -> confirmed diff -> unchanged
    // observation through the actual loop and requires exactly one wake.
    expect(DEALING).toMatch(
      /let rosterChanged = \[\.\.\.previousOccupancies\.keys\(\)\]\.some\(\s*\(id\) => !this\.seatedPlayers\.some\(\(p\) => p\.user_id === id\)\s*\);/
    );
    expect(DEALING).toMatch(
      /if \(!this\.knownPlayerIds\.has\(p\.user_id\)\) \{\s*rosterChanged = true;/
    );
    expect(DEALING).toMatch(/if \(!currentIds\.has\(id\)\) \{\s*rosterChanged = true;/);
    expect(DEALING.match(/\brosterChanged = true;/g)).toHaveLength(2);
    expect(DEALING).toMatch(/if \(rosterChanged\) this\.wakeClusterGame\('seat_change'\);/);
    expect(DEALING.match(/this\.wakeClusterGame\('seat_change'\);/g)).toHaveLength(1);
    // The end of every hand, after the recount.
    expect(SETTLEMENT).toMatch(/this\.wakeClusterGame\('hand_complete'\);/);
    // A move that landed.
    expect(BASE).toMatch(/this\.wakeClusterGame\('seat_move'\);/);
    // A leave that cashed out between hands (both doors).
    expect((SEATING.match(/this\.wakeClusterGame\('seat_left'\);/g) ?? []).length).toBe(2);
  });
});

/**
 * THE FEEDER TABLES STAY WITHIN ONE PLAYER OF EACH OTHER (Dan 2026-09-05,
 * 20260906011318). Measured on NLH 0.05/0.10 Classic: 39 players over 5 tables
 * seated 9/9/9/9/3, because nothing had ever moved a player SIDEWAYS - only up
 * to the main game, and only out of a breaking table. Dan asked for the card
 * room's own rule and it has three parts: the main game is fed and never
 * balanced, the must-move tables are kept within ONE player of each other, and
 * a predetermined order - not anyone's judgement - picks the table and the
 * player.
 */
describe('the must-move tables balance themselves, and Main 1 is fed', () => {
  const bal = TICK_ALL.slice(
    TICK_ALL.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_balance'),
    TICK_ALL.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_cluster_balance')
  );

  it('balances the pool of must-move tables and never the main game', () => {
    // Main 1 is held full on purpose - that is what a must-move game IS.
    expect(bal).toMatch(/AND NOT \(c\.role = 'main' AND c\.main_index = 1\)/);
    // A breaking table is emptying already and an opening one has not started.
    expect(bal).toMatch(/WHERE c\.lifecycle = 'live'\s*AND NOT c\.breaking/);
  });

  it('within one player is balanced; two is a move', () => {
    expect(bal).toMatch(/hi\.n - lo\.n >= 2/);
    /* AND NEVER TWO TABLES THAT CANNOT DEAL. A Main 2 with two players beside
       a live table with none is a gap of two, and moving one leaves 1 and 1 -
       two tables that cannot deal a hand, made out of one that could. A room
       breaks a thin game rather than balancing it, and step 5 already does.
       The source keeps 2, the destination reaches 2, or nothing moves. */
    expect(bal).toMatch(/AND hi\.n >= 3\s*AND lo\.n >= 1/);
    // Projected headcount, not the live one: the must-move step runs first in
    // the same pass and its planned arrivals must already count.
    expect(bal).toMatch(/WHERE m\.from_table_id = c\.id AND m\.state = 'pending'/);
    expect(bal).toMatch(/WHERE m\.to_table_id = c\.id AND m\.state = 'pending'/);
  });

  it('a predetermined order picks the table, both ends of the chain', () => {
    // The fullest gives up; ties to the newest table (a feeder has a null
    // main_index, so NULLS FIRST on DESC puts the feeder end first).
    expect(bal).toMatch(/ORDER BY n DESC, main_index DESC NULLS FIRST, created_at DESC LIMIT 1/);
    // The shortest with a chair actually free receives; ties toward Main.
    expect(bal).toMatch(/WHERE room > 0\s*ORDER BY n ASC, main_index ASC NULLS LAST/);
  });

  it('the last to arrive is the one asked to move, and never a busted or leaving seat', () => {
    expect(bal).toMatch(/FROM public\.cash_game_roster r[\s\S]*?\) DESC,\s*ts\.joined_at DESC/);
    expect(bal).toMatch(/AND coalesce\(ts\.stack, 0\) > 0/);
    expect(bal).toMatch(/AND coalesce\(ts\.leave_pending, false\) = false/);
    // One pending move per player, and a refusal gets a minute.
    expect(bal).toMatch(/WHERE m\.player_id = ts\.user_id AND m\.state = 'pending'/);
    expect(bal).toMatch(
      /m\.state = 'cancelled'\s*AND m\.created_at > p_now - interval '60 seconds'/
    );
  });

  it('LAW 10.5: a horse is balanced exactly like a human', () => {
    expect(bal).not.toMatch(/is_horse/);
  });

  it('one move per game per pass, planned AFTER the tick, inside the same sub-block', () => {
    const fn = TICK_ALL_PASS.slice(
      TICK_ALL_PASS.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_clusters_tick_all'),
      TICK_ALL_PASS.indexOf('REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all')
    );
    expect(fn).toMatch(
      /v_res := public\.fn_cash_cluster_tick\(w\.game_id, v_eligible\);[\s\S]*?v_bal := public\.fn_cash_cluster_balance\(w\.game_id, v_now\);/
    );
    // The planner itself takes at most one player per call.
    expect(bal).toMatch(/LIMIT 1\s*\),\s*ins AS \(/);
  });

  it("'balance' is a reason the row may carry and the notices name it", () => {
    expect(TICK_ALL).toMatch(
      /CHECK \(reason = ANY \(ARRAY\['must_move'::text, 'break'::text, 'seat_change'::text, 'balance'::text\]\)\)/
    );
    expect(MOVES).toMatch(
      /export type SeatMoveReason = 'must_move' \| 'break' \| 'seat_change' \| 'balance';/
    );
    // Same sentence on the felt and in the lobby, title case, no em dash.
    expect(MOVES).toMatch(/Balancing The Tables\. Moving To \$\{where\} After This Hand\./);
    expect(read('src/services/cashGameLobby.ts')).toMatch(
      /Balancing The Tables\. Moving To \$\{where\} After This Hand\./
    );
  });

  it('is SECURITY DEFINER with a pinned search_path, and only the engine may call it', () => {
    expect(bal).toMatch(/SECURITY DEFINER\s*SET search_path TO 'public', 'pg_temp'/);
    expect(TICK_ALL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cash_cluster_balance\(uuid, timestamptz\) FROM PUBLIC, anon, authenticated;/
    );
    expect(TICK_ALL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_balance\(uuid, timestamptz\) TO service_role;/
    );
  });
});
