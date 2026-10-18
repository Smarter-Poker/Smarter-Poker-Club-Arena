import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MttPremiumCard } from '../../src/components/lobby/game-cards/MttPremiumCard';
import type { ArenaGameCardData } from '../../src/components/lobby/game-cards/arenaGameCardTypes';
// Flush the same shared pre-paint cohort the browser runs after commit.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
function paint() {
  act(() => {
    const ready = [...frames.values()];
    frames.clear();
    for (const frame of ready) frame(0);
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const data: ArenaGameCardData = {
  id: 'mtt',
  family: 'mtt',
  title: 'Sunday Deep Stack',
  gameType: 'NLH',
  status: 'registering',
  statusLabel: 'Registering',
  startsIn: 'Starting In 10:00',
  startTime: 'Oct 11, 12:00 PM',
  buyIn: '200',
  guarantee: '20,000 GTD',
  registered: '29',
  startingStack: '30,000',
  currentLevel: '1',
  currentBlinds: '25/50',
  rules: [],
};
describe('cash-style tournament card', () => {
  it.each(['distant', 'hidden'])(
    'defers %s card measurements, fits on approach, and disconnects its observer',
    (visibility) => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: visibility === 'hidden' ? 0 : 10000,
        bottom: visibility === 'hidden' ? 0 : 10600,
        left: 0,
        right: visibility === 'hidden' ? 0 : 390,
        width: visibility === 'hidden' ? 0 : 390,
        height: visibility === 'hidden' ? 0 : 600,
      } as DOMRect);
      let approach!: IntersectionObserverCallback;
      const observe = vi.fn(),
        disconnect = vi.fn();
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(callback: IntersectionObserverCallback) {
            approach = callback;
          }
          observe = observe;
          disconnect = disconnect;
        }
      );
      const measured = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(80);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
      const primary = vi.fn();
      const view = render(
        <MttPremiumCard data={data} actions={{ primaryLabel: 'Register', onPrimary: primary }} />
      );
      const card = view.container.querySelector('.agc-mtt-premium')!;
      expect(observe).toHaveBeenCalledWith(card);
      paint();
      expect(measured).not.toHaveBeenCalled();
      expect(screen.getByText('Sunday Deep Stack')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Register' }));
      expect(primary).toHaveBeenCalledOnce();
      act(() =>
        approach(
          [{ target: card, isIntersecting: false }] as IntersectionObserverEntry[],
          {} as IntersectionObserver
        )
      );
      paint();
      expect(measured).not.toHaveBeenCalled();
      act(() =>
        approach(
          [{ target: card, isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver
        )
      );
      paint();
      expect(measured).toHaveBeenCalled();
      expect(screen.getByText('Sunday Deep Stack').style.getPropertyValue('--fit')).toBe('1');
      expect(disconnect).toHaveBeenCalledOnce();
      view.unmount();
      expect(disconnect).toHaveBeenCalledTimes(2);
      measured.mockClear();
      act(() =>
        approach(
          [{ target: card, isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver
        )
      );
      paint();
      expect(measured).not.toHaveBeenCalled();
    }
  );

  it('fits nearby cards before paint and supports browsers without IntersectionObserver', () => {
    const constructor = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor() {
          constructor();
        }
      }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 700,
      width: 390,
      height: 600,
    } as DOMRect);
    const measured = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    const view = render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    paint();
    expect(measured).toHaveBeenCalled();
    expect(constructor).not.toHaveBeenCalled();
    view.unmount();
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      top: 10000,
      bottom: 10600,
    } as DOMRect);
    measured.mockClear();
    render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    paint();
    expect(measured).toHaveBeenCalled();
  });
  it('shows live tournament facts and countdown without the rules rail', () => {
    render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    for (const value of [
      'Sunday Deep Stack',
      'Starting In 10:00',
      'Oct 11, 12:00 PM',
      '200',
      '20,000 GTD',
      '29',
      '30,000',
      '1',
      '25/50',
    ])
      expect(screen.getByText(value)).toBeTruthy();
  });
  it('keeps register and details actions, and prevents repeated busy registration', () => {
    const primary = vi.fn(),
      secondary = vi.fn();
    const { rerender } = render(
      <MttPremiumCard
        data={data}
        actions={{
          primaryLabel: 'Register',
          secondaryLabel: 'Details',
          onPrimary: primary,
          onSecondary: secondary,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    rerender(
      <MttPremiumCard
        data={data}
        actions={{ primaryLabel: 'Register', busy: true, onPrimary: primary }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Working...' }));
    expect(primary).toHaveBeenCalledTimes(1);
  });
});
