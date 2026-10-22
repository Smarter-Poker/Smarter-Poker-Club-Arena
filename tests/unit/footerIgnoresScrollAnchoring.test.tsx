import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHideFooterOnScroll } from '../../src/components/club/useHideFooterOnScroll';

/**
 * THE PAGE MOVING IS NOT THE READER MOVING (2026-10-19).
 *
 * Post-deploy runs 39232506260 (WebKit) and 39245711984 (Chromium) caught the
 * club footer and the lobby filters hidden with scrollY unchanged and no input:
 * a live re-render shrank and restored a card above the viewport, scroll
 * anchoring moved scrollY up and back down by exactly that height, and the
 * down leg read as a reader travelling down the page. useHideLobbyFiltersOnScroll
 * reads its direction from this hook, so both bars are pinned here.
 */
const frames: FrameRequestCallback[] = [];
let contentHeight = 6000;

function page(y: number, height = contentHeight) {
  contentHeight = height;
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  document.documentElement.scrollTop = y;
  act(() => {
    document.dispatchEvent(new Event('scroll'));
    frames.splice(0).forEach((callback) => callback(0));
  });
}

beforeEach(() => {
  frames.length = 0;
  contentHeight = 6000;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  Object.defineProperty(window, 'innerHeight', {
    value: 800,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    get: () => contentHeight,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a scroll the page made to keep its place is not travel', () => {
  it('stays up when a card above the viewport shrinks and is restored', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(3000);
    page(2900);
    expect(result.current.hidden).toBe(false);

    // A card 300px tall above the reader re-renders at 0 and comes back.
    page(2600, 5700);
    page(2900, 6000);
    expect(result.current.hidden).toBe(false);
  });

  it('stays down when the page keeps its place under a reader travelling down', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    expect(result.current.hidden).toBe(true);

    page(1700, 5700);
    page(2000, 6000);
    expect(result.current.hidden).toBe(true);
  });

  it('still hides for the reader travelling down after the page moved', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(3000);
    page(2900);
    page(2600, 5700);
    page(2900, 6000);
    expect(result.current.hidden).toBe(false);

    page(3200);
    expect(result.current.hidden).toBe(true);
    page(3000);
    expect(result.current.hidden).toBe(false);
  });

  it('reveals for an upward scroll when content below the reader shrinks by the same amount', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    expect(result.current.hidden).toBe(true);

    // The reader travels up 64px while a live card BELOW the viewport gets
    // 64px shorter. That layout change does not move the reader's anchor.
    // Equal scroll and height deltas alone cannot establish scroll anchoring.
    act(() => document.dispatchEvent(new WheelEvent('wheel', { deltaY: -64 })));
    page(1936, 5936);
    expect(result.current.hidden).toBe(false);
  });

  it('retains upward touch travel when live layout changes by the same amount', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    const touch = (type: string, clientY: number) => {
      const event = new Event(type);
      Object.defineProperty(event, 'touches', { value: [{ clientY }] });
      act(() => document.dispatchEvent(event));
    };
    touch('touchstart', 100);
    touch('touchmove', 164);
    page(1936, 5936);
    expect(result.current.hidden).toBe(false);
  });

  it('does not treat input without a scroll as permission for a later layout event', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    act(() => {
      document.dispatchEvent(new WheelEvent('wheel', { deltaY: -64 }));
      frames.splice(0).forEach((callback) => callback(0));
    });
    page(1936, 5936);
    expect(result.current.hidden).toBe(true);
  });

  it('keeps the travel threshold when upward input and layout change coincide', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    act(() => document.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 })));
    page(1990, 5990);
    expect(result.current.hidden).toBe(true);
    page(1960);
    expect(result.current.hidden).toBe(false);
  });

  it('scopes wheel evidence to the inner panel that actually scrolls', () => {
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    document.body.append(panel);
    let height = 1000;
    Object.defineProperties(panel, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 300 },
    });
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    const scroll = (top: number) =>
      act(() => {
        panel.scrollTop = top;
        panel.dispatchEvent(new Event('scroll'));
        frames.splice(0).forEach((callback) => callback(0));
      });
    scroll(120);
    expect(result.current.hidden).toBe(true);
    act(() => panel.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })));
    height = 960;
    scroll(80);
    expect(result.current.hidden).toBe(false);
    panel.remove();
  });

  it('comes back when the page shrinks under a reader at its end', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(4000);
    page(5000);
    expect(result.current.hidden).toBe(true);

    // Content ends 200px sooner; the browser clamps scrollY to the new end.
    page(4800, 5600);
    expect(result.current.hidden).toBe(false);
  });
  it('follows upward wheel chaining from an exhausted inner list to the document', () => {
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    document.body.append(panel);
    Object.defineProperties(panel, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    });
    panel.scrollTop = 0;
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(1000);
    page(2000);
    act(() => panel.dispatchEvent(new WheelEvent('wheel', { deltaY: -64 })));
    page(1936, 5936);
    expect(result.current.hidden).toBe(false);
    panel.remove();
  });
});
