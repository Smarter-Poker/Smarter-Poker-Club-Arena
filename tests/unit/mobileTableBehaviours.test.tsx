/**
 * Mobile table behaviours reported by Dan on 2026-08-27.
 *
 * Four separate complaints, one file, because they share a shape: something the
 * table is supposed to show either never appears, or appears and refuses to
 * leave. Each test pins the MECHANISM rather than a pixel or a millisecond,
 * for the same reason bottomBarReserve.test.ts does — a number is exactly what
 * failed.
 *
 *   1. "announcements ... sometimes glitch and stay on the screen"
 *      The overlay's auto-dismiss timer was rescheduled by every parent render.
 *   2. an uncontested win showed no label at all above the board.
 *   3. `data-hero-action` — the contract another agent's CSS keys on.
 *   4. table chat appearing on tournament and heads-up tables.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import TournamentAnnouncementOverlay from '../../src/components/table/TournamentAnnouncementOverlay';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const MODALS_LAYER = read('src/components/table/TableModalsLayer.tsx');
const OVERLAY = read('src/components/table/TournamentAnnouncementOverlay.tsx');

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The stuck announcement
// ─────────────────────────────────────────────────────────────────────────────
describe('an announcement leaves the felt on its own, however busy the table is', () => {
  it('does not reschedule its dismiss timer when the parent re-renders', () => {
    vi.useFakeTimers();
    const dismissed = vi.fn();

    // A NEW inline arrow on every render — exactly what TablePage used to pass,
    // and what the engine websocket caused several times a second.
    const view = (
      <TournamentAnnouncementOverlay type="final_table" data={{}} onDismiss={() => dismissed()} />
    );
    const { rerender } = render(view);

    // 4 seconds of churn: 40 re-renders, each with a fresh callback identity.
    for (let i = 0; i < 40; i++) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender(
        <TournamentAnnouncementOverlay type="final_table" data={{}} onDismiss={() => dismissed()} />
      );
    }

    // The 4000ms auto-dismiss has fired; the 500ms fade-out follows it.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Before the fix this was 0: every re-render cleared the pending timer and
    // started a fresh full-length one, so it could never reach zero.
    expect(dismissed).toHaveBeenCalled();
  });

  it('stops calling back once the announcement is cleared', () => {
    vi.useFakeTimers();
    const dismissed = vi.fn();
    const { rerender } = render(
      <TournamentAnnouncementOverlay type="bubble_burst" data={{}} onDismiss={() => dismissed()} />
    );
    // Parent clears it early (the player's own tap, or a replacing event).
    rerender(<TournamentAnnouncementOverlay type={null} data={{}} onDismiss={() => dismissed()} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Both timers were cancelled — no late dismissal into whatever replaced it.
    expect(dismissed).not.toHaveBeenCalled();
  });

  it('depends on the announcement TYPE, never on the callback identity', () => {
    // The dependency array is the whole bug. Pin it.
    expect(OVERLAY).toContain('onDismissRef');
    expect(OVERLAY).not.toMatch(/\}, \[type, onDismiss\]\)/);
    expect(OVERLAY).toMatch(/\}, \[type\]\)/);
  });

  it('cancels BOTH timers in the effect cleanup, not just the outer one', () => {
    const effect = OVERLAY.slice(OVERLAY.indexOf('useEffect(() => {\n    if (!type)'));
    expect(effect).toContain('clearTimeout(dismissTimerRef.current)');
    expect(effect).toContain('clearTimeout(dismissCallbackTimerRef.current)');
  });

  it('resets `visible` when the announcement goes away', () => {
    expect(OVERLAY).toMatch(/if \(!type\) \{[\s\S]{0,400}setVisible\(false\)/);
  });

  it('memoises the modals layer and passes it a stable dismiss callback', () => {
    expect(MODALS_LAYER).toContain('React.memo(TableModalsLayerImpl)');
    expect(TABLE_PAGE).toContain('const handleDismissAnnouncement = useCallback(');
    expect(TABLE_PAGE).toContain('onDismissAnnouncement={handleDismissAnnouncement}');
    // The old inline arrow must be gone, or memo has nothing to hold on to.
    expect(TABLE_PAGE).not.toContain('onDismissAnnouncement={() => setAnnouncement(null)}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The missing "Wins The Pot" label
// ─────────────────────────────────────────────────────────────────────────────
describe('an uncontested win still names itself', () => {
  it('falls back to "Wins The Pot" when the payload carries no hand name', () => {
    // A fold-around win evaluates no hand, so `hand_name` is absent and the
    // label rendered empty on this branch.
    expect(TABLE_PAGE).toContain(
      "boardLabel.handName || (winnersArray.length > 0 ? 'Wins The Pot' : '')"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. data-hero-action — the published contract
// ─────────────────────────────────────────────────────────────────────────────
describe('data-hero-action is published on the table root', () => {
  it('sits on the same element as data-hero', () => {
    const rootAttrs = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('data-hero={tableState.players.some((p) => p?.isHero)'),
      TABLE_PAGE.indexOf('data-felt-theme=')
    );
    expect(rootAttrs).toContain('data-hero-action={heroActionState}');
  });

  it('carries exactly the three contracted values', () => {
    const memo = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'"),
      TABLE_PAGE.indexOf('return (\n    <div')
    );
    expect(memo).toContain("const heroActionState: 'none' | 'waiting' | 'active'");
    expect(memo).toContain("return 'active';");
    expect(memo).toContain("return 'waiting';");
    expect(memo).toContain("return 'none';");
    // No fourth value may creep in — the CSS keying on this cannot see it.
    const returned = Array.from(memo.matchAll(/return '([a-z]+)';/g)).map((m) => m[1]);
    expect(new Set(returned)).toEqual(new Set(['none', 'waiting', 'active']));
  });

  it('derives "active" from the same test that renders ActionPanel', () => {
    const memo = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'"),
      TABLE_PAGE.indexOf('return (\n    <div')
    );
    for (const clause of [
      'tableState.currentPlayerSeat === tableState.heroSeat',
      'tableState.isHandInProgress',
      '!dealInFlight',
    ]) {
      expect(memo).toContain(clause);
    }
  });

  it('treats an all-in hero as having no action, in the bar and in the attribute', () => {
    const memo = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'"),
      TABLE_PAGE.indexOf('return (\n    <div')
    );
    expect(memo).toContain("heroStatus !== 'all_in'");
    // PreActionBar must agree, or the attribute and the render contradict.
    const preAction = sliceEnclosingBlock(
      TABLE_PAGE,
      '{tableState.isHandInProgress &&\n              tableState.heroSeat > 0 &&'
    );
    expect(preAction).toContain(
      "getPlayerAtSeat(tableState.heroSeat)?.status !== 'all_in'"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Chat is a cash-game feature
// ─────────────────────────────────────────────────────────────────────────────
describe('table chat renders on cash tables only', () => {
  /* The three clauses live in ONE derived boolean since the voice mesh landed:
     the chat sheet, the seat bubbles and the microphone are three faces of the
     same permission, and three copies of one condition is three places for it
     to be edited apart. Pin the declaration, then pin that every consumer reads
     it rather than restating it. */
  const decl = TABLE_PAGE.slice(
    TABLE_PAGE.indexOf('const socialFeaturesAllowed ='),
    TABLE_PAGE.indexOf('const { speakingPlayerIds }')
  );

  it('excludes every tournament format (MTT, Spin, Sit-n-Go)', () => {
    // isTournament is `game_type === 'tournament' || !!tournament_id`, which is
    // true for all three.
    expect(decl).toContain('!tableState.isTournament');
  });

  it('excludes heads-up, cash included', () => {
    expect(decl).toContain('tableState.maxPlayers > 2');
  });

  it('still respects the text_message setting', () => {
    expect(decl).toContain('v8Settings.text_message');
  });

  it('gates the chat sheet on that one boolean, never a second copy of it', () => {
    expect(TABLE_PAGE).toContain('{socialFeaturesAllowed && (\n        <TableChat');
    expect(TABLE_PAGE).not.toContain(
      '{v8Settings.text_message && !tableState.isTournament && tableState.maxPlayers > 2 && ('
    );
  });

  it('gates the seat bubbles and the voice mesh on the same boolean', () => {
    expect(TABLE_PAGE).toContain('enabled: socialFeaturesAllowed && !isChatMuted,');
    expect(TABLE_PAGE).toContain('enabled: Boolean(socialFeaturesAllowed &&');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run It Twice — the reveal may not be cut short (Dan's headline bug)
// ─────────────────────────────────────────────────────────────────────────────
describe('a multi-board runout is always shown before the pot ships', () => {
  it('records when the whole reveal ends, not just the first ship moment', () => {
    expect(TABLE_PAGE).toContain('ritRevealEndsAtRef');
    expect(TABLE_PAGE).toContain('ritRevealEndsAtRef.current = nowTs + doneAt;');
  });

  it('holds the post-hand reset past the end of the reveal', () => {
    const hold = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('const ritRevealRemainingMs'),
      TABLE_PAGE.indexOf('handCompleteTimerRef.current = window.setTimeout')
    );
    expect(hold).toContain('const holdMs = Math.max(');
    expect(hold).toContain('ritRevealRemainingMs');
  });

  it('gives the hand boundary a floor instead of wiping the boards', () => {
    expect(TABLE_PAGE).toContain('RIT_BOUNDARY_ACK_MS');
    expect(TABLE_PAGE).toContain(
      'const revealStillRunning = ritRevealEndsAtRef.current > Date.now()'
    );
  });

  it('holds the pot ship when a multi-board run was agreed but rit_result has not landed', () => {
    expect(TABLE_PAGE).toContain('ritExpectedRunsRef');
    expect(TABLE_PAGE).toMatch(/else if \(ritExpectedRunsRef\.current > 1\)/);
  });

  it('never silently drops a rit_result it cannot present', () => {
    expect(TABLE_PAGE).toContain("'TablePage.rit_result_shape'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The ship-pot invariant
// ─────────────────────────────────────────────────────────────────────────────
describe('every awarded pot plays its animation', () => {
  it('states the invariant where the award is handled', () => {
    expect(TABLE_PAGE).toContain('EVERY completed action that awards a pot plays BOTH:');
  });

  it('slides the pot pill on split pots too', () => {
    // The old guard skipped the pill on every chop.
    expect(TABLE_PAGE).not.toContain(
      'if (winnerIds.length === 1) {\n            const soleSeatIdx'
    );
    expect(TABLE_PAGE).toContain('winnerPoints.length === 1');
  });

  it('animates a winner whose seat cannot be resolved instead of skipping them', () => {
    expect(TABLE_PAGE).toContain('UNSEATED_WINNER_PCT');
    expect(TABLE_PAGE).toContain("'TablePage.pot_win_unseated_winner'");
  });

  it('synthesises a fan when the award groups produce none', () => {
    expect(TABLE_PAGE).toContain("'TablePage.pot_win_no_award_groups'");
  });

  it('dates the safety sweep from when a fan actually started', () => {
    expect(TABLE_PAGE).toContain('chipAnimStartedAtRef');
    const sweep = sliceEnclosingBlock(
      TABLE_PAGE,
      '// Safety cleanup: remove chip animations older than 5 seconds'
    );
    expect(sweep).toContain('chipAnimStartedAtRef.current.get(a.id)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Rabbit Hunt timing
// ─────────────────────────────────────────────────────────────────────────────
describe('the Rabbit Hunt button is clickable in practice', () => {
  /**
   * REWRITTEN AT THE MERGE, 2026-08-27, and the reason is recorded rather than
   * quietly dropped.
   *
   * This spec used to assert that TableModalsLayer renders the button on
   * `{isRabbitAvailable && (` - the "appears late" half of Dan's note, aimed at
   * the gate `{!isHandInProgress && isRabbitAvailable && (` that lived there.
   * That render site NO LONGER EXISTS. #1327 (2026-08-26, "one HUD slot") moved
   * Rabbit Hunt out of the modals layer, dropped its four forwarding props, and
   * put it in the bottom-left HUD slot in TablePage that it now shares with the
   * time-bank tile. The two are kept from ever occupying that slot together by
   * `!tableState.isHandInProgress`, which
   * tests/all-in-cannot-leave-and-the-hud-slot.test.ts pins verbatim.
   *
   * Removing that guard to gain one snapshot of earliness would put two
   * controls in one slot, and that is a decision about the slot rather than
   * something a merge is entitled to take. So what is asserted here is what is
   * true after the move: the modals layer is out of the rabbit business
   * entirely. The other half of Dan's note - the two-second floor - is real,
   * shipped, and covered by the spec below, and it buys the click window back
   * from the far end.
   */
  it('no longer renders from the modals layer at all', () => {
    expect(MODALS_LAYER).not.toContain('<RabbitHunt');
    expect(MODALS_LAYER).not.toContain('isRabbitAvailable');
  });

  it("guarantees Dan's two full seconds on screen", () => {
    expect(TABLE_PAGE).toContain('const RABBIT_MIN_VISIBLE_MS = 2000;');
    expect(TABLE_PAGE).toContain('rabbitShownAtRef');
    expect(TABLE_PAGE).toContain('shownFor >= RABBIT_MIN_VISIBLE_MS');
  });

  it('never outlives the server TTL — expiry forces the drop', () => {
    const expiry = sliceEnclosingBlock(TABLE_PAGE, 'const msLeft = Math.max(0, Math.min(');
    expect(expiry).toContain('clearRabbitOffer(true)');
  });
});
