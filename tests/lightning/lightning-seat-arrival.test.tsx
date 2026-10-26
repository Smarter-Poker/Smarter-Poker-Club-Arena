import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';
import { useSeatArrivals } from '../../src/components/table/seatArrival';
const player = (id: string, isHero = false): SeatPlayer => ({
  id,
  name: id,
  stack: 100,
  status: 'active',
  isHero,
  holeCards: [
    { rank: 'A', suit: 's' },
    { rank: 'K', suit: 'c' },
  ],
});
const calls: {
  node: HTMLElement;
  options: KeyframeAnimationOptions;
  frames: Keyframe[];
  cancel: ReturnType<typeof vi.fn>;
}[] = [];
function Fixture({ players, active = 0 }: { players: (SeatPlayer | null)[]; active?: number }) {
  const arrivals = useSeatArrivals('room', players);
  return (
    <>
      {players.map((p, i) => (
        <SeatSlot
          key={i}
          seatNumber={i + 1}
          player={p}
          position={null}
          isActive={active === i + 1}
          lastAction={null}
          {...{ arrival: arrivals[i + 1] }}
        />
      ))}
    </>
  );
}
function observe() {
  calls.length = 0;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(function (this: HTMLElement, frames, options) {
      const cancel = vi.fn();
      calls.push({
        node: this,
        frames: frames as Keyframe[],
        options: options as KeyframeAnimationOptions,
        cancel,
      });
      return { cancel } as unknown as Animation;
    }),
  });
}
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as any).animate;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('stages only real arriving avatar/plate art while hero cards and active actions stay immediate', () => {
  observe();
  const { container, rerender } = render(<Fixture players={[]} />);
  rerender(
    <Fixture players={[player('hero', true), player('a'), player('b'), player('c')]} active={4} />
  );
  expect(calls).toHaveLength(4);
  expect(calls.map((c) => c.options.delay)).toEqual([0, 0, 80, 80]);
  expect(calls.every((c) => c.node.matches('.seat__avatar, .seat__info'))).toBe(true);
  expect(container.querySelectorAll('.seat__cards--hero .seat__card')).toHaveLength(2);
  const count = calls.length;
  rerender(
    <Fixture players={[player('hero', true), player('a'), player('b'), player('c')]} active={4} />
  );
  expect(calls).toHaveLength(count);
  rerender(<Fixture players={[]} />);
  expect(calls.every((c) => c.cancel.mock.calls.length === 1)).toBe(true);
  rerender(
    <Fixture players={[player('hero', true), player('a'), player('b'), player('c')]} active={4} />
  );
  expect(calls).toHaveLength(count);
  rerender(
    <Fixture players={[player('hero', true), player('a'), player('new'), player('c')]} active={4} />
  );
  expect(calls).toHaveLength(count + 2);
  expect(calls.at(-1)?.options.delay).toBe(0);
});

it('a seat already on the clock does not animate later when the turn moves away', () => {
  observe();
  const { rerender } = render(<Fixture players={[player('acting')]} active={1} />);
  expect(calls).toHaveLength(0);
  rerender(<Fixture players={[player('acting')]} active={0} />);
  expect(calls).toHaveLength(0);
});
it('reduced motion keeps the arrival sequence without scale and the final frame is never retained hidden', () => {
  observe();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  render(<Fixture players={Array.from({ length: 6 }, (_, i) => player(`p${i}`))} />);
  expect(calls).toHaveLength(12);
  expect(Math.max(...calls.map((c) => Number(c.options.delay)))).toBe(400);
  expect(
    calls.every((c) => c.frames[0].transform === 'none' && c.options.fill === 'backwards')
  ).toBe(true);
});
