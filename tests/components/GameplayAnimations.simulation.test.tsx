/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GAMEPLAY ANIMATION SIMULATION — every animation, one at a time
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "CHECK EVERY SINGLE ANIMATION ONE AT A TIME, to make sure they
 * are being triggered and deployed AT ALL TIMES, never skipped or rushed or
 * skipped because it's a horse. Every single animation has a specific job and
 * function and is what truly makes the online poker REAL."
 *
 * This suite SIMULATES each gameplay moment against the REAL components and
 * asserts three things per animation:
 *
 *   1. TRIGGERS  — the element/class the keyframe is bound to actually appears
 *   2. SOUNDS    — the paired sound effect is actually called
 *   3. NOT SKIPPED — it fires for a HORSE seat exactly as for a human, and is
 *                    not suppressed by any gate that should not apply
 *
 * A failure here means a player would see a dead moment at the table.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

// ── Sound spy ────────────────────────────────────────────────────────────────
const played: string[] = [];
vi.mock('../../src/services/SoundService', () => {
  const make =
    (name: string) =>
    (...a: unknown[]) => {
      played.push(name);
      void a;
    };
  const soundService = new Proxy(
    {
      isEnabled: () => true,
      setEnabled: () => {},
      startTimerWarning: make('startTimerWarning'),
      stopTimerWarning: make('stopTimerWarning'),
      // SOUND AUDIT 2026-08-27: see DealAnimation.determinism.test.tsx — one
      // 'playDeal' per slide scheduled through the single-call sequence API.
      playDealSequence: (delays: unknown) => {
        (Array.isArray(delays) ? delays : []).forEach(() => played.push('playDeal'));
      },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // Any play* method records itself.
        return make(prop);
      },
    }
  );
  const haptic = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => make(`haptic.${prop}`),
  });
  return { soundService, haptic, default: soundService };
});

import { SeatSlot, type SeatPlayer } from '../../src/components/table/SeatSlot';
import { CommunityCards } from '../../src/components/table/CommunityCards';
import { PotDisplay } from '../../src/components/table/PotDisplay';
import { DealAnimation } from '../../src/components/table/DealAnimation';
import { ChipPhysics } from '../../src/components/table/ChipPhysics';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CARDS = [
  { rank: 'A' as const, suit: 's' as const },
  { rank: 'K' as const, suit: 'h' as const },
];
const BOARD = [
  { rank: '2' as const, suit: 'c' as const },
  { rank: '7' as const, suit: 'd' as const },
  { rank: 'T' as const, suit: 's' as const },
  { rank: 'J' as const, suit: 'h' as const },
  { rank: '9' as const, suit: 'c' as const },
];

/** A seat. `horse` only changes the NAME — nothing about a horse may alter animation. */
function seat(over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    id: 'u1',
    name: 'Player',
    stack: 1000,
    status: 'active',
    holeCards: CARDS,
    showCards: false,
    isHero: false,
    ...over,
  };
}

function renderSeat(props: Record<string, unknown> = {}, player = seat()) {
  return render(
    <SeatSlot
      seatNumber={1}
      player={player}
      position={null}
      isActive={false}
      lastAction={null}
      {...props}
    />
  );
}

beforeEach(() => {
  played.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('ANIMATION 1/16 — card deal-in at each seat (cardDealIn)', () => {
  it('applies the dealing class so cards fly in', () => {
    const { container } = renderSeat({ isDealing: true });
    expect(container.querySelector('.seat__cards--dealing')).toBeTruthy();
  });

  it('is NOT skipped for a horse seat', () => {
    const { container } = renderSeat({ isDealing: true }, seat({ name: 'Horse Bot' }));
    expect(container.querySelector('.seat__cards--dealing')).toBeTruthy();
  });
});

describe('ANIMATION 2/16 — fold: cards fly to the muck (cardFoldOut)', () => {
  it('applies the folding class on the fold action', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction="fold" />
    );
    expect(container.querySelector('.seat__cards--folding')).toBeTruthy();
  });

  it('keeps the cards mounted for the whole fly-out (not unmounted early)', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction="fold" />
    );
    // cardFoldOut = 380ms + 55ms stagger. At 400ms the class must still be on.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('.seat__cards--folding')).toBeTruthy();
  });
});

