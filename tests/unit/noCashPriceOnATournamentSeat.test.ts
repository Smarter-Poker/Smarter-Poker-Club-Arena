/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT SEAT IS NEVER SOLD AT A CASH PRICE (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FOUND IN A REAL BROWSER, against production, while building the seat-first
 * E2E spec. The table was `1 Chip Spin PLO5` — buy-in ONE chip. Clicking its
 * open seat opened the CASH buy-in modal:
 *
 *     BUY-IN   800 … 4,000    Min / Max / 40BB / 93BB / 146BB
 *     ( Account Balance: 495,817.23 )
 *
 * Not one number on that sheet was true of the game being played. And it
 * could not have led anywhere: `fn_take_seat_and_buy_in` is the only
 * sanctioned entry to a seat-first game, and the cash path does not call it.
 *
 * HOW IT IS REACHED. `handleSeatClick` had two outcomes: if `seatFirstBuyIn`
 * is set, open the seat-first sheet; OTHERWISE fall through to the cash
 * modal, priced from the table's BLINDS. There was no third branch, so a
 * TOURNAMENT table whose seat-first sale was unavailable took the cash one.
 * That happens routinely:
 *
 *   - the game FILLED between the lobby click and the seat click — spins fill
 *     in seconds and are recycled at roughly ten a minute;
 *   - the tournament read failed or was RLS-denied (the recovery effect's own
 *     comment lists this and two more);
 *   - the page mounted before the row flipped to REGISTERING.
 *
 * WHY IT MATTERS ENOUGH TO PIN. Dan, 2026-08-28: "I STILL CAN'T EVEN SIT DOWN
 * AND PLAY, IT NEVER WORKS, NEVER REGISTERS WITHOUT ERRORS." A cash prompt
 * for 800 chips on a one-chip spin is exactly that experience, and it is
 * worse than an inert seat: the player is shown a price, believes the game
 * wants it, and every path onward fails.
 *
 * The pins below hold the branch itself. They are source pins because the
 * thing being defended is a CONTROL-FLOW ORDER — the tournament guard must
 * sit between the seat-first branch and the cash path, and no future edit may
 * quietly reorder them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');

/** The handler, comments stripped, so no pin can be satisfied by prose. */
const HANDLER = sliceMethod(PAGE, 'const handleSeatClick = (seatNumber: number) => {')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the cash path is closed to tournament tables', () => {
  it('refuses before it can open the cash modal', () => {
    const guard = HANDLER.indexOf('tableState.isTournament || tableState.tournamentId');
    const cash = HANDLER.indexOf('setShowBuyInModal(true)');
    expect(guard, 'the tournament guard is missing from handleSeatClick').toBeGreaterThan(-1);
    expect(cash, 'the cash path is missing - this test is pinning the wrong file').toBeGreaterThan(
      -1
    );
    expect(guard, 'the guard must run BEFORE the cash modal opens').toBeLessThan(cash);
  });

  it('covers a table that is a tournament by EITHER measure', () => {
    /* `isTournament` is written as `game_type === 'tournament' || !!tournament_id`,
       but it lives in state that a failed load can leave at its initial false.
       `tournamentId` is the other half of the same fact, so the guard reads
       both - a table with a tournament id is a tournament whatever the flag
       says. */
    expect(HANDLER).toContain('tableState.isTournament || tableState.tournamentId');
  });

  it('returns rather than continuing into the cash path', () => {
    const guardBlock = sliceMethod(
      HANDLER,
      'if (tableState.isTournament || tableState.tournamentId) {'
    );
    expect(guardBlock).toContain('return;');
    expect(guardBlock).not.toContain('setShowBuyInModal');
    expect(guardBlock).not.toContain('setPendingSeat');
  });
});

describe('the seat-first sale still comes first', () => {
  it('a real seat-first sale opens the sheet and never reaches the guard', () => {
    const seatFirst = HANDLER.indexOf('if (seatFirstBuyIn) {');
    const guard = HANDLER.indexOf('tableState.isTournament || tableState.tournamentId');
    expect(seatFirst).toBeGreaterThan(-1);
    expect(seatFirst, 'the seat-first branch must be tried first').toBeLessThan(guard);
  });

  it('the seat-first branch still spends nothing on the tap', () => {
    /* Dan 2026-08-23: "you should sit down, then confirm buy in amount." The
       tap opens the sheet; only the sheet's confirm spends. */
    const branch = sliceMethod(HANDLER, 'if (seatFirstBuyIn) {');
    expect(branch).toContain('setSeatFirstConfirm(seatNumber)');
    expect(branch).not.toContain('commitSeatFirstBuyIn');
    expect(branch).not.toContain('fn_take_seat_and_buy_in');
  });
});

describe('the player is told the truth, and we hear about it', () => {
  it('says the seat is not for sale rather than quoting a foreign price', () => {
    expect(HANDLER).toContain('This Seat Is Not For Sale Right Now');
  });

  it('the message obeys the popup law - Title Case, no em dash', () => {
    // CLAUDE.md section 5.7 (Dan 2026-08-20, binding).
    const msg = 'This Seat Is Not For Sale Right Now';
    expect(msg).not.toMatch(/—/);
    for (const word of msg.split(' ')) {
      expect(word[0], `"${word}" must be capitalised`).toBe(word[0].toUpperCase());
    }
  });

  it('reports the occurrence, because reaching it at all is a defect upstream', () => {
    /* The guard makes the SYMPTOM harmless; it does not make the cause go
       away. Every time a player taps a tournament seat that has no sale, some
       earlier read failed or the game filled underneath them, and we want the
       count. A guard that silences a bug without recording it is how the
       original one survived this long. */
    expect(HANDLER).toContain('TablePage.cash_path_on_tournament_seat');
  });
});
