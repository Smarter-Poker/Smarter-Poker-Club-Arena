/**
 * LIGHTNING TRANSITION, PHASE 3: SMOOTHER MOTION BETWEEN LIGHTNING HANDS.
 *
 * The 2026-10-26 review traced six places where the move from one Lightning
 * hand to the next cut an animation short or put something on screen in the
 * wrong order. Each describe block below is one of them:
 *
 *   1. the hero's cards were wiped one frame into their flight to the muck,
 *      and every opponent and the board vanished in the same frame;
 *   2. the hero sat in the wrong chair for one frame when a new hand seated
 *      them somewhere else;
 *   3. LIGHTNING FOLD waited a full round trip for its cue and its muck;
 *   4. the hero's cards showed (with their slide cue) before the deal, then
 *      blinked out when the deal restarted them;
 *   5. the dealer button disappeared between hands, so the button beat had
 *      nothing to move;
 *   6. a new opponent's portrait faded in empty and popped in after, and a
 *      player met before who changed chair got no fade at all; and hole cards
 *      that beat the hero's roster row were dropped.
 *
 * Classic tables take none of these branches.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';
import { nextSeatArrivals, useSeatArrivals } from '../../src/components/table/seatArrival';
import {
  LIGHTNING_EXIT_HOLD_BASE_MS,
  lightningEarlyHeroCardsReady,
  lightningExitHoldMs,
  lightningHeroSeatFromRoster,
  lightningHoldsHeroDealSound,
  lightningParkedDealerSeat,
} from '../../src/lightning/lightningTransitionMotion';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PAGE = read('src/pages/TablePage.tsx');
const SEAT = read('src/components/table/SeatSlot.tsx');

const player = (id: string, isHero = false, avatar?: string): SeatPlayer => ({
  id,
  name: id,
  stack: 100,
  status: 'active',
  isHero,
  ...(avatar ? { avatar } : {}),
  holeCards: [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 'c' },
  ],
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('1. the folded hand leaves the felt, it does not vanish', () => {
  it('holds an idle snapshot for one fold window, scaled by Animation Speed', () => {
    const base = { lightningRoom: true, observer: false, snapshotIdle: true, feltPlayers: 6 };
    expect(LIGHTNING_EXIT_HOLD_BASE_MS).toBe(500);
    expect(lightningExitHoldMs({ ...base, speed: 1 })).toBe(500);
    expect(lightningExitHoldMs({ ...base, speed: 1.5 })).toBe(750);
    expect(lightningExitHoldMs({ ...base, speed: 0 })).toBe(500);
  });

  it('never holds at a Classic table, for an observer, a live snapshot or an empty felt', () => {
    const base = {
      lightningRoom: true,
      observer: false,
      snapshotIdle: true,
      feltPlayers: 6,
      speed: 1,
    };
    expect(lightningExitHoldMs({ ...base, lightningRoom: false })).toBe(0);
    expect(lightningExitHoldMs({ ...base, observer: true })).toBe(0);
    expect(lightningExitHoldMs({ ...base, snapshotIdle: false })).toBe(0);
    expect(lightningExitHoldMs({ ...base, feltPlayers: 0 })).toBe(0);
  });

  it('matches the fold window SeatSlot gives the cards to reach the muck', () => {
    expect(SEAT).toMatch(
      /setTimeout\(\(\) => setIsFolding\(false\), 500 \* getAnimationSpeed\(\)\)/
    );
  });

  it('the snapshot apply waits on the hold, re-runs when it ends, and a hand ends it at once', () => {
    const start = PAGE.indexOf('if (!USE_ENGINE_WS) return;\n    if (!engineSnapshot) return;');
    expect(start).toBeGreaterThan(0);
    const head = PAGE.slice(start, PAGE.indexOf('THE FLOOR IS READ FROM THE REF', start));
    expect(head).toContain('isLightningIdleSnapshot(engineSnapshot as LightningSnapshotFields)');
    expect(head).toContain('lightningExitHoldMs({');
    expect(head).toMatch(/if \(!idle\) \{\s*if \(lightningExitHoldRef\.current\) \{/);
    expect(head).toMatch(/setTimeout\(\(\) => setLightningExitTick\(\(n\) => n \+ 1\), wait\)/);
    expect(head).toContain('return () => clearTimeout(timer);');
    expect(PAGE).toContain(
      '}, [engineSnapshot, USE_ENGINE_WS, userId, tableId, lightningExitTick]);'
    );
  });

  it('the felt is marked as leaving in a Lightning room only, and the CSS fades opponents and board', () => {
    expect(PAGE).toContain(
      "data-lightning-exit={lightningRoom && lightningExitMs > 0 ? 'true' : undefined}"
    );
    const css = read('src/components/table/LightningFoldBar.css');
    expect(css).toMatch(
      /\.table-page\[data-lightning-exit='true'\] \.seat:not\(\.seat--hero\),\s*\.table-page\[data-lightning-exit='true'\] \.community-cards \{\s*animation: lightningFeltExit calc\(0\.5s \* var\(--animation-speed, 1\)\)/
    );
    expect(css).toMatch(
      /@keyframes lightningFeltExit \{\s*from \{\s*opacity: 1;\s*\}\s*to \{\s*opacity: 0;/
    );
  });
});

describe('2. the hero changes chair in the same update as the roster', () => {
  const players = [player('a'), null, player('hero', true), player('b')];

  it('reads the chair from the incoming roster in a Lightning room', () => {
    expect(
      lightningHeroSeatFromRoster({
        lightningRoom: true,
        observer: false,
        leaving: false,
        userId: 'hero',
        players,
      })
    ).toBe(3);
  });

  it('adopts nothing at a Classic table, for an observer, a leaver, a guest or an absent hero', () => {
    const base = { lightningRoom: true, observer: false, leaving: false, userId: 'hero', players };
    expect(lightningHeroSeatFromRoster({ ...base, lightningRoom: false })).toBe(0);
    expect(lightningHeroSeatFromRoster({ ...base, observer: true })).toBe(0);
    expect(lightningHeroSeatFromRoster({ ...base, leaving: true })).toBe(0);
    expect(lightningHeroSeatFromRoster({ ...base, userId: 'guest' })).toBe(0);
    expect(lightningHeroSeatFromRoster({ ...base, userId: 'nobody' })).toBe(0);
  });

  it('the snapshot apply writes heroSeat beside the roster it came from', () => {
    expect(PAGE).toMatch(
      /const lightningHeroSeat = lightningHeroSeatFromRoster\(\{\s*lightningRoom: !!lightningRoomRef\.current,\s*observer: lightningObserver,\s*leaving: leftSeatPendingRef\.current,\s*userId,\s*players: nextPlayers,/
    );
    expect(PAGE).toMatch(
      /\.\.\.\(lightningHeroSeat > 0 && lightningHeroSeat !== prev\.heroSeat\s*\? \{ heroSeat: lightningHeroSeat \}\s*: \{\}\),/
    );
  });
});

describe('3. LIGHTNING FOLD answers the press', () => {
  const start = PAGE.indexOf('const handleLightningFold = useCallback(');
  const handler = PAGE.slice(start, PAGE.indexOf('lightningHotkeysRef.current =', start));

  it('plays the cue and starts the muck before the request, and puts the hand back on a refusal', () => {
    const cue = handler.indexOf('soundService.playFold();');
    const optimistic = handler.indexOf("applyOptimisticHeroAction('fold')");
    const send = handler.indexOf('await sendLightningFold(');
    expect(cue).toBeGreaterThan(0);
    expect(optimistic).toBeGreaterThan(cue);
    expect(send).toBeGreaterThan(optimistic);
    expect(handler).toMatch(/if \(!result\.success\) \{\s*revert\(\);\s*toast\.warning/);
    expect(handler).toMatch(/catch \(err\) \{\s*revert\(\);\s*throw err;/);
  });

  it('a press on no live hand plays nothing and changes nothing', () => {
    expect(handler).toContain('const pressAnswered = !!lightningFoldHandId;');
    expect(handler).toContain(
      "const revert = pressAnswered ? applyOptimisticHeroAction('fold') : () => {};"
    );
  });

  it('the queued off-turn preflop fold still arms the pre-action and sends nothing', () => {
    const queued = handler.slice(0, handler.indexOf('lightningFoldBusyRef.current = true;'));
    expect(queued).toContain("setPreAction('fold');");
    expect(queued).not.toContain('playFold');
  });
});

describe('4. cards arrive with the deal, and the slide cue follows it', () => {
  it('holds the hero cue only for a scheduled deal that has not landed, in a Lightning room', () => {
    const base = { lightningRoom: true, hand: 7, presentedHand: 7, settledHand: 6 };
    expect(lightningHoldsHeroDealSound(base)).toBe(true);
    expect(lightningHoldsHeroDealSound({ ...base, settledHand: 7 })).toBe(false);
    expect(lightningHoldsHeroDealSound({ ...base, presentedHand: 6 })).toBe(false);
    expect(lightningHoldsHeroDealSound({ ...base, lightningRoom: false })).toBe(false);
    expect(lightningHoldsHeroDealSound({ ...base, hand: 0 })).toBe(false);
  });

  it('a held cue is played when the deal lands, or when the deal hold expires', () => {
    expect(PAGE).toMatch(
      /onComplete=\{\(\) => \{\s*setDealAnimationKey\(0\);\s*endDealHold\(\);\s*settleHeroDealSound\(dealPresentationHandRef\.current\);/
    );
    expect(PAGE).toContain('settleHeroDealSoundRef.current?.(heldHeroDealSoundRef.current);');
    const settle = PAGE.slice(
      PAGE.indexOf('const settleHeroDealSound = useCallback('),
      PAGE.indexOf('settleHeroDealSoundRef.current = settleHeroDealSound;')
    );
    expect(settle).toContain('soundService.playDeal()');
  });

  it('the seats hide their cards for the button beat only, with a ceiling', () => {
    expect(PAGE).toContain('dealPending={!!lightningRoom && lightningDealPending}');
    expect(PAGE).toMatch(
      /if \(lightningRoomRef\.current\) \{\s*setLightningDealPending\(true\);[\s\S]{0,400}\}, beatMs \+ 400\);/
    );
    expect(PAGE).toMatch(/setIsSeatDealing\(true\);\s*setLightningDealPending\(false\);/);
    expect(read('src/components/table/SeatSlot.css')).toMatch(
      /\.seat__cards--deal-pending \.seat__card \{\s*opacity: 0;\s*\}/
    );
  });

  it('SeatSlot marks both card rows while the deal is pending, never once it is dealing', () => {
    const { container, rerender } = render(
      <>
        <SeatSlot
          seatNumber={1}
          player={player('hero', true)}
          position={null}
          isActive={false}
          lastAction={null}
          dealPending
        />
        <SeatSlot
          seatNumber={2}
          player={player('villain')}
          position={null}
          isActive={false}
          lastAction={null}
          dealPending
        />
      </>
    );
    expect(container.querySelectorAll('.seat__cards--deal-pending')).toHaveLength(2);
    rerender(
      <>
        <SeatSlot
          seatNumber={1}
          player={player('hero', true)}
          position={null}
          isActive={false}
          lastAction={null}
          dealPending
          isDealing
        />
        <SeatSlot
          seatNumber={2}
          player={player('villain')}
          position={null}
          isActive={false}
          lastAction={null}
          dealPending
          isDealing
        />
      </>
    );
    expect(container.querySelectorAll('.seat__cards--deal-pending')).toHaveLength(0);
    expect(container.querySelectorAll('.seat__cards--dealing')).toHaveLength(2);
  });

  it('a Classic seat (no dealPending) is never marked', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={1}
        player={player('hero', true)}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    expect(container.querySelectorAll('.seat__cards--deal-pending')).toHaveLength(0);
  });
});

describe('5. the dealer button stays parked between hands', () => {
  it('keeps the last seat for an idle snapshot in a Lightning room', () => {
    expect(
      lightningParkedDealerSeat({
        lightningRoom: true,
        snapshotIdle: true,
        incoming: 0,
        previous: 4,
      })
    ).toBe(4);
  });

  it('follows the engine everywhere else', () => {
    expect(
      lightningParkedDealerSeat({
        lightningRoom: false,
        snapshotIdle: true,
        incoming: 0,
        previous: 4,
      })
    ).toBe(0);
    expect(
      lightningParkedDealerSeat({
        lightningRoom: true,
        snapshotIdle: false,
        incoming: 0,
        previous: 4,
      })
    ).toBe(0);
    expect(
      lightningParkedDealerSeat({
        lightningRoom: true,
        snapshotIdle: true,
        incoming: 2,
        previous: 4,
      })
    ).toBe(2);
  });

  it('the snapshot apply routes dealerSeat through it', () => {
    expect(PAGE).toMatch(
      /dealerSeat: lightningParkedDealerSeat\(\{\s*lightningRoom: !!lightningRoomRef\.current,\s*snapshotIdle: lightningIdleBoard,\s*incoming: mapped\.dealerSeat,\s*previous: prev\.dealerSeat,/
    );
  });
});

describe('6. new faces arrive painted, a moved face arrives too, early cards are kept', () => {
  it('a player met before who is dealt in at another chair arrives there', () => {
    const empty = { scope: '', signature: '', known: [], serial: 0, arrivals: {} };
    const first = nextSeatArrivals(empty, 'room', [player('hero', true), player('a'), player('b')]);
    expect(Object.keys(first.arrivals)).toEqual(['2', '3']);
    const idle = nextSeatArrivals(first, 'room', []);
    const same = nextSeatArrivals(idle, 'room', [player('hero', true), player('a'), player('c')]);
    expect(Object.keys(same.arrivals)).toEqual(['3']);
    const moved = nextSeatArrivals(same, 'room', [player('hero', true), player('c'), player('a')]);
    expect(Object.keys(moved.arrivals).sort()).toEqual(['2', '3']);
    expect(moved.arrivals[3].playerId).toBe('a');
  });

  it('an arriving opponent loads at once, and its fade waits for the portrait to decode', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const animations: { pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(() => {
        const a = { cancel: vi.fn(), pause: vi.fn(), play: vi.fn() };
        animations.push(a);
        return a as unknown as Animation;
      }),
    });
    let decoded: () => void = () => {};
    const completeSpy = vi
      .spyOn(HTMLImageElement.prototype, 'complete', 'get')
      .mockReturnValue(false);
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () =>
        new Promise<void>((res) => {
          decoded = res;
        }),
    });
    function Fixture({ players }: { players: (SeatPlayer | null)[] }) {
      const arrivals = useSeatArrivals('room', players);
      return (
        <>
          {players.map((p, i) => (
            <SeatSlot
              key={i}
              seatNumber={i + 1}
              player={p}
              position={null}
              isActive={false}
              lastAction={null}
              arrival={arrivals[i + 1]}
            />
          ))}
        </>
      );
    }
    const { container, rerender } = render(<Fixture players={[]} />);
    rerender(
      <Fixture players={[player('hero', true), player('a', false, 'https://x.test/a.webp')]} />
    );
    const img = container.querySelector<HTMLImageElement>(
      '[data-seat-num="2"] img.seat__avatar-img, img.seat__avatar-img:not([fetchpriority="high"])'
    );
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.every((a) => a.pause.mock.calls.length === 1)).toBe(true);
    expect(animations.every((a) => a.play.mock.calls.length === 0)).toBe(true);
    await act(async () => {
      decoded();
      await Promise.resolve();
    });
    expect(animations.every((a) => a.play.mock.calls.length === 1)).toBe(true);
    // The cap does not play it twice.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(animations.every((a) => a.play.mock.calls.length === 1)).toBe(true);
    completeSpy.mockRestore();
    delete (HTMLElement.prototype as any).animate;
    delete (HTMLImageElement.prototype as any).decode;
  });

  it('a portrait that never decodes still fades in after the cap', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const animations: { pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn(() => {
        const a = { cancel: vi.fn(), pause: vi.fn(), play: vi.fn() };
        animations.push(a);
        return a as unknown as Animation;
      }),
    });
    const completeSpy = vi
      .spyOn(HTMLImageElement.prototype, 'complete', 'get')
      .mockReturnValue(false);
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () => new Promise<void>(() => {}),
    });
    function Fixture({ players }: { players: (SeatPlayer | null)[] }) {
      const arrivals = useSeatArrivals('room', players);
      return (
        <>
          {players.map((p, i) => (
            <SeatSlot
              key={i}
              seatNumber={i + 1}
              player={p}
              position={null}
              isActive={false}
              lastAction={null}
              arrival={arrivals[i + 1]}
            />
          ))}
        </>
      );
    }
    const { rerender } = render(<Fixture players={[]} />);
    rerender(
      <Fixture players={[player('hero', true), player('a', false, 'https://x.test/a.webp')]} />
    );
    expect(animations.length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(animations.every((a) => a.play.mock.calls.length === 0)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(animations.every((a) => a.play.mock.calls.length === 1)).toBe(true);
    completeSpy.mockRestore();
    delete (HTMLElement.prototype as any).animate;
    delete (HTMLImageElement.prototype as any).decode;
  });

  it('early hole cards wait for the hero row, apply for the same hand and drop for another', () => {
    const early = { hand: 9, row: { user_id: 'hero' } };
    expect(lightningEarlyHeroCardsReady({ early: null, handNumber: 9, heroInRoster: true })).toBe(
      'wait'
    );
    expect(lightningEarlyHeroCardsReady({ early, handNumber: 9, heroInRoster: false })).toBe(
      'wait'
    );
    expect(lightningEarlyHeroCardsReady({ early, handNumber: 9, heroInRoster: true })).toBe(
      'apply'
    );
    expect(lightningEarlyHeroCardsReady({ early, handNumber: 10, heroInRoster: true })).toBe(
      'drop'
    );
  });

  it('the hole-card door keeps early cards on every table and replays them through itself', () => {
    expect(PAGE).toMatch(
      /\} else \{[\s\S]{0,850}earlyHeroCardsRef\.current = \{ hand: dealtHandNumber, row \};/
    );
    expect(PAGE).toMatch(
      /if \(decision === 'apply' && early\) \{\s*handleHoleCardPayload\(\{ new: early\.row \}\);/
    );
  });
});
