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
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
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

  it('comes back when the page shrinks under a reader at its end', () => {
    const { result } = renderHook(() => useHideFooterOnScroll('/clubs/a'));
    page(4000);
    page(5000);
    expect(result.current.hidden).toBe(true);

    // Content ends 200px sooner; the browser clamps scrollY to the new end.
    page(4800, 5600);
    expect(result.current.hidden).toBe(false);
  });
});
