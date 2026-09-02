/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: THE HERO IS SHOWN THIS HAND, AT THIS TABLE, OR NOTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-01, on the J9h screenshot: "I NEED YOU TO TELL ME HOW IT WAS EVEN
 * POSSIBLE FOR TWO 9 OF HEARTS TO APPEAR AT THE SAME TIME... AND WHAT WE'VE DONE
 * TO PREVENT IT FROM NEVER BEING POSSIBLE TO HAPPEN EVER AGAIN."
 *
 * HOW IT WAS POSSIBLE. There are four ways a holding reaches the hero's seat,
 * and on the day of the report only two of them checked anything:
 *
 *   1. the realtime push from `table_hole_cards`  NOTHING - and it is the only
 *                                                 one that OVERWRITES what is
 *                                                 already on screen, and it
 *                                                 fires on every INSERT AND
 *                                                 UPDATE, including re-pushes
 *   2. the bounded recovery poll                  hand + board
 *   3. the hold across engine snapshots           board
 *   4. the GAME_START full-state merge            NOTHING - and it is dispatched
 *                                                 precisely on the websocket
 *                                                 sequence gap that loses
 *                                                 HAND_STARTED
 *
 * Guarding 3 alone could never have held: the hold would drop the stale hand
 * and door 1 would repaint it on the very next payload.
 *
 * WHAT MAKES IT IMPOSSIBLE. The question moved into one pure function that all
 * four doors ask, this file pins the answers, and a source pin below fails the
 * build if a door stops asking. A fifth safety net checks the finished state
 * after every commit, so a door nobody thought of is still caught.
 *
 * Every case here is a real shape from the incident, not a hypothetical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heroHoleCardsAreForThisHand } from '../../src/lib/tableCardDisplay';
import { sliceCall, sliceMethod } from '../helpers/sourceWindow';

const TABLE = '0dc28772-165e-4f2a-abec-6299e769bea9';
const J9H = [
  { rank: 'J', suit: 'h' },
  { rank: '9', suit: 'h' },
];
const FLOP_K9Q = [
  { rank: 'K', suit: 'diamonds' },
  { rank: '9', suit: 'hearts' },
  { rank: 'Q', suit: 'diamonds' },
];

