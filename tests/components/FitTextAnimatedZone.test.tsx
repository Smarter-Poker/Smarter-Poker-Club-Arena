import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useFitText } from '../../src/components/lobby/game-cards/useFitText';
let restoreFonts: (() => void) | undefined;

function Label({
  boxSizing = 'content-box',
  scale = 1,
  enabled,
}: {
  boxSizing?: string;
  scale?: number;
  enabled?: boolean;
}) {
  const ref = useFitText<HTMLSpanElement>('Prize', scale, 0.5, { enabled });
  return (
    <div
      style={{
        width: '82.8px',
        boxSizing: boxSizing as 'content-box',
        border: '2px solid black',
        padding: '3px',
      }}
    >
      <span ref={ref}>Prize</span>
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreFonts?.();
  restoreFonts = undefined;
});
describe('fitted text during the wheel prize opening', () => {
  it('does no layout work until enabled, then retains the original fitting result', () => {
    const measured = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return 200 * Number(this.style.getPropertyValue('--fit') || 1);
      });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(89);
    const view = render(<Label enabled={false} />);
    expect(measured).not.toHaveBeenCalled();
    expect(view.getByText('Prize').style.getPropertyValue('--fit')).toBe('');
    view.rerender(<Label enabled />);
    expect(measured).toHaveBeenCalled();
    expect(view.getByText('Prize').style.getPropertyValue('--fit')).toBe('0.5');
  });

  it('keeps default resize and font fitting but ignores queued fonts after unmount', async () => {
    let resize!: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    let fontsReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      fontsReady = resolve;
    });
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fonts = { ready };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    restoreFonts = () => {
      if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
      else Reflect.deleteProperty(document, 'fonts');
    };
    const measured = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(70);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(89);
    const view = render(<Label />);
    const initial = measured.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    act(() => resize([], {} as ResizeObserver));
    expect(measured.mock.calls.length).toBeGreaterThan(initial);
    await act(async () => {
      fontsReady();
      await ready;
    });
    const afterFonts = measured.mock.calls.length;
    expect(afterFonts).toBeGreaterThan(initial + 1);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    fonts.ready = Promise.resolve();
    const pendingView = render(<Label />);
    pendingView.unmount();
    measured.mockClear();
    await act(async () => {
      await Promise.resolve();
    });
    expect(measured).not.toHaveBeenCalled();
  });
  it.each(['content-box', 'border-box'])(
    'does not permanently shrink a %s label during parent scale animation',
    (boxSizing) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(
        boxSizing === 'border-box' ? 79 : 89
      );
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 10,
      } as DOMRect);
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        return 70 * Number(this.style.getPropertyValue('--fit') || 1);
      });
      const v = render(<Label boxSizing={boxSizing} />);
      expect(v.getByText('Prize').style.getPropertyValue('--fit')).toBe('1');
    }
  );
  it('still fits a genuinely oversized stretched label inside fractional borders', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(79);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 10,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return 70 * Number(this.style.getPropertyValue('--fit') || 1);
    });
    const v = render(<Label boxSizing="border-box" scale={1.5} />);
    const ratio = Number(v.getByText('Prize').style.getPropertyValue('--fit'));
    expect(ratio).toBeGreaterThan(0.7);
    expect(70 * 1.5 * ratio).toBeLessThanOrEqual(78.8);
  });
});
