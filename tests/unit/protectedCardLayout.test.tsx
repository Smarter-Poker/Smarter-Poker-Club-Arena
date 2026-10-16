import { useRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useProtectedCardLayout } from '../../src/hooks/useProtectedCardLayout';
function Fixture({ revealed }: { revealed: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useProtectedCardLayout(ref, 'same-hand');
  return (
    <div className="table-page" data-box="0,0,393,852">
      <div className="bbj-mini-plate" data-box="130,20,140,14" />
      <div className="table-scaler" data-box="0,0,393,600" ref={ref}>
        <div className="community-area" data-box="60,310,280,90" />
        <div className="pot-display" data-box="160,260,80,30" />
        <div className="seat__info" data-box="10,410,100,40" />
        <div className="seat-wrapper--top">
          <img className="seat__avatar-img" data-box="180,100,50,50" alt="" />
        </div>
        {revealed && (
          <div className="seat__cards--revealed">
            <div className="seat__card" data-box="80,330,100,35" />
          </div>
        )}
      </div>
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('a child reveal after the parent commit is positioned clear of the real board and pot nodes', async () => {
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
  const h = render(<Fixture revealed={false} />);
  const head = h.container.querySelector('.seat__avatar-img')!.getBoundingClientRect();
  const mini = h.container.querySelector('.bbj-mini-plate')!.getBoundingClientRect();
  expect(head.top).toBe(mini.bottom + 4);
  await act(async () => h.rerender(<Fixture revealed />));
  const row = h.container.querySelector<HTMLElement>('.seat__cards--revealed')!;
  await waitFor(() => expect(row.style.translate).not.toBe(''));
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