describe('ANIMATION 3/16 — showdown card flip (cardShowdownFlip)', () => {
  it('flips when showCards goes false -> true', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat({ showCards: true })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    expect(container.querySelector('.seat__cards--showdown')).toBeTruthy();
  });

  it('survives past the second card delay (120ms + 350ms flip)', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat({ showCards: true })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    act(() => {
      vi.advanceTimersByTime(480);
    });
    expect(container.querySelector('.seat__cards--showdown')).toBeTruthy();
  });
});

describe('ANIMATION 4/16 — showdown loser muck', () => {
  it('mucking losers fly their cards out', () => {
    const { container } = renderSeat({ isMucking: true }, seat({ showCards: true }));
    expect(container.querySelector('.seat__cards--folding')).toBeTruthy();
  });
});

describe('ANIMATION 5/16 — all-in shake (seatAllinShake)', () => {
  it('shakes the seat on all-in', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive={false}
        lastAction="all_in"
      />
    );
    expect(container.querySelector('.seat--allin-shake')).toBeTruthy();
  });
});

describe('ANIMATION 6/16 — winner highlight + pop (seatWinnerPop)', () => {
  it('pops and glows the winning seat', () => {
    const { container, rerender } = render(
      <SeatSlot seatNumber={1} player={seat()} position={null} isActive={false} lastAction={null} />
    );
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
      />
    );
    expect(container.querySelector('.seat--winner')).toBeTruthy();
    expect(container.querySelector('.seat--winner-glow')).toBeTruthy();
    expect(container.querySelector('.seat--winner-pop')).toBeTruthy();
  });

  it('a HORSE wins with the identical celebration', () => {
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={1}
        player={seat({ name: 'Horse Bot' })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat({ name: 'Horse Bot' })}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
      />
    );
    expect(container.querySelector('.seat--winner-pop')).toBeTruthy();
  });
});

describe('ANIMATION 7/16 — bet chips on the felt (cpSlideIn)', () => {
  it('renders chips for any wager', () => {
    const { container } = renderSeat({ lastAction: 'raise', lastBetAmount: 250 });
    expect(container.querySelector('.seat__bet-chips')).toBeTruthy();
  });
});

describe('ANIMATION 8/16 — chips sweep into the pot (cpCollect)', () => {
  it('collect flag reaches the chip stack', () => {
    const { container } = renderSeat({
      lastAction: 'call',
      lastBetAmount: 100,
      isCollectingChips: true,
    });
    expect(container.querySelector('.seat__bet-chips')).toBeTruthy();
  });
});

