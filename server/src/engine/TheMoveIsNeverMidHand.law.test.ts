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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SEAT_MOVE_NON_TERMINAL_REASONS,
  seatMoveCancelledNotice,
} from '../services/supabase/seatMoves.js';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const BASE = read('./ServerTableEngineBase.ts');
const DEALING = read('./ServerTableEngineDealing.ts');
const SETTLEMENT = read('./ServerTableEngineSettlement.ts');
const MOVES = read('../services/supabase/seatMoves.ts');
const HUB = read('../transport/TableStateHub.ts');
const TABLE_PAGE = readFileSync(
  resolve(__dirname, '../../../src/pages/TablePage.tsx'),
  'utf8'
);

describe('D1 - a read that failed is not an empty list', () => {
  it('pendingSeatMoves returns null on error, never []', () => {
    const fn = MOVES.slice(
      MOVES.indexOf('export async function pendingSeatMoves'),
      MOVES.indexOf('export async function announceSeatMoves')
    );
    expect(fn).toMatch(/Promise<PendingSeatMove\[\] \| null>/);
    // The error branch returns null; the success branch is the only [] here.
    expect(fn).toMatch(/reportError\(error, 'seatMoves\.pending_failed'[\s\S]{0,80}?return null;/);
    expect(fn).not.toMatch(/pending_failed[\s\S]{0,80}?return \[\];/);
  });

  it('the announce changes NOTHING on a null: no prune, no announcement', () => {
    const fn = BASE.slice(
      BASE.indexOf('protected async announcePendingSeatMoves'),
      BASE.indexOf('protected isHeldForSwap')
    );
    const read = fn.indexOf('await pendingSeatMoves(this.tableId)');
    const guard = fn.indexOf('if (pending === null) return;');
    const prune = fn.indexOf('this.reconcileSeatMoveHolds(pending)');
    expect(read).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(read);
    expect(prune).toBeGreaterThan(guard);
    // and the announcement itself is after the guard too
    expect(fn.indexOf('await announceSeatMoves(fresh)')).toBeGreaterThan(guard);
  });

  it('the executor executes nothing on a null, at either layer', () => {
    const engine = BASE.slice(
      BASE.indexOf('protected async executePendingSeatMoves'),
      BASE.indexOf('protected depositPresenceForMove')
    );
    expect(engine).toMatch(/if \(pending === null\) return \[\];/);
    expect(engine.indexOf('if (pending === null) return [];')).toBeLessThan(
      engine.indexOf('this.reconcileSeatMoveHolds(pending)')
    );
    const service = MOVES.slice(MOVES.indexOf('export async function executePendingSeatMoves'));
    expect(service).toMatch(
      /if \(pending === null\) return \{ done: \[\], held: \[\], refused: \[\] \};/
    );
  });

  it('settlement carries the null through rather than flattening it to []', () => {
    const fn = SETTLEMENT.slice(SETTLEMENT.indexOf('protected async readCashHandDepartures'));
    expect(fn).toMatch(/pendingMoves: PendingSeatMove\[\] \| null;/);
    expect(fn).toMatch(/return \{ cashedOutIds: \[\], pendingMoves: null \};/);
  });
});

describe('D2 - a hold is released wherever the table is, not only before a deal', () => {
  it('the release lives in a helper both loops reach, not inside the announce', () => {
    expect(BASE).toMatch(/protected reconcileSeatMoveHolds\(pending: readonly PendingSeatMove\[\]\): void \{/);
    // The mechanism itself is unchanged, it has only moved house.
    expect(BASE).toMatch(
      /for \(const uid of this\.heldForSwap\) \{\s*if \(!liveHeld\.has\(uid\)\) this\.heldForSwap\.delete\(uid\)/
    );
    // Called from BOTH the announce and every execute.
    expect((BASE.match(/this\.reconcileSeatMoveHolds\(pending\)/g) ?? []).length).toBe(2);
  });

  it('the idle branch and the wait loop both reach an execute, so both reach the release', () => {
    const idle = DEALING.slice(
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');"),
      DEALING.indexOf('SPIN REVEAL HOLD')
    );
    expect(idle).toMatch(/this\.executePendingSeatMoves\(\)/);
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/await this\.executePendingSeatMoves\(\)\.catch\(/);
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
    expect(MOVES).toMatch(/refused: Array<\{ move_id: string; player_id: string; reason: string \}>/);
    expect(MOVES).toMatch(
      /if \(!SEAT_MOVE_NON_TERMINAL_REASONS\.has\(reason\)\) \{\s*refused\.push/
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
    expect(first).toMatch(/const rowHold = \(p as \{ entry_hold\?: string \| null \}\)\.entry_hold \?\? null;/);
    expect(first).toMatch(
      /if \(rowHold !== null && !this\.postingBBToEnter\.has\(p\.user_id\)\) \{\s*this\.persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\);\s*continue;/
    );
    // `continue` matters as much as the clear: a chair that has never been
    // dealt a hand here must not be seeded as a veteran.
    expect(first.indexOf('const rowHold')).toBeLessThan(first.indexOf('this.dealtInUserIds.add(p.user_id)'));
  });

  it('the restore is still once per process, which is WHY the clear is needed', () => {
    const restore = BASE.slice(
      BASE.indexOf('protected restoreEntryHoldsFromSeats'),
      BASE.indexOf('protected restoreEntryHoldsFromSeats') + 400
    );
    expect(restore).toMatch(/if \(this\.entryHoldsRestored\) return;\s*this\.entryHoldsRestored = true;/);
    // and the wait loop is what spends it first on a feeder
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/this\.restoreEntryHoldsFromSeats\(\);/);
  });

  it('the two arrival states are still exactly as Dan set them', () => {
    // moved by the game: nothing owed. seat change: posts the BB.
    expect(DEALING).toMatch(/entryHold === 'moved'[\s\S]{0,900}?this\.persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\)/);
    expect(DEALING).toMatch(/entryHold === 'waiting' && entryAgreed[\s\S]{0,600}?this\.postBBWhenClear\.add\(p\.user_id\)/);
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
      'this.timeBankEngine.removePlayer(this.tableId, id);',
      'this.straddleEngine.removePlayer(this.tableId, id);',
      'this.preActionEngine.removePlayer(this.tableId, id);',
    ]) {
      expect(prune, call).toContain(call);
    }
  });

  it('and the move path still deposits presence BEFORE it forgets the player', () => {
    const at = BASE.indexOf('this.depositPresenceForMove(m.player_id, m.to_table_id);');
    const forget = BASE.indexOf('this.disconnectEngine.unregisterPlayer(this.tableId, m.player_id);');
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
    expect(fn).toMatch(/reportError\(error, 'ServerTableEngine\.' \+ this\.tableId \+ '\.cluster_closed_read_failed'\)/);
  });
});

describe('D9 - the waiting table wakes its game too', () => {
  it('the wait loop wakes the cluster on a roster change, and never on its first read', () => {
    const wait = BASE.slice(
      BASE.indexOf("this.setLoopPhase('start_wait_for_players');"),
      BASE.indexOf("this.tableFSM.transition('seating');")
    );
    expect(wait).toMatch(/const idsBeforeSweep = new Set\(this\.seatedPlayers\.map\(\(p\) => p\.user_id\)\);/);
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
