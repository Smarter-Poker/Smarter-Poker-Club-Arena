/**
 * SHOWDOWN SYSTEM 2026-08-25 — the client half of Dan's showdown spec,
 * pinned the way this repo pins engine↔client contracts: by reading the
 * source at both ends (see winningCardHighlight.test.ts, the file whose five
 * skipped specs this work un-skipped).
 *
 * What must stay true:
 *   - the engine's showdown event carries the reveal SEQUENCE and muck
 *     ruling (reveal_order, mucked) and pot_win carries hand_description +
 *     hole_card_indices per winner;
 *   - a mucked hand is withheld from every public reveal surface;
 *   - the client's hand-complete reset holds for the sequenced holdMs it
 *     already computes, not a hard-coded 3000;
 *   - the seat can render a MUCKED label and the board a secondary hand
 *     description, and both have CSS behind them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { HAND_COMPLETION } from '../../src/config/handCompletionSpec';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const EVENTS = strip(read('server/src/engine/ServerTableEngineHandEvents.ts'));
const ENGINE = strip(read('server/src/engine/ServerTableEngine.ts'));
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const SEAT = strip(read('src/components/table/SeatSlot.tsx'));
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const BOARD = strip(read('src/components/table/CommunityCards.tsx'));
const BOARD_CSS = read('src/components/table/CommunityCards.css');

describe('the engine PUBLISHES the showdown sequence and muck ruling', () => {
  it('the showdown event carries reveal_order and mucked per result', () => {
    const sd = EVENTS.slice(EVENTS.indexOf("type: 'showdown',"));
    expect(sd.slice(0, 1200)).toMatch(/reveal_order:/);
    expect(sd.slice(0, 1200)).toMatch(/mucked/);
  });

  it('pot_win winners carry hand_description and hole_card_indices', () => {
    const potWin = EVENTS.slice(EVENTS.indexOf("type: 'pot_win'"));
    expect(potWin.slice(0, 2600)).toMatch(/hand_description:/);
    expect(potWin.slice(0, 2600)).toMatch(/hole_card_indices:/);
  });

  it('a mucked hand is excluded from showdown_cards_revealed', () => {
    const at = EVENTS.indexOf("type: 'showdown_cards_revealed'");
    expect(at).toBeGreaterThan(-1);
    // The reveals list is filtered by the muck ruling before the emit.
    const before = EVENTS.slice(Math.max(0, at - 1500), at);
    expect(before).toMatch(/isMuckedAtShowdown/);
  });

  it('the snapshot reveal gate and the resync gate both respect the muck', () => {
    // broadcastCurrentState's showCards calc + getTableState's reveal branch.
    const gates = ENGINE.match(/isMuckedAtShowdown/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(3);
    expect(ENGINE).toMatch(/is_mucked:/);
  });

  it('pot_distributed reads the real eligiblePlayers field', () => {
    const at = EVENTS.indexOf("type: 'pot_distributed'");
    const before = EVENTS.slice(Math.max(0, at - 1600), at);
    expect(before).toMatch(/p\.eligiblePlayers/);
  });
});

describe('the client RENDERS the sequence, the muck, and the description', () => {
  it('the hand-complete reset holds for the computed holdMs, never a bare 3000', () => {
    expect(TABLE_PAGE).toMatch(/\}, holdMs\);/);
  });

  it('the seat accepts the MUCKED ruling and the reveal stagger', () => {
    expect(SEAT).toMatch(/isMuckedShowdown/);
    expect(SEAT).toMatch(/showdownRevealDelayMs/);
    expect(SEAT).toMatch(/seat__mucked-label/);
    expect(SEAT_CSS).toMatch(/\.seat__mucked-label/);
  });

  it('the seat lights exactly the winning hole cards when the engine names them', () => {
    expect(SEAT).toMatch(/winningHoleCardIndexes/);
    expect(TABLE_PAGE).toMatch(/hole_card_indices/);
  });

  it('the board renders the secondary hand description', () => {
    expect(BOARD).toMatch(/winningHandDescription/);
    expect(BOARD).toMatch(/community-cards__hand-description/);
    expect(BOARD_CSS).toMatch(/\.community-cards__hand-description/);
  });

  it('the reveal stagger is a shared spec constant, small enough to fit the read window', () => {
    expect(HAND_COMPLETION.SHOWDOWN_REVEAL_STAGGER_MS).toBeGreaterThan(0);
    // Even a 9-way showdown's last flip must land inside the read window.
    expect(8 * HAND_COMPLETION.SHOWDOWN_REVEAL_STAGGER_MS).toBeLessThanOrEqual(
      HAND_COMPLETION.SHOWDOWN_READ_MAX_MS
    );
  });

  it('the TablePage consumes the showdown event sequence', () => {
    expect(TABLE_PAGE).toMatch(/reveal_order/);
    expect(TABLE_PAGE).toMatch(/setMuckedLabelSeats/);
    expect(TABLE_PAGE).toMatch(/SHOWDOWN_REVEAL_STAGGER_MS/);
  });
});
