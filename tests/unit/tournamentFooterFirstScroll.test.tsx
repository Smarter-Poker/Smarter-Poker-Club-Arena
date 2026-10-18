import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHideFooterOnScroll } from '../../src/components/club/useHideFooterOnScroll';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('global footer follows the first genuine inner-panel scroll', () => {
  it('hides on the first downward flick, reveals upward and at the bottom', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const panel = document.createElement('div');
    document.body.append(panel);
    Object.defineProperties(panel, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } });
    const { result } = renderHook(() => useHideFooterOnScroll('/tournaments/a'));
    const scroll = (top: number) =>
      act(() => {
        panel.scrollTop = top;
        fireEvent.scroll(panel);
        frames.splice(0).forEach((cb) => cb(0));
      });
    scroll(120);
    expect(result.current.hidden).toBe(true);
    scroll(80);
    expect(result.current.hidden).toBe(false);
    scroll(240);
    expect(result.current.hidden).toBe(true);
    scroll(700);
    expect(result.current.hidden).toBe(false);
    panel.remove();
  });
  it('does not hide for a short inner list or subthreshold travel', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const panel = document.createElement('div');
    document.body.append(panel);
    Object.defineProperties(panel, { scrollHeight: { value: 360 }, clientHeight: { value: 300 } });
    const { result } = renderHook(() => useHideFooterOnScroll('/tournaments/a'));
    act(() => {
      panel.scrollTop = 40;
      fireEvent.scroll(panel);
      frames.splice(0).forEach((cb) => cb(0));
    });
    expect(result.current.hidden).toBe(false);
    panel.remove();
  });
});
