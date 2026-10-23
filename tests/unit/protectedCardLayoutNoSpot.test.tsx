import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The felt has no clear spot on the first pass, then one opens up later.
const placement = vi.hoisted(() => ({ open: false }));
vi.mock('../../src/lib/protectedCardPlacement', () => ({
  placeProtectedCardRow: (candidate: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) =>
    placement.open ? { ...candidate, left: candidate.left - 40, top: candidate.top - 120 } : null,
}));

import { useProtectedCardLayout } from '../../src/hooks/useProtectedCardLayout';
import { installCssTranslateShim } from './support/cssTranslateShim';

function Fixture({ revision }: { revision: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useProtectedCardLayout(ref, revision);
  return (
    <div className="table-page" data-box="0,0,393,852">
      <div className="table-scaler" data-box="0,0,393,600" ref={ref}>
        <div className="community-area" data-box="60,310,280,90" />
        <div className="seat__cards--revealed">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="seat__card" data-box={`${80 + i * 10},330,20,35`} />
          ))}
        </div>
      </div>
    </div>
  );
}

let restoreTranslate: () => void = () => {};
beforeEach(() => {
  restoreTranslate = installCssTranslateShim();
});
afterEach(() => {
  restoreTranslate();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('a hand with no clear spot stays where it is drawn instead of jumping later in the hand', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(393);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const [left = 0, top = 0, width = 0, height = 0] = (this.dataset.box ?? '')
      .split(',')
      .map(Number);
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
  placement.open = false;
  const h = render(<Fixture revision="flop" />);
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  expect(row.style.translate || '').toBe('');
  // A spot opens up on the turn; the shown hand must not leap to it.
  placement.open = true;
  await act(async () => h.rerender(<Fixture revision="turn" />));
  await act(async () => {
    row.dispatchEvent(new Event('animationend', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(row.style.translate || '').toBe('');
});
