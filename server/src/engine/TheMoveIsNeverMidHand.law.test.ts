/**
 * LAW: A MOVE HAPPENS AT A HAND BOUNDARY, IS SAID OUT LOUD, AND LEAVES
 * NOTHING BEHIND (2026-09-09, must-move audit lane D)
 *
 * Five defects, each one a pin here. Every one of them was reachable on a
 * table that was RUNNING NORMALLY, and none of them had a test.
 *
 *   D1 a failed read of the pending list released every swap hold, and a
 *      released hold is a player the OTHER table's transaction can move
 *      mid-hand (the swap is landed by the partner's boundary, not this
 *      table's). CLAUDE.md 10.86 rule 2: never coerce an unreadable answer
 *      into an empty one.
 *   D2 the hold was released only in announcePendingSeatMoves, which runs
 *      immediately before dealHand - so a two-handed table with one held
 *      player fell below the deal minimum, never announced again, and never
 *      released a hold whose move had died. The table never dealt again.
 *   D3 a refused move told the player nothing: they had been promised
 *      "Moving After This Hand" and simply were not moved.
 *   D4 an entry hold written on a chair that arrived while the table was
 *      WAITING was never read and never cleared, so the next :55 restart
 *      re-held a player who had been dealt in for an hour - and, agreed,
 *      billed them a second big blind to re-enter a table they never left.
 *   D5 a player who left through a path this engine never ran (a swap landed
 *      by the other table, the tab-close beacon, the controller cashing out a
 *      second chair) kept a presence entry, a time bank, a straddle and a
 *      pre-action on a chair nobody sat in - written into every snapshot and
 *      into the :55 park.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as moves from '../services/supabase/seatMoves.js';
import {
  SEAT_MOVE_NON_TERMINAL_REASONS,
  seatMoveCancelledNotice,
} from '../services/supabase/seatMoves.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const TABLE = 'aaaaaaaa-1111-4111-8111-111111111111';

/**
 * A table holding one swap side and remembering one announcement. Prototype
 * only, like CashDepartureReadOverlap's harness: standing a real engine up is
 * not needed to prove what happens to two Sets.
 */
function tableHoldingASwapSide() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = TABLE;
  engine.tableInfo = { club_id: 'club', cluster_id: 'game' };
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.isTournamentTable = vi.fn(() => false);
  engine.heldForSwap = new Set<string>(['held-player']);
  engine.announcedSeatMoves = new Set<string>(['announced-move']);
  engine.depositPresenceForMove = vi.fn();
  engine.seatedPlayers = [];
  engine.hub = { emitEvent: vi.fn() };
  return engine;
}

afterEach(() => vi.restoreAllMocks());

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const BASE = read('./ServerTableEngineBase.ts');
const DEALING = read('./ServerTableEngineDealing.ts');
const SETTLEMENT = read('./ServerTableEngineSettlement.ts');
const MOVES = read('../services/supabase/seatMoves.ts');
const HUB = read('../transport/TableStateHub.ts');
const TABLE_PAGE = readFileSync(resolve(__dirname, '../../../src/pages/TablePage.tsx'), 'utf8');

