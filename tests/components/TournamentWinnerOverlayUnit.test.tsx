/**
 * THE WINNER'S PRIZE IS PRINTED AT THE UNIT THE EVENT PAID IN (2026-09-21).
 *
 * The overlay counts the prize up frame by frame and printed every frame
 * through `formatTableChips`, the chip contract, which keeps two places for a
 * fraction. A Diamond prize therefore climbed through "17.45" on its way to a
 * whole number, and landed on a bare figure that did not say what was won.
 *
 * Three answers, three renderings:
 *   - a chip event prints exactly what it printed before, frame for frame;
 *   - a Diamond event prints whole Diamonds on every frame and names them;
 *   - an unread arena (`null`) prints no figure at all until it is read.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentWinnerOverlay from '../../src/components/table/TournamentWinnerOverlay';
import { formatTableChips } from '../../src/utils/format';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;

beforeEach(() => {
  frames = new Map();
  sequence = 0;
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Run the next queued odometer frame at `time` ms after the overlay opened. */
function tick(time: number) {
  const batch = [...frames.entries()];
  expect(batch.length).toBeGreaterThan(0);
  for (const [id] of batch) frames.delete(id);
  act(() => {
    vi.setSystemTime(time);
    for (const [, callback] of batch) callback(time);
  });
}

/** The overlay's own easing, so a frame's expected value is computed, not guessed. */
function odometer(prize: number, elapsedMs: number): number {
  const progress = Math.min(1, elapsedMs / 1500);
  return prize * (1 - Math.pow(1 - progress, 3));
}

const base = { isWinner: true, tournamentName: 'Test Event', onDismiss: vi.fn() };
const prizeLine = (container: HTMLElement) =>
  container.querySelector('.winnerPrize')?.textContent ?? null;

describe('the winner overlay prints the prize at the event unit', () => {
  it('a chip event prints the chip contract on every frame, exactly as before', () => {
    const { container } = render(
      <TournamentWinnerOverlay {...base} prize={50} unitCents={CHIP_UNIT_CENTS} />
    );
    expect(prizeLine(container)).toBe('Prize: 0');

    // Mid-climb the chip contract keeps its fraction, as it always did.
    tick(200);
    const midway = odometer(50, 200);
    expect(midway % 1).not.toBe(0);
    expect(prizeLine(container)).toBe(`Prize: ${formatTableChips(midway)}`);
    expect(prizeLine(container)).toMatch(/^Prize: \d+\.\d+$/);

    tick(1600);
    expect(prizeLine(container)).toBe('Prize: 50');
  });

  it('a chip prize that carries cents still lands to the cent', () => {
    const { container } = render(
      <TournamentWinnerOverlay {...base} prize={98.72} unitCents={CHIP_UNIT_CENTS} />
    );
    tick(1600);
    expect(prizeLine(container)).toBe('Prize: 98.72');
  });

  it('a Diamond event climbs through whole Diamonds and names them', () => {
    const { container } = render(
      <TournamentWinnerOverlay {...base} prize={50} unitCents={DIAMOND_UNIT_CENTS} />
    );
    expect(prizeLine(container)).toBe('Prize: 0 Diamonds');

    for (const at of [100, 200, 450, 900, 1300]) {
      tick(at);
      const line = prizeLine(container)!;
      expect(line, `frame at ${at}ms`).toMatch(/^Prize: \d[\d,]* Diamonds$/);
      expect(line, `frame at ${at}ms`).toBe(`Prize: ${Math.round(odometer(50, at))} Diamonds`);
    }

    tick(1600);
    expect(prizeLine(container)).toBe('Prize: 50 Diamonds');
  });

  it('a large Diamond prize keeps its separators and never shows a chip word', () => {
    const { container } = render(
      <TournamentWinnerOverlay {...base} prize={12500} unitCents={DIAMOND_UNIT_CENTS} />
    );
    tick(1600);
    expect(prizeLine(container)).toBe('Prize: 12,500 Diamonds');
    expect(container.textContent).not.toMatch(/Chips/);
  });

  it('an unread arena prints no figure at all, and the celebration still plays', () => {
    const { container } = render(<TournamentWinnerOverlay {...base} prize={50} unitCents={null} />);
    tick(200);
    expect(prizeLine(container)).toBeNull();
    expect(container.textContent).toContain('Champion!');
    expect(container.textContent).toContain('1st Place');
  });

  it('the figure appears, at its unit, the moment the arena is read', () => {
    const view = render(<TournamentWinnerOverlay {...base} prize={50} unitCents={null} />);
    tick(1600);
    expect(prizeLine(view.container)).toBeNull();
    view.rerender(<TournamentWinnerOverlay {...base} prize={50} unitCents={DIAMOND_UNIT_CENTS} />);
    expect(prizeLine(view.container)).toBe('Prize: 50 Diamonds');
  });
});

describe('The Champion Announcement', () => {
  it('names the champion and shows first place with an exact prize', () => {
    const { container } = render(
      <TournamentWinnerOverlay
        {...base}
        championName="xXVikingXx"
        prize={98.72}
        unitCents={CHIP_UNIT_CENTS}
      />
    );
    tick(1600);
    expect(container.textContent).toContain('xXVikingXx');
    expect(container.textContent).toContain('1st Place');
    expect(prizeLine(container)).toBe('Prize: 98.72');
  });
  it.each([CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS])(
    'shows every qualifier with award values at unit %s, without a false rank',
    (unitCents) => {
      const { container } = render(
        <TournamentWinnerOverlay
          {...base}
          prize={0}
          unitCents={unitCents}
          qualifiers={[
            { username: 'Alice', prize: 50 },
            { username: 'Bob', prize: 50 },
          ]}
        />
      );
      expect(container.textContent).toContain('Qualified!');
      expect(container.textContent).toContain('Alice: Award Value 50');
      expect(container.textContent).toContain('Bob: Award Value 50');
      expect(container.textContent).not.toContain('1st Place');
      expect(container.textContent).not.toContain('Champion!');
      expect(prizeLine(container)).toBeNull();
    }
  );
  it('prints a committed zero prize rather than omitting the amount', () => {
    const { container } = render(
      <TournamentWinnerOverlay
        {...base}
        championName="Champion"
        prize={0}
        unitCents={CHIP_UNIT_CENTS}
      />
    );
    expect(prizeLine(container)).toBe('Prize: 0');
  });
});