describe('LAW: hero hole cards must belong to this hand and this table', () => {
  it('accepts the ordinary case', () => {
    expect(
      heroHoleCardsAreForThisHand({
        rowTableId: TABLE,
        tableId: TABLE,
        rowHandNumber: 3992164,
        currentHandNumber: 3992164,
        cards: J9H,
        boards: [[], [], []],
      })
    ).toEqual({ ok: true });
  });

  it('refuses a row from an EARLIER hand, which is the reported bug', () => {
    // The push that repainted hand N onto hand N+1.
    expect(
      heroHoleCardsAreForThisHand({
        rowTableId: TABLE,
        tableId: TABLE,
        rowHandNumber: 3991946,
        currentHandNumber: 3992164,
        cards: J9H,
        boards: [FLOP_K9Q, [], []],
      })
    ).toEqual({ ok: false, reason: 'stale-hand' });
  });

  it('ACCEPTS a row from a later hand, because the hero must never be blinded', () => {
    /* The deal for the next hand can arrive before this client has processed
       HAND_STARTED. Refusing it would blank the hero at the exact moment they
       are dealt in, which is the worse bug and the reason the hold fails open.
       An OLDER row can never be right; a NEWER one usually is. */
    expect(
      heroHoleCardsAreForThisHand({
        rowTableId: TABLE,
        tableId: TABLE,
        rowHandNumber: 3992458,
        currentHandNumber: 3992164,
        cards: J9H,
        boards: [[], [], []],
      })
    ).toEqual({ ok: true });
  });

  it('refuses a card that is already on the board, whatever the hand says', () => {
    // Same hand number, and still impossible. Physical proof outranks metadata.
    expect(
      heroHoleCardsAreForThisHand({
        rowTableId: TABLE,
        tableId: TABLE,
        rowHandNumber: 3992164,
        currentHandNumber: 3992164,
        cards: J9H,
        boards: [FLOP_K9Q, [], []],
      })
    ).toEqual({ ok: false, reason: 'collides-with-board' });
  });

  it('refuses a row belonging to another table', () => {
    /* Danimal was multi-tabling when this happened - two live hands at
       20:21:57, on 0dc28772 and on 16f75832. The realtime channel is filtered
       by table_id server-side, so this can only fire if that filter is ever
       lost. It costs one string compare. */
    expect(
      heroHoleCardsAreForThisHand({
        rowTableId: '16f75832-3463-44bf-a4b7-446c7c6016e7',
        tableId: TABLE,
        rowHandNumber: 3992125,
        currentHandNumber: 3992164,
        cards: J9H,
        boards: [[], [], []],
      })
    ).toEqual({ ok: false, reason: 'wrong-table' });
  });

  it('fails OPEN on what it cannot know, and only there', () => {
    // No hand number anywhere: a mid-hand join, a reload, a dropped event.
    // The board is then the only evidence, and here it says nothing.
    expect(
      heroHoleCardsAreForThisHand({
        tableId: TABLE,
        currentHandNumber: 0,
        cards: J9H,
        boards: [[], [], []],
      })
    ).toEqual({ ok: true });
    // ...but an unknown hand does NOT buy a pass on the board.
    expect(
      heroHoleCardsAreForThisHand({
        tableId: TABLE,
        currentHandNumber: 0,
        cards: J9H,
        boards: [FLOP_K9Q, [], []],
      })
    ).toEqual({ ok: false, reason: 'collides-with-board' });
  });

  it('treats an empty holding as nothing to apply, not as an acceptance', () => {
    expect(heroHoleCardsAreForThisHand({ cards: [], boards: [[]] })).toEqual({
      ok: false,
      reason: 'no-cards',
    });
    expect(heroHoleCardsAreForThisHand({ cards: null, boards: [[]] })).toEqual({
      ok: false,
      reason: 'no-cards',
    });
  });

  it('checks the double and triple boards, not just the first', () => {
    expect(
      heroHoleCardsAreForThisHand({
        cards: J9H,
        currentHandNumber: 1,
        rowHandNumber: 1,
        boards: [[], FLOP_K9Q, []],
      })
    ).toEqual({ ok: false, reason: 'collides-with-board' });
    expect(
      heroHoleCardsAreForThisHand({
        cards: J9H,
        currentHandNumber: 1,
        rowHandNumber: 1,
        boards: [[], [], FLOP_K9Q],
      })
    ).toEqual({ ok: false, reason: 'collides-with-board' });
  });
});

