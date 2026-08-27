/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE WINNING HAND IS IDENTIFIED, NOT JUST NAMED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's completion law: a hand is not over "UNTIL THE WINNING HAND IS SHOWN AT
 * SHOW DOWN AND IDENTIFIED". We named it ("Straight") but never showed WHICH
 * five cards made it, so the player had to work out their own showdown.
 *
 * THE SHAPE THIS GUARDS AGAINST — a feature dead on arrival because two
 * finished halves were never joined:
 *   - evaluateHand() has always returned `cards`, the exact best five.
 *   - Winner has always carried it as `hand`.
 *   - CommunityCards has always accepted `highlightedIndices` and shipped the
 *     golden glow + pop animation.
 *   - TablePage has always read `card_indices` off the pot_win event.
 *   ...and nothing ever SENT it. Identical to the Spin's locked tiers, which
 *   also rendered, also had CSS, also had tests, and were also never passed a
 *   value.
 *
 * So this file pins the WIRE, at both ends.
 */
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SHOWDOWN SYSTEM 2026-08-25: the wire is CONNECTED and the five engine specs
 * below run un-skipped. The last missing link was the winner-capture in
 * ServerTableEngineHandEvents narrowing `hand` down to {name, ranking} and
 * dropping `cards` — the derivation read `w.hand?.cards` and always saw
 * undefined, so card_indices went out empty on every hand. The capture now
 * keeps `cards`, pot_win carries real indices, and the seats additionally
 * receive per-winner `hole_card_indices` for the hole-card half of the
 * highlight.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const EVENTS = strip(read('server/src/engine/ServerTableEngineHandEvents.ts'));
const BASE = strip(read('server/src/engine/ServerTableEngineBase.ts'));
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const BOARD = read('src/components/table/CommunityCards.tsx');
const BOARD_CSS = read('src/components/table/CommunityCards.css');

describe('the engine SENDS which board cards won', () => {
  it('pot_win carries card_indices', () => {
    const potWin = EVENTS.slice(EVENTS.indexOf("type: 'pot_win'"));
    expect(potWin.slice(0, 1200)).toMatch(/card_indices:/);
  });

  it("the indices are derived from the winners' evaluated cards", () => {
    expect(EVENTS).toMatch(/winningBoardIndices/);
    expect(EVENTS).toMatch(/w\.hand\?\.cards/);
  });

  it('BOARD cards only — hole cards are drawn at the seat, not on the felt', () => {
    // `capturedBoard` is read from communityCards just ABOVE the derivation
    // (captured before the settle hold, 2026-08-26), so anchor on it rather
    // than slicing forward from winningBoardIndices.
    const at = EVENTS.indexOf('const capturedBoard');
    expect(at, 'capturedBoard not found').toBeGreaterThan(-1);
    expect(EVENTS.slice(at, at + 400)).toMatch(/communityCards/);
    expect(EVENTS.indexOf('winningBoardIndices')).toBeGreaterThan(at);
  });

  it('the stored winner type keeps `cards` instead of narrowing it away', () => {
    // This narrowing is what made the data unreachable for months.
    expect(BASE).toMatch(/hand\?:\s*\{\s*name:\s*string;\s*ranking:\s*number;\s*cards\?/);
  });

  it('a highlight failure can never break the payout event', () => {
    const block = EVENTS.slice(EVENTS.indexOf('winningBoardIndices'));
    expect(block.slice(0, 900)).toMatch(/catch/);
  });
});

describe('the client RENDERS the highlight', () => {
  it('the board is passed the winner card indices', () => {
    /* `shownWinnerInfo`, not `winnerInfo`, since 2026-08-27 (round 3, item 7).
       Same field; the view it is read from is stamped with the hand it belongs
       to, so a result cannot be rendered against a later hand. Asserted as the
       STAMPED view deliberately — reading the raw record here would be the
       regression this rename exists to prevent. */
    expect(TABLE_PAGE).toMatch(/highlightedIndices=\{shownWinnerInfo\.cardIndices\}/);
  });

  it('it reads the field the engine actually emits', () => {
    expect(TABLE_PAGE).toMatch(/card_indices/);
  });

  it('the highlight is cleared between hands, never carried over', () => {
    /* THE CLEAR IS ONE OBJECT NOW, NOT THREE COPIES OF ONE (2026-08-27).
       This used to count `cardIndices: []` literals, requiring at least two —
       HAND_STARTED and the HAND_COMPLETE hold. Those literals were four
       hand-maintained copies of the same empty value, and the round-3 item-7
       stamp had to be added to every one of them, which is precisely how a
       clearing path gets missed. They collapsed onto `EMPTY_WINNER_INFO`.

       So the assertion moved with them, and got stronger: the empty value has
       to exist, both clearing paths have to use it, and — the part no literal
       count could ever have caught — the display has to be fenced by the hand
       stamp, so a clear that is late or never arrives cannot show a stale
       banner in the first place. */
    expect(TABLE_PAGE).toMatch(/const EMPTY_WINNER_INFO: TableWinnerInfo = \{/);
    expect(TABLE_PAGE).toMatch(/cardIndices:\s*\[\]/);
    const clears = TABLE_PAGE.match(/setWinnerInfo\(EMPTY_WINNER_INFO\)/g) || [];
    expect(clears.length, 'HAND_STARTED and the HAND_COMPLETE hold both clear it').toBe(2);
    // And the mirror the WS handlers read, which render-time assignment alone
    // left holding the previous hand until React committed.
    const mirrorClears = TABLE_PAGE.match(/winnerInfoRef\.current = EMPTY_WINNER_INFO/g) || [];
    expect(mirrorClears.length).toBe(2);
    // The fence itself.
    expect(TABLE_PAGE).toMatch(/const shownWinnerInfo = useMemo/);
    expect(TABLE_PAGE).toMatch(/winnerInfo\.handNumber === live/);
  });

  it('the board component still accepts and applies the prop', () => {
    expect(BOARD).toMatch(/highlightedIndices\?:\s*number\[\]/);
    expect(BOARD).toMatch(/highlightedIndices/);
  });

  it('the glow and the pop animation exist in CSS', () => {
    expect(BOARD_CSS).toMatch(/\.community-cards__card--highlighted/);
    expect(BOARD_CSS).toMatch(/highlight-pop|highlight-glow/);
  });
});
