import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFitText } from '../../src/components/lobby/game-cards/useFitText';

let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let resize: ResizeObserverCallback | undefined;

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resize = undefined;
});

function paint() {
  act(() => {
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(0);
  });
}

function Label({ text = 'Long Tournament Title' }: { text?: string }) {
  const ref = useFitText<HTMLSpanElement>(text);
  return (
    <div style={{ width: '100px' }}>
      <span ref={ref}>{text}</span>
    </div>
  );
}

/** Model the browser's layout invalidation, rather than time a fast jsdom. */
function geometry() {
  let dirty = false;
  let layouts = 0;
  const read = () => {
    if (dirty) layouts++;
    dirty = false;
  };
  const computed = getComputedStyle;
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
    read();
    return computed(element);
  });
  const write = CSSStyleDeclaration.prototype.setProperty;
  vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(
    function (name, value, priority) {
      if (name === '--fit') dirty = true;
      return write.call(this, name, value, priority);
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => {
    read();
    return 100;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    read();
    return 200 * Number(this.style.getPropertyValue('--fit') || 1);
  });
  return { layouts: () => layouts };
}

describe('a lobby cohort fits without per-label layout invalidation', () => {
  it('fits every full title while sharing layout across a hundred newly mounted labels', () => {
    const measured = geometry();
    const view = render(
      <>
        {Array.from({ length: 100 }, (_, index) => (
          <Label key={index} text={`Full Tournament Title ${index}`} />
        ))}
      </>
    );
    paint();
    const labels = view.getAllByText(/^Full Tournament Title /);
    expect(labels).toHaveLength(100);
    for (const label of labels) expect(label.style.getPropertyValue('--fit')).toBe('0.5');
    expect(measured.layouts()).toBeLessThanOrEqual(4);
  });

  it('coalesces repeated resize events and remeasures the current text', () => {
    const measured = geometry();
    const view = render(<Label />);
    resize?.([], {} as ResizeObserver);
    resize?.([], {} as ResizeObserver);
    paint();
    expect(view.getByText('Long Tournament Title').style.getPropertyValue('--fit')).toBe('0.5');
    expect(measured.layouts()).toBeLessThanOrEqual(4);
    view.rerender(<Label text="Changed Full Title" />);
    paint();
    expect(view.getByText('Changed Full Title').style.getPropertyValue('--fit')).toBe('0.5');
  });

  it('does not measure or mutate a label removed before the next paint', () => {
    const measured = geometry();
    const view = render(<Label />);
    const label = view.getByText('Long Tournament Title');
    view.unmount();
    paint();
    expect(measured.layouts()).toBe(0);
    expect(label.style.getPropertyValue('--fit')).toBe('');
  });
});
