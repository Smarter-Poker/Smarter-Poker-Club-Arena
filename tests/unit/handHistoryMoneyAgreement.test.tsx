/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE HAND, ONE SET OF NUMBERS (Dan 2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Hand History and Hand Detail read the same stored hand and printed different
 * money for it. The worked example, which is the fixture below:
 *
 *   Hero posts 2, calls 10, takes a 24 pot.
 *   Hand History said  +12  (the stored result, `heroResult`).
 *   Hand Detail said     0.
 *
 * Hand Detail subtracted every action amount and then ADDED `winners[].amount`,
 * treating it as the gross chips taken from the pot. It was the net, so the
 * hero's own 12 came off twice: 24 - 12 - 12 = 0. Losers matched by accident,
 * because with no winner term the two definitions coincide, which is why this
 * survived so long.
 *
 * The settled contract, asserted below on every surface at once:
 *
 *   COLLECTED  gross chips the pot paid a winner   -> `winners[].amount`
 *   NET        collected minus invested            -> `players[].result`,
 *                                                     and `heroResult` for hero
 *
 * Both are shown, both are labelled, and the clipboard export prints a line for
 * each. A test that only checked the adapter would not have caught this: the
 * adapter was self-consistent, and the disagreement only existed between two
 * screens. So these render the real components.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';
import HandHistoryPanel from '@/components/table/HandHistoryPanel';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import type { HandRecord as ServiceHandRecord } from '@/services/HandHistoryService';
import { buildReplay } from '@/utils/handReplay';

const HERO = 'hero-1';
const VILLAIN = 'villain-1';

/* Comments are stripped before any source assertion. House style is to quote
   the broken line in the comment that replaces it, so `not.toContain('onReplay={() =>')`
   would match the TOMBSTONE and fail on correct code — and, worse, a positive
   assertion could be satisfied by a comment with the implementation deleted.
   The `[^:"'\`\\]` guard keeps `https://` intact. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const readSrc = (p: string) =>
  stripComments(readFileSync(resolve(__dirname, '..', '..', p), 'utf8'));

afterEach(cleanup);

/**
 * The worked example, in the shape HandHistoryService actually returns.
 *
 * Hero: posts 2, calls 10  -> invested 12, collected 24, net +12.
 * Villain: posts 2, raises 10 -> invested 12, collected 0, net -12.
 * Pot 24. Every figure below is internally consistent with every other one,
 * which is the only way this fixture can prove anything.
 */
function workedExample(over: Record<string, unknown> = {}): ServiceHandRecord {
  return {
    id: 'wex-1',
    serial_number: 'wex-1',
    table_id: 't1',
    table_name: 'Table',
    played_at: '2026-08-23T12:00:00.000Z',
    hand_number: 7,
    total_hands: 1,
    main_pot: 24,
    side_pots: [],
    community_cards: [],
    players: [
      {
        seat: 1,
        user_id: HERO,
        username: 'Hero',
        avatar_url: null,
        position: 'SB',
        hole_cards: [
          { rank: 'A', suit: 'clubs' },
          { rank: 'A', suit: 'spades' },
        ],
        final_hand: 'Pair Of Aces',
        result: 12,
        is_winner: true,
      },
      {
        seat: 2,
        user_id: VILLAIN,
        username: 'Villain',
        avatar_url: null,
        position: 'BB',
        hole_cards: [],
        result: -12,
        is_winner: false,
      },
    ],
    actions: [
      { player_id: HERO, action: 'bet', amount: 2, street: 'preflop', timestamp: 1 },
      { player_id: VILLAIN, action: 'raise', amount: 12, street: 'preflop', timestamp: 2 },
      { player_id: HERO, action: 'call', amount: 10, street: 'preflop', timestamp: 3 },
    ],
    winners: [{ user_id: HERO, amount: 24, pot_index: 0, hand_name: 'Pair Of Aces' }],
    game_type: 'NLH',
    stakes: '1/2',
    ...over,
  } as unknown as ServiceHandRecord;
}

describe('the adapter separates the two figures instead of publishing one twice', () => {
  const hand = adaptServiceHandToPanel(workedExample(), HERO);

  it('collected is the 24 the pot paid, not the 12 the hero is up', () => {
    expect(hand.winners).toHaveLength(1);
    expect(hand.winners[0].amount).toBe(24);
  });

  it('net is the 12 the hero is up, on the player and on heroResult alike', () => {
    expect(hand.players.find((p) => p.id === HERO)?.result).toBe(12);
    expect(hand.heroResult).toBe(12);
  });

  it('a loser carries their own negative net, unchanged by any of this', () => {
    expect(hand.players.find((p) => p.id === VILLAIN)?.result).toBe(-12);
  });
});

describe('Hand Detail and Hand History agree about one hand', () => {
  const hand = adaptServiceHandToPanel(workedExample(), HERO);

  const heroDetailRow = () =>
    Array.from(document.querySelectorAll('.hdm-sd')).find((r) => r.textContent?.includes('Hero'));

  /**
   * 2026-08-27: the per-player money block now lives on HAND SUMMARY.
   *
   * The Hand Detail tab renders the shared `HandDetailView` off the raw
   * hand_history row, so it needs a network read that jsdom has no reason to
   * satisfy — and it carries its OWN showdown. Keeping a second one in the
   * detail tab was the duplication that let the two figures drift in the first
   * place. Every assertion below is unchanged; they simply open the tab that
   * owns Collected and Net.
   *
   * The two surfaces cannot disagree any more for a stronger reason than this
   * test: `HandHistoryService.buildResult` and `HandDetailView` both derive net
   * from `buildReplay`, so they are one computation over two shapes of the same
   * row. See tests/unit/handHistoryPositions.test.ts.
   */
  const openSummary = () => fireEvent.click(screen.getByRole('tab', { name: 'Hand Summary' }));

  it('Hand Detail shows +12, the figure Hand History has always shown', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
    openSummary();
    expect(heroDetailRow()).toBeTruthy();
    expect(heroDetailRow()?.querySelector('.hdm-sd__net')?.textContent).toBe('+12.00');
  });

  it('Hand Detail no longer prints the double-subtracted 0', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
    openSummary();
    // 24 - 12 - 12 = 0 was the old answer, and the exact shape of the bug.
    expect(heroDetailRow()?.querySelector('.hdm-sd__net')?.textContent).not.toBe('0.00');
  });

  it('Hand Detail names the gross separately, so 24 and 12 cannot be confused', () => {
    render(<HandDetailModal isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
    openSummary();
    expect(heroDetailRow()?.querySelector('.hdm-sd__collected')?.textContent).toBe(
      'Collected 24.00'
    );
  });

  /* Correcting the adapter alone makes the OLD arithmetic land on +12 too,
     because `gross - invested` is how the service defines result. That is a
     coincidence, not a contract, and it only holds while the action log
     accounts for every chip. Strip the log and the two answers separate:
     recomputing gives 24, the stored net still gives 12. This pins the modal
     to the stored figure so a blind, an ante or a returned uncalled bet
     written outside `actions` cannot restart the drift. */
  it('reads the stored net rather than recomputing it from the action log', () => {
    const stripped = {
      ...hand,
      streets: hand.streets.map((s) => ({ ...s, actions: [] })),
    };
    render(<HandDetailModal isOpen onClose={() => {}} hands={[stripped]} heroId={HERO} />);
    openSummary();
    expect(heroDetailRow()?.querySelector('.hdm-sd__net')?.textContent).toBe('+12.00');
    expect(heroDetailRow()?.querySelector('.hdm-sd__net')?.textContent).not.toBe('+24.00');
  });

  it('Hand History shows the same +12 in its summary row', () => {
    render(<HandHistoryPanel isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
    expect(document.querySelector('.hh-entry__result')?.textContent).toBe('+12');
  });

  it('Hand History shows the same labelled pair once expanded', () => {
    render(<HandHistoryPanel isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
    fireEvent.click(document.querySelector('.hh-entry__summary') as Element);
    // The expanded entry IS the shared rundown: the same showdown row, the
    // same net, the pot line above it carrying the 24 the pot paid.
    const shown = Array.from(document.querySelectorAll('.hh-entry .hdv__sd')).find((r) =>
      r.textContent?.includes('Hero')
    );
    expect(shown?.querySelector('.hdv__sd-net')?.textContent).toBe('+12.00');
    expect(document.querySelector('.hh-entry .hdv__potline')?.textContent).toContain('24.00');
  });
});

describe('the exported text says what the screen says', () => {
  it('prints the gross as collected and the net on its own line', async () => {
    const hand = adaptServiceHandToPanel(workedExample(), HERO);
    let captured: Blob | null = null;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => {
      captured = b;
      return 'blob:stub';
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    try {
      render(<HandHistoryPanel isOpen onClose={() => {}} hands={[hand]} heroId={HERO} />);
      fireEvent.click(screen.getByTitle('Export All Hands'));
      expect(captured).not.toBeNull();
      const text = await (captured as unknown as Blob).text();
      /* "collected N from pot" is the PokerStars wording, and the number after
         it is the pot's, not the player's. It said "won 12" over the net, so a
         tracker importing this file booked the hero's own bets as chips that
         had never been in the pot. */
      expect(text).toContain('Hero collected 24.00 from pot');
      expect(text).toContain('Hero net result: +12');
      expect(text).not.toContain('Hero won 12');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe('Hand Detail names the discard street instead of leaking the enum', () => {
  const pineapple = adaptServiceHandToPanel(
    workedExample({
      actions: [
        { player_id: HERO, action: 'bet', amount: 2, street: 'preflop', timestamp: 1 },
        { player_id: VILLAIN, action: 'raise', amount: 12, street: 'preflop', timestamp: 2 },
        { player_id: HERO, action: 'call', amount: 10, street: 'preflop', timestamp: 3 },
        { player_id: HERO, action: 'discard', street: 'pineapple_discard', timestamp: 4 },
      ],
    }),
    HERO
  );

  it('the street reaches the modal at all', () => {
    expect(pineapple.streets.map((s) => s.name)).toContain('pineapple_discard');
  });

  /**
   * 2026-08-27: the street LABEL now lives in the shared reconstruction, which
   * is the point — there were three street-label tables in this feature and
   * two spellings of the same street. Asserting it here tests the thing that
   * actually decides the word, rather than one of the surfaces that used to
   * carry its own copy.
   *
   * It also pins something the old assertion could not: `pineapple_discard` is
   * a STREET of its own. It was being folded into preflop by the shared model,
   * so 74,631 discard actions would have appeared under a heading they did not
   * happen on.
   */
  it('prints "Discard", the same word Hand History prints', () => {
    const model = buildReplay({
      handNumber: 1,
      playedAt: null,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      potSize: 27,
      buttonSeat: 1,
      board: [],
      players: [
        { seat: 1, userId: HERO, username: 'Hero', stack: 0 },
        { seat: 2, userId: VILLAIN, username: 'Villain', stack: 0 },
      ],
      actions: [
        { seat: 1, userId: HERO, action: 'bet', amount: 2, stage: 'preflop' },
        { seat: 2, userId: VILLAIN, action: 'raise', amount: 12, stage: 'preflop' },
        { seat: 1, userId: HERO, action: 'call', amount: 10, stage: 'preflop' },
        { seat: 1, userId: HERO, action: 'discard', amount: 0, stage: 'pineapple_discard' },
      ],
      winners: [],
      holeCards: {},
    } as never);

    const labels = model.streets.map((st) => st.label);
    expect(labels).toContain('Discard');
    expect(labels).not.toContain('pineapple_discard');
    // Its own street, with its own row - not swept under PreFlop.
    const discard = model.streets.find((st) => st.key === 'pineapple_discard')!;
    expect(discard.rows).toHaveLength(1);
    expect(discard.rows[0].label).toBe('Discard');
  });
});

describe('the REPLAY button replays the hand on screen', () => {
  it('hands the viewed hand to onReplay, not the newest one', () => {
    const older = adaptServiceHandToPanel(workedExample({ id: 'older', hand_number: 3 }), HERO);
    const newest = adaptServiceHandToPanel(workedExample({ id: 'newest', hand_number: 7 }), HERO);
    const onReplay = vi.fn();
    // hands is newest-first; page back one to land on the older hand.
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[newest, older]}
        heroId={HERO}
        onReplay={onReplay}
      />
    );
    fireEvent.click(screen.getByLabelText('Older Hand'));
    fireEvent.click(screen.getByLabelText('Video Replay'));
    expect(onReplay).toHaveBeenCalledWith(expect.objectContaining({ id: 'older' }));
  });

  /* UN-SKIPPED 2026-08-24, in the commit that patched TablePage — which is the
     protocol the skip note asked for (CLAUDE.md section 5 rule 8: a skipped
     spec documents the work, a red one holds the platform hostage).

     BOTH handlers were declared with no parameter, so both discarded the hand
     the player was looking at. REPLAY resolved its own subject with
     `getPlayerHands(userId, 1)` — the NEWEST hand. SHARE used
     `sharedHandData`, a snapshot taken once at the end of the last LIVE hand,
     and refused outright with "Play a hand to the end, then share it" when no
     hand had completed this session. Paging back to hand 3 of 7 and pressing
     either button acted on hand 7.

     TypeScript cannot see this: a zero-argument function is assignable to a
     one-argument prop type, so a source assertion is the only thing that
     catches the regression. */
  it('TablePage passes the modal handlers that use the hand they are given', () => {
    const page = readSrc('src/pages/TablePage.tsx');
    const wiring = page.slice(page.indexOf('<HandDetailModal'), page.indexOf('<TableModalsLayer'));
    expect(wiring).not.toContain('onReplay={() =>');
    expect(wiring).not.toContain('onShare={() =>');
    expect(wiring).toContain('onReplay={(hand)');
    expect(wiring).toContain('onShare={(hand)');
  });
});
