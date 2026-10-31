import { paintedAvatarTop } from '../../src/components/table/avatarCrownBounds';
import { useRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProtectedCardLayout } from '../../src/hooks/useProtectedCardLayout';
import { installCssTranslateShim } from './support/cssTranslateShim';
function Fixture({
  revealed,
  revision = 'same-hand',
  potTop = 260,
  boardTop = 310,
  count = 6,
  seats = 9,
  width = 393,
  avatarSource = '',
  topCap = false,
}: {
  revealed: boolean;
  revision?: string;
  potTop?: number;
  boardTop?: number;
  count?: number;
  seats?: number;
  width?: number;
  avatarSource?: string;
  topCap?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useProtectedCardLayout(ref, revision);
  return (
    <div className="table-page" data-seats={seats} data-box={`0,0,${width},852`}>
      <div className="bbj-mini-plate" data-box="130,20,140,14" />
      <div className="table-scaler" data-box="0,0,393,600" ref={ref}>
        <div className="community-area" data-box={`60,${boardTop},280,90`} />
        <div className="pot-display" data-box={`160,${potTop},80,30`} />
        <div className="seat__info" data-box="10,410,100,40" />
        <div className={`seat-wrapper--top${topCap ? ' seat-wrapper--cap' : ''}`}>
          <img
            className="seat__avatar-img"
            src={avatarSource || undefined}
            data-box="180,100,50,50"
            alt=""
          />
          {revealed && topCap && (
            <div className="seat__cards--revealed">
              {Array.from({ length: count }, (_, i) => (
                <div key={i} className="seat__card" data-box={`${80 + i * 10},0,20,35`} />
              ))}
            </div>
          )}
        </div>
        {revealed && !topCap && (
          <div className="seat__cards--revealed">
            {Array.from({ length: count }, (_, i) => (
              <div key={i} className="seat__card" data-box={`${80 + i * 10},330,20,35`} />
            ))}
          </div>
        )}
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
function stubGeometry() {
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
    const row = this.closest<HTMLElement>('.seat__cards--revealed');
    const pod = this.closest<HTMLElement>('.seat-wrapper--top');
    const [rx = 0, ry = 0] = (row?.style.translate || '0px 0px').split(' ').map(parseFloat);
    const [px = 0, py = 0] = (pod?.style.translate || '0px 0px').split(' ').map(parseFloat);
    const dx = rx + px,
      dy = ry + py;
    return {
      left: left + dx,
      top: top + dy,
      width,
      height,
      right: left + dx + width,
      bottom: top + dy + height,
      x: left + dx,
      y: top + dy,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const settle = async (row: HTMLElement) => {
  await act(async () => {
    row.dispatchEvent(new Event('animationend', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
};

it('a child reveal after the parent commit is positioned clear of the real board and pot nodes', async () => {
  stubGeometry();
  const h = render(<Fixture revealed={false} />);
  const head = h.container.querySelector('.seat__avatar-img')!.getBoundingClientRect();
  const mini = h.container.querySelector('.bbj-mini-plate')!.getBoundingClientRect();
  // Dan 2026-10-22: "pull the table down so the top player isn't scrunched up" -
  // the top pod keeps 8px of air below the jackpot plate, not 4px.
  expect(head.top).toBe(mini.bottom + 8);
  await act(async () => h.rerender(<Fixture revealed />));
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await waitFor(() => expect(row.style.translate).not.toBe(''));
  const settled = row.style.translate;
  // Runout/pot updates and animation completion must not re-place this hand.
  await act(async () =>
    h.rerender(<Fixture revealed revision="turn" potTop={200} boardTop={500} />)
  );
  await act(async () => {
    row.dispatchEvent(new Event('animationend', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(row.style.translate).toBe(settled);
  const card = row.querySelector('.seat__card')!.getBoundingClientRect();
  for (const element of h.container.querySelectorAll('.community-area,.pot-display,.seat__info')) {
    const box = element.getBoundingClientRect();
    expect(
      card.left < box.right &&
        card.right > box.left &&
        card.top < box.bottom &&
        card.bottom > box.top
    ).toBe(false);
  }
});

// Dan 2026-10-23: shown cards never move once they are on the table, in every
// game, not only PLO5/PLO6.
it.each([2, 4])(
  'a shown %i-card hand keeps its slot through the runout and effects',
  async (count) => {
    stubGeometry();
    // Shown on a clear felt, then the runout lands board cards over that spot.
    const h = render(<Fixture revealed count={count} boardTop={500} />);
    const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
    await waitFor(() => expect(row.style.translate).not.toBe(''));
    const settled = row.style.translate;
    const step = row.style.getPropertyValue('--vh-step-f');
    const width = row.style.getPropertyValue('--vh-card-w');
    await act(async () =>
      h.rerender(<Fixture revealed count={count} revision="river" potTop={200} boardTop={310} />)
    );
    await settle(row);
    expect(row.style.translate).toBe(settled);
    expect(row.style.getPropertyValue('--vh-step-f')).toBe(step);
    expect(row.style.getPropertyValue('--vh-card-w')).toBe(width);
  }
);

it('a phone toolbar changing the viewport height alone does not move a shown hand', async () => {
  stubGeometry();
  const height = window.innerHeight;
  const h = render(<Fixture revealed boardTop={500} />);
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await waitFor(() => expect(row.style.translate).not.toBe(''));
  const settled = row.style.translate;
  try {
    // Safari hides its toolbar on scroll; the felt itself keeps its size.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height + 84 });
    await act(async () => h.rerender(<Fixture revealed boardTop={310} potTop={200} />));
    await settle(row);
    expect(row.style.translate).toBe(settled);
  } finally {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  }
});

it('a new hand at the same seat is placed afresh', async () => {
  stubGeometry();
  const h = render(<Fixture revealed count={4} />);
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await waitFor(() => expect(row.style.translate).not.toBe(''));
  await act(async () => h.rerender(<Fixture revealed={false} count={4} revision="next-hand" />));
  await act(async () =>
    h.rerender(<Fixture revealed count={4} revision="next-hand" boardTop={500} />)
  );
  const next = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await settle(next);
  // The new hand is laid out against the new board, not pinned to the old slot.
  const card = next.querySelector('.seat__card')!.getBoundingClientRect();
  const board = h.container.querySelector('.community-area')!.getBoundingClientRect();
  expect(
    card.left < board.right &&
      card.right > board.left &&
      card.top < board.bottom &&
      card.bottom > board.top
  ).toBe(false);
});

// The six-max crown meets the bar at all widths, independently of corner BBJ.
it.each([481, 606, 1024])(
  'six-max top crown clips two canvas pixels at width %i',
  async (width) => {
    stubGeometry();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const h = render(
      <Fixture
        revealed={false}
        seats={6}
        width={width}
        avatarSource="/avatars/table/vip_wolf@2x.webp"
      />
    );
    const head = h.container.querySelector<HTMLImageElement>('.seat__avatar-img')!;
    expect(paintedAvatarTop(head)).toBeCloseTo(-2);
    expect(head.getBoundingClientRect().top).toBeLessThan(-2);
    const pod = h.container.querySelector<HTMLElement>('.seat-wrapper--top')!;
    expect(pod.style.getPropertyValue('--sp-top-seat-shift')).toBe(
      pod.style.translate.split(' ')[1]
    );
    await act(async () =>
      h.rerender(
        <Fixture
          revealed
          seats={6}
          width={width}
          avatarSource="/avatars/table/vip_wolf@2x.webp"
          revision="flop"
        />
      )
    );
    expect(
      paintedAvatarTop(h.container.querySelector<HTMLImageElement>('.seat__avatar-img')!)
    ).toBeCloseTo(-2);
  }
);

it.each([320, 375, 393, 430, 480])(
  'retains the safe legacy phone lane at %i CSS pixels',
  (width) => {
    stubGeometry();
    const h = render(
      <Fixture
        revealed={false}
        seats={6}
        width={width}
        avatarSource="/avatars/table/vip_wolf@2x.webp"
      />
    );
    expect(h.container.querySelector('.seat__avatar-img')!.getBoundingClientRect().top).toBe(42);
  }
);

it('mobile top-cap cards stay below the visible page edge', async () => {
  stubGeometry();
  vi.stubGlobal('innerWidth', 393);
  const h = render(<Fixture revealed topCap />);
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await settle(row);
  const page = h.container.querySelector('.table-page')!.getBoundingClientRect();
  const card = row.querySelector('.seat__card')!.getBoundingClientRect();
  expect(card.top).toBeGreaterThanOrEqual(page.top + 8);
});

it('retains shown-card geometry only after the deal animation reaches rest', async () => {
  stubGeometry();
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations');
  let dealing = true;
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value() {
      return dealing
        ? [{ playState: 'running', effect: { getComputedTiming: () => ({ iterations: 1 }) } }]
        : [];
    },
  });
  try {
    const h = render(<Fixture revealed count={2} boardTop={500} />);
    const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
    const duringDeal = row.style.translate;
    dealing = false;
    await act(async () =>
      h.rerender(<Fixture revealed count={2} revision="deal-finished" boardTop={310} />)
    );
    await settle(row);
    expect(row.style.translate).not.toBe(duringDeal);
    const resting = row.style.translate;
    await act(async () =>
      h.rerender(<Fixture revealed count={2} revision="river" boardTop={500} />)
    );
    await settle(row);
    expect(row.style.translate).toBe(resting);
  } finally {
    cleanup();
    if (previous) Object.defineProperty(HTMLElement.prototype, 'getAnimations', previous);
    else Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  }
});