describe('LAW: every door into the hero holding asks the question', () => {
  const SRC = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('door 1 - the realtime push consults the rule before applying', () => {
    /* This is the door that had no lock. It must ask, and it must ask with the
       ROW's hand number against the LIVE one - passing a constant, or the row's
       number for both, would satisfy a shallower pin while changing nothing. */
    /* Bounded by the call it is about, so the window grows exactly as fast as
       the handler does. A fixed byte window over a 15,000-line file is how a
       pin stops covering the code it names while staying green. */
    const handler = sliceCall(SRC, 'const handleHoleCardPayload = useCallback');
    expect(handler.length).toBeGreaterThan(500);
    expect(handler).toMatch(/heroHoleCardsAreForThisHand\(/);
    expect(handler).toMatch(/rowHandNumber:\s*typeof row\.hand_number/);
    expect(handler).toMatch(/currentHandNumber:\s*heroHandRef\.current/);
    expect(handler).toMatch(/rowTableId:\s*row\.table_id/);
    // A refusal must return BEFORE the cards are written, and must be reported.
    const refusal = sliceMethod(handler, 'if (!verdict.ok)');
    expect(refusal).toMatch(/hole_card_push_refused/);
    expect(refusal).toMatch(/\breturn;/);
    // The deal sound, and the write, must both sit AFTER the refusal block.
    expect(handler.indexOf('soundService.playDeal')).toBeGreaterThan(
      handler.indexOf('if (!verdict.ok)')
    );
    expect(handler.indexOf('holeCards: formattedCards')).toBeGreaterThan(
      handler.indexOf('if (!verdict.ok)')
    );
  });

  it('door 2 - the recovery poll still rejects a stale row and a contradicted one', () => {
    expect(SRC).toMatch(/hand_number !== heroHandRef\.current/);
    expect(SRC).toMatch(/TablePage\.hole_card_recovery_read_failed/);
  });

  it('door 3 - the snapshot hold still drops a holding the board disproves', () => {
    expect(SRC).toMatch(/!heroCardsCollideWithBoard\(\s*prevHero\.holeCards/);
  });

  it('door 4 - the GAME_START merge does not carry an expired holding across', () => {
    expect(SRC).toMatch(/heroHoldIsExpired/);
    expect(SRC).toMatch(/heroHoldIsExpired\(existing\?\.holeCards\)/);
  });

  it('and the net under all four reports and re-reads rather than repainting', () => {
    const net = sliceCall(SRC, 'const dropExpiredHeroHolding = useCallback');
    // Say so.
    expect(net).toMatch(/TablePage\.hero_card_board_collision/);
    // Clear it - complaining about an impossible hand while still showing it
    // is the failure mode this whole file exists to prevent.
    expect(net).toMatch(/holeCards: \[\]/);
    // And ask for the real one back, or the hero is left holding nothing.
    expect(net).toMatch(/heroCardsRecoveredRef\.current = false/);
    expect(net).toMatch(/heroCardFetchRef\.current\?\.\(\)/);
  });

  it('the rule itself is never inlined back into the component', () => {
    /* The reason this bug survived three fixes is that the same decision was
       written four times in one 15,000-line file and only two copies were ever
       updated. It lives in src/lib now. If TablePage grows its own copy, this
       fails. */
    expect(SRC).not.toMatch(/function heroHoleCardsAreForThisHand/);
  });
});

describe('LAW: the hand number does not wait for an event that may never arrive', () => {
  const SRC = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('is seeded from the authoritative snapshot, not only from HAND_STARTED', () => {
    /* Both stale-hand guards are gated on this ref being non-zero, and it used
       to be written in exactly one place - the HAND_STARTED handler. A client
       that never receives that event (mid-hand join, reload, dropped frame, the
       sequence gap that fires GAME_START) therefore ran the whole hand with the
       hand check DISABLED, leaving only the board check. Preflop there is no
       board, so there was nothing left. */
    const seed = sliceCall(SRC, 'const hn = tableState.handNumber');
    expect(seed).toBeTruthy();
    expect(SRC).toMatch(
      /const hn = tableState\.handNumber \?\? 0;\s*\n\s*if \(hn > heroHandRef\.current\) heroHandRef\.current = hn;/
    );
  });

  it('moves FORWARD only, so a replayed snapshot cannot re-admit an old row', () => {
    // `>=` here would let a late frame for the previous hand lower the mark and
    // hand door 1 back the row it had just refused.
    expect(SRC).not.toMatch(/if \(hn >= heroHandRef\.current\) heroHandRef\.current = hn;/);
  });

  it('HAND_STARTED still sets it, because the event is the earliest signal', () => {
    expect(SRC).toMatch(/if \(hn > 0\) heroHandRef\.current = hn;/);
  });

  it('a DELETE on the hole-card channel is ignored, on purpose and in writing', () => {
    /* insert_hole_cards prunes `hand_number < p_hand_number` on every deal, so
       the deletes this channel sees are the PREVIOUS hand being tidied. Acting
       on one would blank a live hand at the moment the next is dealt. The
       comment exists so nobody "fixes" the silence into a clear. */
    const handler = sliceCall(SRC, 'const handleHoleCardPayload = useCallback');
    expect(handler).toMatch(/DELETE carries no `new`/);
    expect(handler).toMatch(/Do not "fix" this into a clear/);
  });
});