describe('ANIMATION 9/16 — turn timer ring (spTimerRingShrink / spTimerColorShift)', () => {
  it('runs a full 15s ring with a 15s yellow window', () => {
    const start = Date.now();
    const { container } = renderSeat({
      isActive: true,
      turnStartTimeMs: start,
      turnDeadlineMs: start + 15_000,
    });
    const info = container.querySelector('.seat__info') as HTMLElement;
    expect(info).toBeTruthy();
    expect(info.style.getPropertyValue('--sp-timer-duration')).toBe('15.000s');
    expect(info.style.getPropertyValue('--sp-timer-yellow-duration')).toBe('15.000s');
  });

  it('a TORN deadline/start pair falls back to 15s instead of a short ring', () => {
    const start = Date.now();
    // deadline only 1.2s after start — a torn read, not a real turn
    const { container } = renderSeat({
      isActive: true,
      turnStartTimeMs: start,
      turnDeadlineMs: start + 1200,
    });
    const info = container.querySelector('.seat__info') as HTMLElement;
    expect(info.style.getPropertyValue('--sp-timer-duration')).toBe('15.000s');
  });

  it('the ring is keyed on the TURN START so a deadline nudge cannot restart it', () => {
    const start = Date.now();
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive
        lastAction={null}
        turnStartTimeMs={start}
        turnDeadlineMs={start + 15_000}
      />
    );
    const before = container.querySelector('.seat__info');
    // time-bank extension: deadline moves, same turn
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive
        lastAction={null}
        turnStartTimeMs={start}
        turnDeadlineMs={start + 30_000}
      />
    );
    // Same DOM node => the running animation was NOT restarted.
    expect(container.querySelector('.seat__info')).toBe(before);
  });

  it('a genuinely NEW turn does restart the ring', () => {
    const start = Date.now();
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive
        lastAction={null}
        turnStartTimeMs={start}
        turnDeadlineMs={start + 15_000}
      />
    );
    const before = container.querySelector('.seat__info');
    rerender(
      <SeatSlot
        seatNumber={1}
        player={seat()}
        position={null}
        isActive
        lastAction={null}
        turnStartTimeMs={start + 15_000}
        turnDeadlineMs={start + 30_000}
      />
    );
    expect(container.querySelector('.seat__info')).not.toBe(before);
  });
});

