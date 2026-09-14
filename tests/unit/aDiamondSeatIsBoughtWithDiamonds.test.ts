/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A DIAMOND SEAT IS BOUGHT WITH DIAMONDS AND SAYS SO (Diamond Phase 8)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The seat-first purchase (heads-up, spins) is the second door into a
 * tournament; the lobby register door is the first. Phase 8 taught the lobby
 * door to answer a Diamond refusal with a Diamond reason and to carry the
 * Diamond wallet after the charge; the seat door still read every
 * `insufficient*` as "Not Enough Chips", treated the two other Diamond
 * refusals as unknown outages, and never moved the Diamond balance on screen
 * after a paid seat. Found by the Phase 8 recheck of 2026-09-14.
 *
 * Pins: the refusal text and the known-reason list are shared helpers
 * (tested directly), and TablePage's seat-first handler uses them and emits
 * DIAMOND_BALANCE_CHANGED from the receipt (source-contract pins, the repo's
 * pattern for rules living inside components too heavy to render here).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  registerReasonText,
  seatFirstBuyInReasonIsKnown,
  seatFirstBuyInRefusalText,
} from '../../src/services/TournamentService';

const tablePage = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('a Diamond seat is bought with Diamonds and says so', () => {
  it('a Diamond refusal at the seat door says the same thing as at the lobby door', () => {
    for (const reason of [
      'insufficient_diamonds',
      'diamond_tournaments_not_open',
      'diamond_debt_requires_settlement',
    ]) {
      expect(seatFirstBuyInRefusalText(reason)).toBe(registerReasonText(reason));
      expect(seatFirstBuyInRefusalText(reason)).not.toMatch(/chips/i);
      expect(seatFirstBuyInReasonIsKnown(reason)).toBe(true);
    }
  });

  it('a Diamond player short of Diamonds is not told they lack chips', () => {
    expect(seatFirstBuyInRefusalText('insufficient_diamonds')).toBe(
      'Not Enough Settled Diamonds In Your Diamond Wallet.'
    );
    expect(seatFirstBuyInRefusalText('insufficient_chips')).toBe(
      'Not Enough Chips For This Buy In'
    );
    expect(seatFirstBuyInRefusalText('insufficient')).toBe('Not Enough Chips For This Buy In');
  });

  it('the chip seat reasons read as they always did', () => {
    expect(seatFirstBuyInRefusalText('seat_taken')).toBe('That Seat Was Just Taken');
    expect(seatFirstBuyInRefusalText('game_already_started')).toBe('This Game Has Already Started');
    expect(seatFirstBuyInRefusalText('tournament_full')).toBe('This Game Is Full');
    expect(seatFirstBuyInRefusalText('not_a_seat_first_game')).toBe(
      'Seats Are Not For Sale At This Table'
    );
    expect(seatFirstBuyInRefusalText('FOUR TABLE LIMIT: leave one')).toBe(
      'You Are Already In Four Games, Leave One To Join Another'
    );
    expect(seatFirstBuyInRefusalText('something_new')).toBe(
      'Could Not Take That Seat, Please Try Again'
    );
    expect(seatFirstBuyInReasonIsKnown('something_new')).toBe(false);
    expect(seatFirstBuyInReasonIsKnown(undefined)).toBe(false);
  });

  it('TablePage uses the shared helpers and moves the Diamond balance from the seat receipt', () => {
    const handler = tablePage.slice(
      tablePage.indexOf("supabase.rpc('fn_take_seat_and_buy_in'"),
      tablePage.indexOf("'TablePage.seat_first_buy_in')")
    );
    expect(handler).toContain('seatFirstBuyInReasonIsKnown(reason)');
    expect(handler).toContain('toast?.error?.(seatFirstBuyInRefusalText(reason))');
    expect(handler).not.toContain("'Not Enough Chips For This Buy In'");
    expect(handler).toContain(
      "if (res.asset === 'diamonds' && typeof res.diamonds_after === 'number')"
    );
    expect(handler).toContain("masterBus.emit('DIAMOND_BALANCE_CHANGED', {");
    expect(handler).toContain("source: 'tournament_seat_first_buy_in'");
    // the emit sits on the paid path, after the refusal return
    expect(handler.indexOf("masterBus.emit('DIAMOND_BALANCE_CHANGED'")).toBeGreaterThan(
      handler.indexOf('toast?.error?.(seatFirstBuyInRefusalText(reason))')
    );
  });
});
