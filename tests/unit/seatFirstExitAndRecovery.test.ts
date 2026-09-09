/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A RESERVED SEAT CAN ALWAYS BE SEEN, LEFT, AND RECOVERED (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four defects found in the seat-first audit, all of which stranded a player
 * who had ALREADY BEEN CHARGED. Each pin names the one it prevents.
 *
 * 1. THE LEAVE THAT COULD ONLY FAIL. The menu's Leave Table and the felt's
 *    leave button both route to `tableService.leaveTable`, which begins by
 *    asking the ENGINE to release the seat. A pre-start Spin or Heads-Up has
 *    no engine game by design, so that call could only fail and the player
 *    was told "your chips were not moved, please try again" — forever, on the
 *    exit they are most likely to find. `fn_leave_seat_and_refund` is the
 *    seat-first exit and both doors must reach it.
 *
 * 2. THE SHADOWED FOOTER. `commitSeatFirstBuyIn` sets `heroSeat` and nothing
 *    else; `players[]` only catches up on the roster round-trip. In that
 *    window the "no hero in players" branch matched first and rendered a bare
 *    "Spectating" — hiding the Leave Seat button from the one player who had
 *    paid for the seat.
 *
 * 3. THE SEAT THAT STAYED CLAIMED. `pendingSeat` is set by a successful
 *    buy-in and was cleared only by the CASH modal's callbacks. Left set
 *    after a refund, `canSit` turns every seat into an inert EMPTY plate and
 *    `isHeroReservedSeat` keeps the refunded seat reading YOUR SEAT.
 *
 * 4. SEAT-FIRST COULD ONLY EVER TURN OFF. It is written once, in the mount
 *    effect, and the only other writer clears it. One unlucky read (RLS,
 *    network, or a table that exists a heartbeat before its tournament flips
 *    to REGISTERING) left it null for the whole session — inert seats and a
 *    "Spectating" footer at a table that is plainly selling seats, with no
 *    recovery but a manual reload.
 *
 * Source-contract pins, the repo's pattern for rules living inside components
 * too heavy to render in a unit test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
/* Windows are bounded by STRUCTURE, never by a byte count — see
   tests/helpers/sourceWindow.ts for the outage that rule was written after. */
import { sliceMethod, sliceBetween } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');
const table = read('pages/TablePage.tsx');

describe('a pre-start seat-first seat leaves through its refund', () => {
  it('handleLeaveTable routes seat-first holders to the replay-safe refund service', () => {
    const body = sliceMethod(table, 'const handleLeaveTable = async () => {');
    expect(body).toContain('seatFirstBuyIn && tableState.heroSeat > 0');
    expect(body).toContain('tournamentService.leaveTournamentSeatAndRefund');
    /* It must return before ever reaching the engine-first path. Matched on
       the CALL, not the name — the rationale comment above names
       `tableService.leaveTable` too, and matching that would compare a
       comment against code. */
    expect(body.indexOf('tournamentService.leaveTournamentSeatAndRefund')).toBeLessThan(
      body.indexOf('await tableService.leaveTable(')
    );
  });

  it('both refusal paths report, so an unknown reason is searchable', () => {
    expect(table).toContain("'TablePage.leave_seat_refund'");
    expect(table).toContain("'TablePage.leave_table_seat_first'");
    expect(table.match(/tournamentUnregisterWasAlreadyStarted\(err\)/g)).toHaveLength(2);
  });
});

describe('the footer never hides a paid seat behind "Spectating"', () => {
  it('the no-hero-in-players branch yields to a held seat-first seat', () => {
    expect(table).toContain('!(seatFirstBuyIn && tableState.heroSeat > 0) ? (');
  });
});

describe('releasing a seat releases every claim on it', () => {
  it('BOTH exits clear pendingSeat and the confirm sheet', () => {
    // The footer's Leave Seat and the menu's Leave Table are two doors to one
    // seat; a claim left behind by either turns every seat into an inert
    // EMPTY plate and keeps the refunded chair reading YOUR SEAT.
    /* Each exit is bounded by the structure that owns it — the method for the
       menu's Leave Table, and the button's own label for the footer's Leave
       Seat — so both windows grow with their code. */
    const menuExit = sliceMethod(table, 'const handleLeaveTable = async () => {');
    expect(menuExit).toContain("'TablePage.leave_table_seat_first'");
    expect(menuExit, 'the menu exit leaves pendingSeat set').toContain('setPendingSeat(null)');
    expect(menuExit).toContain('setSeatFirstConfirm(null)');
    expect(menuExit).toContain('heroSeatRef.current = 0;');

    const footerExit = sliceBetween(table, 'spectator-footer-bar__cta--leave', 'Leave Seat');
    expect(footerExit, 'the footer exit leaves pendingSeat set').toContain('setPendingSeat(null)');
    expect(footerExit).toContain('setSeatFirstConfirm(null)');
    expect(footerExit).toContain('heroSeatRef.current = 0;');
  });
});

describe('seat-first can turn back ON, not only off', () => {
  it('a bounded recovery re-reads the tournament and can restore the buy-in', () => {
    expect(table).toContain('seatFirstRecoveryDoneRef');
    expect(table).toContain('TablePage.seat_first_recovery_unreadable');
    const start = table.indexOf("D8's MISSING HALF");
    expect(start, 'the recovery effect and its rationale must stay together').toBeGreaterThan(-1);
  });

  it('a missing cap is not a heads-up', () => {
    // `max_players ?? 0` with `<= 2` called every uncapped tournament a
    // two-seat game and offered seat-first buy-ins the RPC refuses.
    expect(table).toContain("fmt === 'spin' || (maxP > 0 && maxP <= 2)");
  });

  it('an unknown wallet balance does not read as an empty one', () => {
    expect(table).toContain(
      'const [accountBalance, setAccountBalance] = useState<number | null>(null)'
    );
    expect(table).toContain(
      'accountBalance !== null && Number(accountBalance) < seatFirstBuyIn.cost'
    );
  });
});

describe('only a heads-up SNG is seat-first in the game lobby panel', () => {
  it('multi-seat SNGs are not sent down the seat-first path', () => {
    const panel = read('components/lobby/GameLobbyPanel.tsx');
    expect(panel).toContain("entry.kind === 'sng' && entry.capacity > 0 && entry.capacity <= 2");
  });
});
