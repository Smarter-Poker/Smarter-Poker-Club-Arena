/**
 * LIGHTNING TRANSITION, PHASE 1: WHAT A PLAYER SEES BETWEEN LIGHTNING HANDS.
 *
 * A read-only review on 2026-10-26 found eight things wrong with the screen a
 * Lightning player looks at between folding and being dealt the next hand.
 * Each describe block below is one of them, and each would have failed on the
 * code the review read:
 *
 *   1. "Next Hand...", "Lightning Is Ending" and the ended notice (VIEW GAME)
 *      lived in a footer branch the between-hands bar shadowed, centred in
 *      the fixed bar instead of on the felt;
 *   2. on a phone the table switched to the spectator layout on every fold
 *      (the roster is empty between hands) and back on every deal;
 *   3. the folded hand's board stayed on the felt for the whole wait;
 *   4. every open chair showed an EMPTY coin for the whole wait;
 *   5. the hero's waiting chair lost their table alias, frame and aura;
 *   6. the urgency outlines were amber and red, outside the palette;
 *   7. "Next Hand..." waited 2.5 s and appeared and vanished in one frame;
 *   8. "Lightning Is Ending" could stick, and promised "After This Hand".
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/lightning/LightningSessionSummary', () => ({
  LightningSessionSummaryCard: () => null,
}));

import SeatSlot from '../../src/components/table/SeatSlot';
import LightningNextHand from '../../src/components/table/LightningNextHand';
import LightningEndingNotice from '../../src/components/table/LightningEndingNotice';
import LightningEndedNotice from '../../src/components/table/LightningEndedNotice';
import {
  LIGHTNING_ENDING_TEXT,
  LIGHTNING_NEXT_HAND_FADE_MS,
  LIGHTNING_NEXT_HAND_NOTICE_MS,
  LIGHTNING_NEXT_HAND_TEXT,
  lightningSnapshotClearsBoard,
} from '../../src/lightning/lightningHand';
import {
  clearLightningClusterStatus,
  lightningClusterStatus,
  noteLightningUserEvent,
  resetLightningClusterStatusForTests,
} from '../../src/lightning/lightningDecisionQueue';
import {
  registerLightningPoolSession,
  resetLightningRegistryForTests,
  type LightningClusterMeta,
} from '../../src/lightning/lightningSession';
import { heroIsAtTable, lightningStandInIdentity } from '../../src/lightning/lightningWaitingHero';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PAGE = read('src/pages/TablePage.tsx');
const PAGE_CSS = read('src/pages/TablePage.css');
const FOLD_CSS = read('src/components/table/LightningFoldBar.css');
const SESSION_CSS = read('src/components/lightning/LightningSession.css');

const CLUSTER = '11111111-1111-4111-8111-111111111111';
const POOL_A = '22222222-2222-4222-8222-222222222222';
const POOL_B = '33333333-3333-4333-8333-333333333333';
const POOL_C = '44444444-4444-4444-8444-444444444444';

/** The engine's idle shape after a fold (LightningHandHost.idleShape), trimmed. */
const IDLE_AFTER_FOLD = {
  table_id: POOL_A,
  hand_id: null,
  hand_number: 41,
  stage: 'waiting',
  community_cards: [],
  players: [],
  lightning: { hand_id: null, cluster_id: CLUSTER, fast_fold_available: false },
};
const LIVE_HAND = {
  table_id: POOL_A,
  hand_id: 'hand-41',
  hand_number: 41,
  stage: 'flop',
  players: [{ user_id: 'me', seat: 3 }],
  lightning: { hand_id: 'hand-41', cluster_id: CLUSTER },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── 1. The notices live on the felt ─────────────────────────────────────────

describe('1. the Lightning notices are felt-level, so they show between hands', () => {
  /** The footer chain: from the action wrapper to the end of its branch list. */
  const footer = PAGE.slice(
    PAGE.indexOf('<div className="action-panel-wrapper">'),
    PAGE.indexOf('{/* ─── ACTION PANEL — Premium 3-button layout ─── */}')
  );

  it('no Lightning notice is mounted in the footer chain the between-hands bar shadows', () => {
    expect(footer).toContain('data-state="lightning-between-hands"');
    expect(footer).not.toContain('<LightningNextHand');
    expect(footer).not.toContain('<LightningEndingNotice');
    expect(footer).not.toContain('lightningReversion.seatTableId ? (');
    expect(footer).not.toContain('lightningSessionEnd.ended ? (');
  });

  it('"Next Hand..." and "Lightning Is Ending" are one layer inside the felt surface', () => {
    const surface = PAGE.indexOf('<div className="table-surface">');
    const layer = PAGE.indexOf('className="lightning-felt-notices"');
    const board = PAGE.indexOf('<div className="community-area">');
    expect(surface).toBeGreaterThan(-1);
    expect(layer).toBeGreaterThan(surface);
    expect(layer).toBeLessThan(board);
    const block = sliceEnclosingBlock(PAGE, 'className="lightning-felt-notices"');
    expect(block).toContain('handInProgress={lightningHandLive && tableState.isHandInProgress}');
    expect(block).toContain('<LightningEndingNotice clusterId={lightningRoom.clusterId} />');
  });

  it('the ended notices sit over the table area, after the seats, outside the footer', () => {
    const container = PAGE.indexOf('<div className="table-container">');
    const wrapper = PAGE.indexOf('<div className="action-panel-wrapper">');
    for (const needle of [
      'lightningRoom && lightningReversion.seatTableId ? (',
      'lightningRoom && !lightningReversion.seatTableId && lightningSessionEnd.ended ? (',
    ]) {
      const at = PAGE.indexOf(needle);
      expect(at, needle).toBeGreaterThan(container);
      expect(at, needle).toBeLessThan(wrapper);
    }
    // Law 10.6 still: the only return navigations are the two VIEW GAME presses.
    expect(PAGE.split('navigate(lightningReturnPath(').length - 1).toBe(2);
  });

  it('the felt layer is placed in felt coordinates, not centred in the fixed bar', () => {
    const rule = FOLD_CSS.slice(FOLD_CSS.indexOf('.lightning-felt-notices {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain(
      'top: calc(var(--sp-brand-top, 56%) - 0.5%)'
    );
    // The old rule centred the line inside whatever held it: the fixed bar.
    expect(FOLD_CSS).not.toMatch(/\.lightning-next-hand \{[^}]*top: 50%/);
    // The ended overlay keeps its content clear of the fixed action bar.
    const ended = FOLD_CSS.slice(FOLD_CSS.indexOf('.lightning-ended {'));
    expect(ended.slice(0, ended.indexOf('}'))).toContain('var(--sp-table-bottom, 0px)');
  });

  it('VIEW GAME is a real button that calls back, wherever the notice is mounted', () => {
    const onViewGame = vi.fn();
    render(<LightningEndedNotice onViewGame={onViewGame} />);
    fireEvent.click(screen.getByTestId('lightning-ended-view-game'));
    expect(onViewGame).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. The phone layout does not flip on every fold ────────────────────────

describe('2. in a Lightning room the hero is at the table between hands', () => {
  it('Classic: the roster alone decides, exactly as before', () => {
    expect(heroIsAtTable({ heroInRoster: true, lightningRoom: false, heroSeat: 3 })).toBe(true);
    expect(heroIsAtTable({ heroInRoster: false, lightningRoom: false, heroSeat: 3 })).toBe(false);
    expect(heroIsAtTable({ heroInRoster: false, lightningRoom: false, heroSeat: 0 })).toBe(false);
  });

  it('Lightning: the empty idle roster with the hero still holding a chair is the hero at the table', () => {
    // In a hand.
    expect(heroIsAtTable({ heroInRoster: true, lightningRoom: true, heroSeat: 3 })).toBe(true);
    // Between hands: the idle snapshot carries no players.
    expect(heroIsAtTable({ heroInRoster: false, lightningRoom: true, heroSeat: 3 })).toBe(true);
    // A Lightning room the player holds no chair in is still watched as a spectator.
    expect(heroIsAtTable({ heroInRoster: false, lightningRoom: true, heroSeat: 0 })).toBe(false);
  });

  it('a fold and the next deal give the same answer, so the felt keeps its shape', () => {
    const inHand = heroIsAtTable({ heroInRoster: true, lightningRoom: true, heroSeat: 3 });
    const afterFold = heroIsAtTable({ heroInRoster: false, lightningRoom: true, heroSeat: 3 });
    expect(afterFold).toBe(inHand);
  });

  it('every shape decision on the page reads the one answer', () => {
    expect(PAGE).toMatch(
      /const heroAtTable = heroIsAtTable\(\{\s*heroInRoster: tableState\.players\.some\(\(p\) => p\?\.isHero\),\s*lightningRoom: !!lightningRoom,\s*heroSeat: tableState\.heroSeat,\s*\}\);/
    );
    expect(PAGE).toContain('const tablePerspectiveTaper = heroAtTable ? undefined : 0;');
    expect(PAGE).toContain("data-hero={heroAtTable ? 'true' : 'false'}");
    expect(PAGE).toContain('isSpectator: !heroAtTable,');
    // The spectator layout, the dealer button and the protected cards all read data-hero.
    expect(PAGE_CSS).toContain(".table-page[data-hero='false'] .table-scaler");
    expect(read('src/components/table/DealerButton.tsx')).toContain("getAttribute('data-hero')");
    expect(read('src/hooks/useProtectedCardLayout.ts')).toContain("getAttribute('data-hero')");
  });
});

// ─── 3. The folded hand's board leaves the felt ─────────────────────────────

describe("3. an idle snapshot ends the folded hand's board in a Lightning room", () => {
  it('the idle shape after a fold clears the board, though it repeats the hand number', () => {
    expect(IDLE_AFTER_FOLD.hand_number).toBe(LIVE_HAND.hand_number);
    expect(lightningSnapshotClearsBoard({ lightningRoom: true, snapshot: IDLE_AFTER_FOLD })).toBe(
      true
    );
  });

  it('a live hand never clears its own board', () => {
    expect(lightningSnapshotClearsBoard({ lightningRoom: true, snapshot: LIVE_HAND })).toBe(false);
  });

  it('a Classic table is never affected, even by a waiting snapshot', () => {
    expect(lightningSnapshotClearsBoard({ lightningRoom: false, snapshot: IDLE_AFTER_FOLD })).toBe(
      false
    );
  });

  it('the snapshot merge lifts the never-shrink rule and clears through the reset shape', () => {
    const at = PAGE.indexOf('const lightningIdleBoard = lightningSnapshotClearsBoard({');
    expect(at).toBeGreaterThan(-1);
    const merge = PAGE.slice(at, PAGE.indexOf('const nextBets =', at));
    expect(merge).toMatch(/const sameHand =\s*!lightningIdleBoard && mapped\.handNumber > 0/);
    expect(merge).toMatch(
      /if \(lightningIdleBoard\) \{\s*nextCards = \[\];\s*nextCards2 = \[\];\s*nextCards3 = \[\];\s*\}/
    );
    // The stage goes back to preflop exactly as the end-of-hand reset sets it,
    // so CommunityCards takes the clear down its existing path and the next
    // flop deals in with its full animation.
    expect(merge).toContain("(lightningIdleBoard ? 'preflop' : mapped.boardStage)");
    const reset = sliceEnclosingBlock(PAGE, 'handCompleteResetFnRef.current = () => {');
    expect(reset).toMatch(/communityCards: \[\],[\s\S]*boardStage: 'preflop'/);
  });
});

// ─── 4. Empty chairs draw nothing in a Lightning room ──────────────────────

describe('4. an empty chair in a Lightning room draws nothing; Classic keeps EMPTY', () => {
  it('Classic: an empty seat the player cannot take is the EMPTY coin', () => {
    const { container } = render(
      <SeatSlot seatNumber={4} player={null} position={null} isActive={false} canSit={false} />
    );
    expect(container.querySelector('.seat__empty-img')).not.toBeNull();
    expect(screen.getByAltText('Empty Seat')).toBeTruthy();
  });

  it('Lightning: the same empty seat draws nothing, and keeps its seat number', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={4}
        player={null}
        position={null}
        isActive={false}
        canSit={false}
        hideEmptyChair
      />
    );
    expect(container.querySelector('.seat__empty-img')).toBeNull();
    expect(container.textContent).toBe('');
    const slot = container.querySelector('[data-seat-num="4"]');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
  });

  it("the hero's own reserved chair is never hidden", () => {
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={null}
        position={null}
        isActive={false}
        canSit={false}
        isHeroReservedSeat
        hideEmptyChair
      />
    );
    expect(screen.getByAltText('Your Reserved Seat')).toBeTruthy();
    expect(container.querySelector('.seat--empty-hidden')).toBeNull();
  });

  it('only a Lightning room passes it', () => {
    expect(PAGE).toContain('hideEmptyChair={!!lightningRoom}');
    expect(PAGE.match(/hideEmptyChair=/g)).toHaveLength(1);
  });
});

// ─── 5. The waiting chair keeps the hero's face ─────────────────────────────

describe("5. the hero's waiting chair keeps their alias, frame and aura", () => {
  const lastRow = {
    name: 'RiverRat',
    avatar: '/avatars/table/free_shark.webp',
    frame: 'frame-gold',
    aura: 'aura-fire',
  };

  it('carries the frame and aura from the last roster row', () => {
    const id = lightningStandInIdentity({
      tableAlias: null,
      profileName: 'RiverRat',
      lastRow,
      username: 'dan_b',
      avatarUrl: '/avatars/table/free_shark.webp',
    });
    expect(id).toEqual({
      name: 'RiverRat',
      avatar: '/avatars/table/free_shark.webp',
      frame: 'frame-gold',
      aura: 'aura-fire',
    });
  });

  it('wears the table alias when the player chose one, as the seat in a hand does', () => {
    expect(
      lightningStandInIdentity({
        tableAlias: 'The Closer',
        profileName: 'RiverRat',
        lastRow,
        username: 'dan_b',
        avatarUrl: '',
      }).name
    ).toBe('The Closer');
  });

  it('falls back to the last row, then the username, never to nothing', () => {
    expect(
      lightningStandInIdentity({
        tableAlias: '',
        profileName: null,
        lastRow,
        username: 'dan_b',
        avatarUrl: null,
      })
    ).toMatchObject({ name: 'RiverRat', avatar: lastRow.avatar });
    expect(
      lightningStandInIdentity({
        tableAlias: null,
        profileName: null,
        lastRow: null,
        username: null,
        avatarUrl: null,
      })
    ).toEqual({ name: 'You', avatar: '' });
  });

  it('the page feeds it the alias rule, the profile name and the last roster row', () => {
    const block = sliceEnclosingBlock(PAGE, 'const lightningStandIn = lightningRoom');
    expect(block).toContain('tableAlias: v8Settings.use_alias ? v8Settings.table_alias : null');
    expect(block).toContain('lastRow: lightningLastHeroRowRef.current');
    expect(PAGE).toMatch(
      /if \(lightningHeroInRoster\) \{\s*lightningLastHeroRowRef\.current = \{[\s\S]{0,200}frame: lightningHeroInRoster\.frame,\s*aura: lightningHeroInRoster\.aura,/
    );
  });
});

// ─── 6. Urgency in the house palette ────────────────────────────────────────

describe('6. Lightning urgency is said in blue, teal and silver', () => {
  const code = SESSION_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const at = code.indexOf(`${sel} {`);
    return code.slice(at, code.indexOf('}', at));
  };

  it('no urgency step is amber or red', () => {
    for (const sel of [
      '.lightning-urgent--normal',
      '.lightning-urgent--high',
      '.lightning-urgent--critical',
      '.lightning-queue__item--high',
      '.lightning-queue__item--critical',
    ]) {
      const r = rule(sel);
      expect(r, sel).not.toMatch(/#ffb547|#ff5a5a|255,\s*181,\s*71|255,\s*90,\s*90/i);
    }
  });

  it('each step is heavier than the last, so urgency reads by width and brightness', () => {
    const width = (sel: string) => Number(/outline:\s*(\d+)px/.exec(rule(sel))?.[1] ?? 0);
    expect(width('.lightning-urgent--normal')).toBeLessThan(width('.lightning-urgent--high'));
    expect(width('.lightning-urgent--high')).toBeLessThan(width('.lightning-urgent--critical'));
    expect(rule('.lightning-urgent--high')).toContain('var(--info-cyan, #00d4ff)');
    expect(rule('.lightning-urgent--critical')).toContain('#e4e7ec');
  });
});

// ─── 7. "Next Hand..." sooner, with a fade ─────────────────────────────────

describe('7. "Next Hand..." after 1.2 s, fading in and out, in the same words', () => {
  it('waits 1200 ms and says exactly "Next Hand..."', () => {
    expect(LIGHTNING_NEXT_HAND_NOTICE_MS).toBe(1200);
    expect(LIGHTNING_NEXT_HAND_TEXT).toBe('Next Hand...');
  });

  it('a completed winner waits for the next deal even while its last snapshot retains the hand', async () => {
    vi.useFakeTimers();
    // The completed hand can remain the latest snapshot until another deal.
    // Its result hold is still playing, so an in-progress roster alone must
    // not start a waiting notice before the existing completion latch fires.
    const { rerender } = render(<LightningNextHand handInProgress handComplete={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();

    rerender(<LightningNextHand handInProgress handComplete />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_NOTICE_MS - 1);
    });
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const notice = screen.getByTestId('lightning-next-hand');
    expect(notice.textContent).toBe('Next Hand...');

    // The next hand has its own completion identity; its full fade is kept.
    rerender(<LightningNextHand handInProgress handComplete={false} />);
    expect(notice.getAttribute('data-leaving')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_FADE_MS + 1);
    });
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
  });

  it('the completed winner notice uses the hand-bound latch after the full award hold', () => {
    const block = sliceEnclosingBlock(PAGE, 'className="lightning-felt-notices"');
    expect(block).toContain('handComplete={tableHandIsOver}');
    const reset = sliceEnclosingBlock(PAGE, 'handCompleteResetFnRef.current = () => {');
    expect(reset).toContain(
      'setFinishedHand({ handNumber: completedHandNumber, heroSig: completedHeroSig })'
    );
  });

  it('appears after the threshold and fades out when the next deal starts', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<LightningNextHand handInProgress={false} />);
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_NOTICE_MS + 10);
    });
    const line = screen.getByTestId('lightning-next-hand');
    expect(line.textContent).toBe('Next Hand...');
    expect(line.getAttribute('data-leaving')).toBeNull();

    // The deal: the same line stays for the fade, marked leaving.
    rerender(<LightningNextHand handInProgress />);
    const leaving = screen.getByTestId('lightning-next-hand');
    expect(leaving).toBe(line);
    expect(leaving.getAttribute('data-leaving')).toBe('true');
    expect(leaving.textContent).toBe('Next Hand...');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_FADE_MS + 10);
    });
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
  });

  it('a short gap that never showed the line leaves nothing behind at the deal', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<LightningNextHand handInProgress={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_NOTICE_MS - 200);
    });
    rerender(<LightningNextHand handInProgress />);
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
  });

  it('both fades scale with Animation Speed; reduced motion is the global collapse', () => {
    expect(FOLD_CSS).toContain(
      'animation: lightningNextHandIn calc(240ms * var(--animation-speed, 1)) ease-out both;'
    );
    expect(FOLD_CSS).toContain(
      'animation: lightningNextHandOut calc(240ms * var(--animation-speed, 1)) ease-in both;'
    );
    expect(LIGHTNING_NEXT_HAND_FADE_MS).toBe(240);
    // No per-component switch-off: reducedMotion.css collapses it to 1ms.
    expect(FOLD_CSS).not.toMatch(/\.lightning-next-hand[^{]*\{[^}]*animation:\s*none/);
  });
});

