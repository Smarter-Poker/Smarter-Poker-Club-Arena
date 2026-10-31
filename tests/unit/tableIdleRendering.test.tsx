import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { ChipAnimationManager } from '../../src/components/table/ChipAnimation';
import { ThrowAnimationContainer } from '../../src/components/table/ThrowAnimation';
import { useTableEnvironment } from '../../src/hooks/useTableEnvironment';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('releases the full-table chip layer and resize observer between animations', () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = observe;
      disconnect = disconnect;
    }
  );
  const view = render(<ChipAnimationManager animations={[]} />);
  expect(view.container.childElementCount).toBe(0);
  expect(observe).not.toHaveBeenCalled();
  const floats = [{ id: 1, fromX: 20, fromY: 30, toX: 40, toY: 50, label: '12' }];
  view.rerender(<ChipAnimationManager animations={[]} floats={floats} />);
  expect(view.container.querySelector('.pot-win-float')?.textContent).toBe('12');
  expect(observe).toHaveBeenCalledOnce();
  view.rerender(<ChipAnimationManager animations={[]} />);
  expect(view.container.childElementCount).toBe(0);
  expect(disconnect).toHaveBeenCalledOnce();
  view.rerender(<ChipAnimationManager animations={[]} floats={floats} />);
  expect(view.container.querySelector('.pot-win-float')).not.toBeNull();
  expect(observe).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

it('does not retain a full-table throw layer without an owed event', () => {
  const complete = vi.fn();
  const view = render(
    <ThrowAnimationContainer events={[]} seatPositions={new Map()} onEventComplete={complete} />
  );
  expect(view.container.childElementCount).toBe(0);
  expect(complete).not.toHaveBeenCalled();
});

function Table({ id }: { id: string }) {
  const root = useRef<HTMLDivElement>(null);
  useTableEnvironment(id, root);
  return <div ref={root} data-testid={id} className="table-page" />;
}

it('starts every table in the current visibility state, including hidden mounts', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const view = render(
    <>
      <Table id="first" />
      <Table id="second" />
    </>
  );
  for (const root of view.container.children) {
    expect(root.classList.contains('table-page--backgrounded')).toBe(true);
  }
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  for (const root of view.container.children) {
    expect(root.classList.contains('table-page--backgrounded')).toBe(false);
  }
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  const roots = [...view.container.children];
  view.unmount();
  for (const root of roots) expect(root.classList.contains('table-page--backgrounded')).toBe(false);
});

it('measures a newly mounted scaled chip layer before starting its first flight', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 200,
    height: 400,
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  const view = render(<ChipAnimationManager animations={[]} />);
  view.rerender(
    <ChipAnimationManager
      animations={[
        {
          id: 'first-flight',
          from: { x: 200, y: 300 },
          to: { x: 100, y: 100 },
          amount: 2,
        },
      ]}
    />
  );
  expect(view.container.querySelector<HTMLElement>('[data-chip-flight]')?.style.transform).toBe(
    'translate(380px, 560px) scale(1)'
  );
});