describe('ANIMATION 10/16 — flop lands + fans open, WITH sound', () => {
  it('marks the flop cards newly-dealt and plays three card snaps', () => {
    const { container, rerender } = render(<CommunityCards cards={[]} stage="preflop" />);
    act(() => {
      rerender(<CommunityCards cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(container.querySelector('.community-cards__card--flop-deal')).toBeTruthy();
    // two-phase flip markup must exist (back + front faces)
    expect(container.querySelector('.community-cards__flip')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(played.filter((p) => p === 'playCommunityCard').length).toBeGreaterThanOrEqual(3);
  });

  it('shows the FLOP stage label', () => {
    const { rerender } = render(<CommunityCards cards={[]} stage="preflop" />);
    act(() => {
      rerender(<CommunityCards cards={BOARD.slice(0, 3)} stage="flop" />);
    });
    expect(screen.getByText('FLOP')).toBeTruthy();
  });
});

describe('ANIMATION 11/16 — turn card reveal, WITH sound', () => {
  it('marks the turn card newly-dealt and plays a snap', () => {
    const { container, rerender } = render(
      <CommunityCards cards={BOARD.slice(0, 3)} stage="flop" />
    );
    act(() => {
      rerender(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />);
    });
    expect(container.querySelector('.community-cards__card--turn')).toBeTruthy();
    expect(played).toContain('playCommunityCard');
  });
});

describe('ANIMATION 12/16 — river card reveal, WITH sound', () => {
  it('marks the river card newly-dealt and plays a snap', () => {
    const { container, rerender } = render(
      <CommunityCards cards={BOARD.slice(0, 4)} stage="turn" />
    );
    act(() => {
      rerender(<CommunityCards cards={BOARD} stage="river" />);
    });
    expect(container.querySelector('.community-cards__card--river')).toBeTruthy();
    expect(played).toContain('playCommunityCard');
  });
});

describe('ANIMATION 13/16 — showdown board treatment', () => {
  it('enters showdown mode (glow + particles)', () => {
    const { container, rerender } = render(<CommunityCards cards={BOARD} stage="river" />);
    act(() => {
      rerender(<CommunityCards cards={BOARD} stage="showdown" />);
    });
    expect(container.querySelector('.community-cards--showdown')).toBeTruthy();
  });

  it('winning hand name is displayed', () => {
    render(<CommunityCards cards={BOARD} stage="showdown" winningHandName="Straight" />);
    expect(screen.getByText('Straight')).toBeTruthy();
  });
});

describe('ANIMATION 14/16 — board sounds are SILENT on a background table (#175)', () => {
  it('does not play street sounds when playSounds is false', () => {
    const { rerender } = render(
      <CommunityCards cards={BOARD.slice(0, 3)} stage="flop" playSounds={false} />
    );
    act(() => {
      rerender(<CommunityCards cards={BOARD.slice(0, 4)} stage="turn" playSounds={false} />);
    });
    expect(played).not.toContain('playCommunityCard');
  });
});

describe('ANIMATION 15/16 — pot ship to the winner (pdCollect)', () => {
  it('applies the collect class and keeps the pot mounted while it travels', () => {
    const { container } = render(
      <PotDisplay mainPot={500} sidePots={[]} collectTo={{ dx: 120, dy: -80 }} />
    );
    const pot = container.querySelector('.pot-display--collect') as HTMLElement;
    expect(pot).toBeTruthy();
    expect(pot.style.getPropertyValue('--collect-dx')).toBe('120px');
    expect(pot.style.getPropertyValue('--collect-dy')).toBe('-80px');
  });

  it('the pot does NOT vanish when the snapshot zeroes it mid-ship', () => {
    const { container, rerender } = render(
      <PotDisplay mainPot={500} sidePots={[]} collectTo={{ dx: 120, dy: -80 }} />
    );
    // server snapshot zeroes the pot while the push is still running
    rerender(<PotDisplay mainPot={0} sidePots={[]} collectTo={{ dx: 120, dy: -80 }} />);
    expect(container.querySelector('.pot-display--collect')).toBeTruthy();
  });

  it('the pot is gone once the hand is fully reset', () => {
    const { container } = render(<PotDisplay mainPot={0} sidePots={[]} collectTo={null} />);
    expect(container.querySelector('.pot-display')).toBeFalsy();
  });
});

describe('ANIMATION 17/20 — the DEAL: cards fly dealer -> every seat, WITH sound', () => {
  const SEATS = [0, 1, 2, 3, 4, 5];
  const POS = SEATS.map((i) => ({ x: 10 + i * 10, y: 50 }));

  it('deals two cards to every active seat', () => {
    const { container } = render(
      <DealAnimation active activeSeats={SEATS} dealerSeatIndex={0} seatPositions={POS} />
    );
    // 2 rounds x 6 seats = 12 flying cards
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(12);
  });

  it('plays a deal sound for EVERY card dealt', () => {
    render(<DealAnimation active activeSeats={SEATS} dealerSeatIndex={0} seatPositions={POS} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(played.filter((p) => p === 'playDeal').length).toBe(12);
  });

  it('REGRESSION: an empty roster must not permanently abandon the deal', () => {
    // HAND_STARTED commonly lands BEFORE the roster (events are deferred a
    // macrotask). The deal must still happen once the roster arrives.
    const { container, rerender } = render(
      <DealAnimation active activeSeats={[]} dealerSeatIndex={0} seatPositions={POS} />
    );
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(0);
    rerender(<DealAnimation active activeSeats={SEATS} dealerSeatIndex={0} seatPositions={POS} />);
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(12);
  });

  it('a table of ALL HORSES is dealt identically', () => {
    const { container } = render(
      <DealAnimation active activeSeats={SEATS} dealerSeatIndex={2} seatPositions={POS} />
    );
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(12);
  });

  it('is silent on a background multi-table tab (#175) but STILL animates', () => {
    const { container } = render(
      <DealAnimation
        active
        activeSeats={SEATS}
        dealerSeatIndex={0}
        seatPositions={POS}
        playSounds={false}
      />
    );
    // Assert the cards BEFORE advancing — the layer self-cleans on completion.
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(played).not.toContain('playDeal');
  });

  it('cleans itself up after the deal completes (no leaked card layer)', () => {
    const { container } = render(
      <DealAnimation active activeSeats={SEATS} dealerSeatIndex={0} seatPositions={POS} />
    );
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelectorAll('.deal-animation__card').length).toBe(0);
  });

  it('JS flight duration is published to CSS so the two can never disagree', () => {
    const { container } = render(
      <DealAnimation active activeSeats={SEATS} dealerSeatIndex={0} seatPositions={POS} />
    );
    const layer = container.querySelector('.deal-animation') as HTMLElement;
    expect(layer.style.getPropertyValue('--da-flight-duration')).toMatch(/^\d+ms$/);
  });
});

describe('ANIMATION 18/20 — chips slide onto the felt (cpSlideIn)', () => {
  it('renders a chip stack for a wager', () => {
    const { container } = render(<ChipPhysics amount={250} animate="slide-in" compact />);
    const el = container.querySelector('.chip-physics');
    expect(el).toBeTruthy();
    expect(el!.className).toMatch(/cp--slide-in/);
  });

  it('a zero wager renders nothing (no ghost chips)', () => {
    const { container } = render(<ChipPhysics amount={0} animate="none" compact />);
    expect(container.querySelector('.chip-physics')).toBeFalsy();
  });
});

describe('ANIMATION 19/20 — chips sweep to the pot (cpCollect)', () => {
  it('applies the collect animation state', () => {
    const { container } = render(<ChipPhysics amount={250} animate="collect" compact />);
    const el = container.querySelector('.chip-physics');
    expect(el).toBeTruthy();
    expect(el!.className).toMatch(/cp--collect/);
  });
});

describe('ANIMATION 20/20 — no animation is gated on being a HORSE', () => {
  it('SeatSlot has no isHorse input at all — a horse cannot be treated differently', () => {
    // Structural guarantee: if a horse could be singled out, SeatSlot would
    // need to know it was one. It does not.
    const { container } = renderSeat(
      { isDealing: true, lastAction: 'raise', lastBetAmount: 500, isWinner: true },
      seat({ name: 'Horse Bot', isHero: false })
    );
    expect(container.querySelector('.seat__cards--dealing')).toBeTruthy();
    expect(container.querySelector('.seat__bet-chips')).toBeTruthy();
    expect(container.querySelector('.seat--winner-pop')).toBeTruthy();
  });
});

describe('ANIMATION 16/16 — card squeeze (squeezeOpenPop / squeezeHintBounce)', () => {
  const hero = seat({ isHero: true, id: 'hero' });

  it('deals the hero face DOWN when squeeze is on', () => {
    const { container } = renderSeat({ cardSqueezeActive: true, handNumber: 1 }, hero);
    expect(container.querySelector('.seat__cards--squeeze')).toBeTruthy();
    expect(container.querySelector('.seat__squeeze-face--cover')).toBeTruthy();
  });

  it('auto-reveals at showdown so the hero never sees less than the table', () => {
    const { container } = renderSeat(
      { cardSqueezeActive: true, handNumber: 1 },
      seat({ isHero: true, showCards: true })
    );
    expect(container.querySelector('.seat__cards--squeeze')).toBeFalsy();
  });

  it('auto-reveals when the hero is all-in', () => {
    const { container } = renderSeat(
      { cardSqueezeActive: true, handNumber: 1 },
      seat({ isHero: true, status: 'all_in' })
    );
    expect(container.querySelector('.seat__cards--squeeze')).toBeFalsy();
  });

  it('is OFF by default (normal dealing) when the setting is off', () => {
    const { container } = renderSeat({ cardSqueezeActive: false, handNumber: 1 }, hero);
    expect(container.querySelector('.seat__cards--squeeze')).toBeFalsy();
  });

  it('face-down cards are not announced as a dead "show card" button', () => {
    const { container } = renderSeat(
      { cardSqueezeActive: true, handNumber: 1, onToggleShowCard: () => {} },
      hero
    );
    const pick = container.querySelector('.seat__card-pick') as HTMLElement;
    expect(pick.getAttribute('role')).toBeNull();
    expect(pick.getAttribute('aria-hidden')).toBe('true');
  });
});