// ─── 8. "Lightning Is Ending" cannot stick ─────────────────────────────────

describe('8. "Lightning Is Ending" says what is true and cannot outlive its room', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetLightningRegistryForTests();
    resetLightningClusterStatusForTests();
  });

  const ending = () =>
    noteLightningUserEvent({
      type: 'lightning_cluster_status',
      cluster_id: CLUSTER,
      status: 'ending',
    });

  it('the words: Title Case, no dashes, no promise about this hand', () => {
    expect(LIGHTNING_ENDING_TEXT).toBe('Lightning Is Ending. Your Seat Is Kept.');
    expect(LIGHTNING_ENDING_TEXT).not.toMatch(/[—–-]/);
    expect(LIGHTNING_ENDING_TEXT).not.toMatch(/After This Hand/i);
  });

  it('a closed room clears its Cluster, and the line goes', () => {
    render(<LightningEndingNotice clusterId={CLUSTER} />);
    act(() => {
      ending();
    });
    expect(screen.getByTestId('lightning-ending').textContent).toBe(LIGHTNING_ENDING_TEXT);
    act(() => clearLightningClusterStatus(CLUSTER));
    expect(lightningClusterStatus(CLUSTER)).toBeNull();
    expect(screen.queryByTestId('lightning-ending')).toBeNull();
  });

  it("a new pool-session room for the Cluster starts without the old room's status", () => {
    registerLightningPoolSession({ poolSessionId: POOL_A, clusterId: CLUSTER, meta: null });
    ending();
    expect(lightningClusterStatus(CLUSTER)).toBe('ending');
    // Re-registering the SAME room (its metadata arriving) keeps what it was told.
    registerLightningPoolSession({
      poolSessionId: POOL_A,
      clusterId: CLUSTER,
      meta: {
        clusterId: CLUSTER,
        clubId: null,
        name: 'NLH',
        variant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        maxPlayers: 6,
      } as LightningClusterMeta,
    });
    expect(lightningClusterStatus(CLUSTER)).toBe('ending');
    // A new room for the Cluster clears it.
    registerLightningPoolSession({ poolSessionId: POOL_B, clusterId: CLUSTER, meta: null });
    expect(lightningClusterStatus(CLUSTER)).toBeNull();
    // A room learned from its own (already connected) snapshot keeps a fresh status.
    ending();
    registerLightningPoolSession(
      { poolSessionId: POOL_C, clusterId: CLUSTER, meta: null },
      { keepClusterStatus: true }
    );
    expect(lightningClusterStatus(CLUSTER)).toBe('ending');
    expect(PAGE).toMatch(/\{ keepClusterStatus: true \}/);
  });

  it('the room clears it when it closes (4404 confirmed by reversion or session end)', () => {
    expect(PAGE).toMatch(
      /const lightningRoomClosed = !!lightningReversion\.seatTableId \|\| !!lightningSessionEnd\.ended;/
    );
    expect(PAGE).toMatch(
      /if \(lightningRoomClosed && lightningClosedClusterId\) \{\s*clearLightningClusterStatus\(lightningClosedClusterId\);/
    );
  });
});