describe("D1 - a read that FAILED changes nothing (the invariant, through main's throw)", () => {
  /* THE MECHANISM CHANGED AT THE 2026-09-10 MERGE, THE LAW DID NOT.
     This lane shipped `pendingSeatMoves` returning `null` on a failed read.
     Main solved the same defect the other way, and harder: it THROWS (#3974,
     the occupancy-receipt work), so a caller cannot ignore an unreadable
     answer by accident because there is no value to ignore. Main's contract
     is kept and this pin was moved onto it (CLAUDE.md 10.6), which makes it
     stronger than it was: it no longer asserts a return type, it asserts the
     thing that actually matters - NOTHING IS PRUNED AND NO HOLD IS RELEASED
     when the read did not work. A released hold is a player the partner's
     table can move out of a live hand. */

  it('a throwing read leaves every hold intact, prunes nothing and tells nobody', async () => {
    const engine = tableHoldingASwapSide();
    vi.spyOn(moves, 'pendingSeatMoves').mockRejectedValue(new Error('read failed'));
    await expect(engine.announcePendingSeatMoves()).resolves.toBe(false);
    expect([...engine.heldForSwap]).toEqual(['held-player']);
    expect([...engine.announcedSeatMoves]).toEqual(['announced-move']);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });

  it('THE CONTROL: on a read that WORKED the same call does release the hold', async () => {
    /* Without this the test above would pass on a method that simply never
       prunes anything, which is not the law - it is a different bug. */
    const engine = tableHoldingASwapSide();
    vi.spyOn(moves, 'pendingSeatMoves').mockResolvedValue([]);
    await engine.announcePendingSeatMoves();
    expect([...engine.heldForSwap]).toEqual([]);
    expect([...engine.announcedSeatMoves]).toEqual([]);
  });

  it('the executor takes the same branch: nothing executed, nothing released', async () => {
    const engine = tableHoldingASwapSide();
    const read = vi.spyOn(moves, 'pendingSeatMoves').mockRejectedValue(new Error('read failed'));
    const exec = vi.spyOn(moves, 'executePendingSeatMoves');
    await expect(engine.executePendingSeatMoves()).resolves.toEqual([]);
    expect(read).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect([...engine.heldForSwap]).toEqual(['held-player']);
  });

  it('a tournament table never asks at all', async () => {
    const engine = tableHoldingASwapSide();
    engine.isTournamentTable = vi.fn(() => true);
    const read = vi.spyOn(moves, 'pendingSeatMoves');
    await engine.announcePendingSeatMoves();
    await engine.executePendingSeatMoves();
    expect(read).not.toHaveBeenCalled();
  });

  it("the service keeps MAIN's contract: an unreadable enumeration throws", () => {
    const fn = MOVES.slice(
      MOVES.indexOf('export async function pendingSeatMoves'),
      MOVES.indexOf('export async function announceSeatMoves')
    );
    expect(fn).toMatch(/Promise<PendingSeatMove\[\]>/);
    expect(fn).toMatch(/throw new Error\(error\.message \|\| 'Seat move enumeration failed'\)/);
    expect(fn).toMatch(/if \(!Array\.isArray\(data\)\) throw new Error/);
    // and it is translated to "change nothing" in exactly ONE place
    expect((BASE.match(/private async readPendingSeatMoves\(\)/g) ?? []).length).toBe(1);
    expect((BASE.match(/await this\.readPendingSeatMoves\(\)/g) ?? []).length).toBe(2);
    expect(BASE).not.toMatch(/await pendingSeatMoves\(this\.tableId\)(?![\s\S]{0,40}catch)/);
  });

  it('settlement is NOT double-wrapped: main already owns that rejection', () => {
    /* readCashHandDepartures runs the read inside Promise.allSettled and
       rethrows it, and runStep('leave_pending', moneyCritical=true) catches,
       reports and raises a financial alert while settlement continues. The
       throw therefore lands BEFORE anything is pruned or executed, which is
       this law's branch reached by main's own structure. Adding a catch here
       would only hide the alert. */
    const fn = SETTLEMENT.slice(SETTLEMENT.indexOf('protected async readCashHandDepartures'));
    expect(fn).toMatch(
      /if \(moves\.status === 'rejected'\) \{\s*diagnostic\?\.selectFailure\('move_read'\);\s*throw moves\.reason;/
    );
    expect(fn).not.toMatch(/catch/);
    expect(SETTLEMENT).toMatch(/runStep\('leave_pending', true,/);
  });
});

describe('D2 - a hold is released wherever the table is, not only before a deal', () => {
  it('the release lives in a helper both loops reach, not inside the announce', () => {
    expect(BASE).toMatch(
      /protected reconcileSeatMoveHolds\(pending: readonly PendingSeatMove\[\]\): void \{/
    );
    // The mechanism itself is unchanged, it has only moved house.
    expect(BASE).toMatch(
      /for \(const uid of this\.heldForSwap\) \{\s*if \(!liveHeld\.has\(uid\)\) this\.heldForSwap\.delete\(uid\)/
    );
    // Called from BOTH the announce and every execute.
    expect((BASE.match(/this\.reconcileSeatMoveHolds\(pending\)/g) ?? []).length).toBe(2);
  });

  it('the idle branch and the wait loop both reach an execute, so both reach the release', () => {
    /* PIN MOVED 2026-09-10 (CLAUDE.md 10.6): main wrapped both call sites in
       `executeIdleSeatMoves`, which takes the seat boundary and budgets the
       step before calling `executePendingSeatMoves`. Same two loops, same
       release, one lock better - so the pin follows the mechanism rather than
       being weakened to match. */
    const idle = DEALING.slice(
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');"),
      DEALING.indexOf('SPIN REVEAL HOLD')
    );
    expect(idle).toMatch(/await this\.executeIdleSeatMoves\(\)/);
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/await this\.executeIdleSeatMoves\(\)\.catch\(/);
    // and the wrapper really does reach the executor that does the release
    const wrapper = BASE.slice(
      BASE.indexOf('protected async executeIdleSeatMoves'),
      BASE.indexOf('protected async executePendingSeatMoves')
    );
    expect(wrapper).toMatch(/this\.executePendingSeatMoves\(\)/);
    expect(wrapper).toMatch(/acquireSeatBoundary\(\)/);
  });

  it('a held player is still out of the deal while the hold stands', () => {
    expect(DEALING).toMatch(
      /!this\.waitingForBB\.has\(p\.user_id\) &&[\s\S]*?!this\.isHeldForSwap\(p\.user_id\)/
    );
  });
});

describe('D3 - a move that did not happen is said out loud', () => {
  it('the freeze, a retry and a partner still coming are NOT refusals', () => {
    for (const r of ['transient', 'frozen', 'platform_frozen', 'waiting_partner', 'done']) {
      expect(SEAT_MOVE_NON_TERMINAL_REASONS.has(r), r).toBe(true);
    }
    // The two the platform itself returns during the :55 park (lane A: the
    // tick and the executor observe DIFFERENT freezes) must never reach a
    // player as "your move was cancelled".
    expect(SEAT_MOVE_NON_TERMINAL_REASONS.has('platform_frozen')).toBe(true);
    expect(SEAT_MOVE_NON_TERMINAL_REASONS.has('frozen')).toBe(true);
  });

  it('a terminal refusal IS one', () => {
    for (const r of [
      'destination_full',
      'destination_unavailable',
      'player_not_seated',
      'busted',
      'swap_partner_gone',
      'original_occupancy_gone',
    ]) {
      expect(SEAT_MOVE_NON_TERMINAL_REASONS.has(r), r).toBe(false);
    }
  });

  it('the service collects them and the engine tells the one player', () => {
    expect(MOVES).toMatch(
      /refused: Array<\{ move_id: string; player_id: string; reason: string \}>/
    );
    /* MERGED 2026-09-10: main proves the outcome is a real refusal carrying a
       real reason BEFORE this lane classifies it. The order is the pin - a
       reason nobody could read must never be classified as anything. */
    const arm = MOVES.slice(
      MOVES.indexOf('} else {', MOVES.indexOf('Seat swap hold does not prove'))
    );
    expect(arm.indexOf("throw new Error('Seat move outcome was not confirmed')")).toBeGreaterThan(
      -1
    );
    expect(arm.indexOf("throw new Error('Seat move outcome was not confirmed')")).toBeLessThan(
      arm.indexOf('SEAT_MOVE_NON_TERMINAL_REASONS.has(res.reason)')
    );
    expect(arm).toMatch(
      /if \(!SEAT_MOVE_NON_TERMINAL_REASONS\.has\(res\.reason\)\) \{\s*refused\.push/
    );
    const engine = BASE.slice(
      BASE.indexOf('protected async executePendingSeatMoves'),
      BASE.indexOf('protected depositPresenceForMove')
    );
    expect(engine).toMatch(/for \(const r of refused\) \{/);
    expect(engine).toMatch(/type: 'seat_move_cancelled'/);
    expect(engine).toMatch(/message: seatMoveCancelledNotice\(r\.reason\)/);
    // A refused move is no longer announced and no longer holds anybody.
    expect(engine).toMatch(/this\.announcedSeatMoves\.delete\(r\.move_id\)/);
    expect(engine).toMatch(/this\.heldForSwap\.delete\(r\.player_id\)/);
  });

  it('the sentence is Title Case, has no em dash and asks nothing', () => {
    for (const reason of [
      'destination_full',
      'destination_unavailable',
      'swap_partner_gone',
      'swap_cancelled',
      'anything_else',
    ]) {
      const s = seatMoveCancelledNotice(reason);
      expect(s).not.toMatch(/[?\u2014]/); // U+2014 by escape: rule 7 bans the character itself
      expect(s.length).toBeGreaterThan(10);
      for (const word of s.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)) {
        expect(word[0], `${s} :: ${word}`).toBe(word[0].toUpperCase());
      }
    }
    expect(seatMoveCancelledNotice('destination_full')).toContain('You Keep Your Chair');
  });

  it('the event has a reader: the client shows it to the hero (10.86 rule 3)', () => {
    expect(TABLE_PAGE).toMatch(/case 'SEAT_MOVE_CANCELLED': \{/);
    const arm = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("case 'SEAT_MOVE_CANCELLED': {"),
      TABLE_PAGE.indexOf("case 'SEAT_MOVE_CANCELLED': {") + 400
    );
    expect(arm).toMatch(/if \(d\?\.user_id !== userId \|\| !d\?\.message\) break;/);
    expect(arm).toMatch(/toast\.info\(d\.message\)/);
  });
});

describe('D4 - an entry hold never outlives the deal that made it meaningless', () => {
  it('the first dealing iteration clears a row marker the once-per-process restore missed', () => {
    const first = DEALING.slice(
      DEALING.indexOf('if (this.dealingLoopFirstIteration) {'),
      DEALING.indexOf('this.dealingLoopFirstIteration = false;')
    );
    expect(first).toMatch(
      /const rowHold = \(p as \{ entry_hold\?: string \| null \}\)\.entry_hold \?\? null;/
    );
    expect(first).toMatch(
      /if \(rowHold !== null && !this\.postingBBToEnter\.has\(p\.user_id\)\) \{\s*this\.persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\);\s*continue;/
    );
    // `continue` matters as much as the clear: a chair that has never been
    // dealt a hand here must not be seeded as a veteran.
    expect(first.indexOf('const rowHold')).toBeLessThan(
      first.indexOf('this.dealtInUserIds.add(p.user_id)')
    );
  });

  it('the restore is still once per process, which is WHY the clear is needed', () => {
    const restore = BASE.slice(
      BASE.indexOf('protected restoreEntryHoldsFromSeats'),
      BASE.indexOf('protected restoreEntryHoldsFromSeats') + 400
    );
    expect(restore).toMatch(
      /if \(this\.entryHoldsRestored\) return;\s*this\.entryHoldsRestored = true;/
    );
    // and the wait loop is what spends it first on a feeder
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/this\.restoreEntryHoldsFromSeats\(\);/);
  });

  it('the two arrival states are still exactly as Dan set them', () => {
    // moved by the game: nothing owed. seat change: posts the BB.
    expect(DEALING).toMatch(
      /entryHold === 'moved'[\s\S]{0,900}?this\.persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\)/
    );
    expect(DEALING).toMatch(
      /entryHold === 'waiting' && entryAgreed[\s\S]{0,600}?this\.postBBWhenClear\.add\(p\.user_id\)/
    );
  });
});

describe('D5 - a player who left leaves nothing of themselves behind', () => {
  it('the gone-player prune runs the same teardown every other leave path runs', () => {
    const prune = DEALING.slice(
      DEALING.indexOf('for (const id of this.knownPlayerIds) {'),
      DEALING.indexOf("if (rosterChanged) this.wakeClusterGame('seat_change');")
    );
    expect(prune).toMatch(/if \(!this\.isTournamentTable\(\)\) \{/);
    for (const call of [
      'this.disconnectEngine.unregisterPlayer(this.tableId, id);',
      // 2026-09-25: the bank and its metadata leave together (forgetTimeBank).
      'this.forgetTimeBank(id);',
      'this.straddleEngine.removePlayer(this.tableId, id);',
      'this.preActionEngine.removePlayer(this.tableId, id);',
    ]) {
      expect(prune, call).toContain(call);
    }
  });

  it('and the move path still deposits presence BEFORE it forgets the player', () => {
    const at = BASE.indexOf('this.depositPresenceForMove(m.player_id, m.to_table_id,');
    const forget = BASE.indexOf(
      'this.disconnectEngine.unregisterPlayer(this.tableId, m.player_id);'
    );
    expect(at).toBeGreaterThan(0);
    expect(forget).toBeGreaterThan(at);
  });
});

describe('D6 - the packet that moves a tab survives a dropped socket', () => {
  it('both seat_moved emissions ask the hub to retain them', () => {
    const fn = BASE.slice(
      BASE.indexOf('protected async executePendingSeatMoves'),
      BASE.indexOf('protected depositPresenceForMove')
    );
    const emissions = fn.match(/type: 'seat_moved'/g) ?? [];
    expect(emissions.length).toBe(2); // the mover's table, and the swap partner's
    expect((fn.match(/replay_until: Date\.now\(\) \+ 60_000/g) ?? []).length).toBe(2);
  });

  it('the per-table cap can hold a breaking table AND a jackpot hand', () => {
    const cap = Number(/HUB_MAX_RETAINED_EVENTS_PER_TABLE = (\d+)/.exec(HUB)?.[1] ?? '0');
    // 5 jackpot beats + one seat_moved per seat of a 9-max broken at one
    // boundary. Under this the splice drops the oldest, which is bbj_hit.
    expect(cap).toBeGreaterThanOrEqual(5 + 9);
  });
});

describe('D7 - only the pass holding the latch may release it', () => {
  it('a released stalled pass cannot unlatch the pass that replaced it', () => {
    const CONTROLLER = read('../cluster/ClusterController.ts');
    expect(CONTROLLER).toMatch(/private tickSerial = 0;/);
    expect(CONTROLLER).toMatch(/const mySerial = \+\+this\.tickSerial;/);
    expect(CONTROLLER).toMatch(/if \(this\.tickSerial === mySerial\) this\.inTick = false;/);
    expect(CONTROLLER).not.toMatch(/\}\s*finally\s*\{\s*this\.inTick = false;/);
  });
});

describe('D8 - a check that cannot read says so', () => {
  it('the closed-cluster-table read reports its error instead of swallowing it', () => {
    const fn = BASE.slice(
      BASE.indexOf('protected async stopIfClusterTableClosed'),
      BASE.indexOf('protected isContinuityActive')
    );
    expect(fn).not.toMatch(/if \(error \|\| !data\) return;/);
    expect(fn).toMatch(
      /reportError\(error, 'ServerTableEngine\.' \+ this\.tableId \+ '\.cluster_closed_read_failed'\)/
    );
  });
});

describe('D9 - the waiting table wakes its game too', () => {
  it('the wait loop wakes the cluster on a roster change, and never on its first read', () => {
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(
      /const idsBeforeSweep = new Set\(this\.seatedPlayers\.map\(\(p\) => p\.user_id\)\);/
    );
    expect(wait).toMatch(/!firstWaitSweep &&/);
    expect(wait).toMatch(/this\.wakeClusterGame\('seat_change'\);/);
    expect(wait).toMatch(/firstWaitSweep = false;/);
  });
});

describe('horses are players (CLAUDE.md 10.5)', () => {
  it('nothing in the move path branches on is_horse', () => {
    const MOVES_SRC = MOVES;
    const CONTROLLER = read('../cluster/ClusterController.ts');
    const PRESENCE = read('./SeatMovePresence.ts');
    for (const [name, src] of Object.entries({ MOVES_SRC, CONTROLLER, PRESENCE })) {
      expect(src, name).not.toMatch(/is_horse|isHorse/);
    }
    // and the engine's move/announce/hold block does not either
    const block = BASE.slice(
      BASE.indexOf('protected reconcileSeatMoveHolds'),
      BASE.indexOf('protected depositPresenceForMove')
    );
    expect(block).not.toMatch(/is_horse|isHorse/);
  });
});
