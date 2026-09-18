import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useFitText } from '../../src/components/lobby/game-cards/useFitText';

function Label({ boxSizing = 'content-box', scale = 1 }: { boxSizing?: string; scale?: number }) {
  const ref = useFitText<HTMLSpanElement>('Prize', scale);
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
});
describe('fitted text during the wheel prize opening', () => {
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
