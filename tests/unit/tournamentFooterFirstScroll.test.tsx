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

describe('tournament panel resizing is not another swipe', () => {
  it('does not re-hide after revealing at the bottom shrinks the panel and moves its anchor', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    document.body.append(panel);
    let viewportHeight = 300;
    Object.defineProperties(panel, {
      scrollHeight: { value: 700 },
      clientHeight: { get: () => viewportHeight },
    });
    const { result } = renderHook(() => useHideFooterOnScroll('/tournaments/a'));
    const scroll = (top: number) =>
      act(() => {
        panel.scrollTop = top;
        fireEvent.scroll(panel);
        frames.splice(0).forEach((cb) => cb(0));
      });
    scroll(120);
    expect(result.current.hidden).toBe(true);
    // Hiding the 60px footer grows the panel; the browser keeps the same
    // content in view and eventually reaches its new, nearer bottom.
    viewportHeight = 360;
    scroll(120);
    scroll(340);
    expect(result.current.hidden).toBe(false);
    // The footer returns, reducing the panel and exposing another 60px of
    // scroll range. The SAME continuing flick moves into that new range.
    viewportHeight = 300;
    scroll(380);
    expect(result.current.hidden).toBe(false);
    scroll(400);
    expect(result.current.hidden).toBe(false);
    // A real upward run leaves the end; a later down run may hide normally.
    scroll(340);
    scroll(300);
    scroll(340);
    expect(result.current.hidden).toBe(true);
    panel.remove();
  });

  it('rebases a viewport adjustment away from the bottom instead of counting it as travel', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    document.body.append(panel);
    let viewportHeight = 360;
    Object.defineProperties(panel, {
      scrollHeight: { value: 1000 },
      clientHeight: { get: () => viewportHeight },
    });
    const { result } = renderHook(() => useHideFooterOnScroll('/tournaments/a'));
    const scroll = (top: number) =>
      act(() => {
        panel.scrollTop = top;
        fireEvent.scroll(panel);
        frames.splice(0).forEach((cb) => cb(0));
      });
    scroll(200);
    scroll(160);
    expect(result.current.hidden).toBe(false);
    viewportHeight = 300;
    scroll(220);
    expect(result.current.hidden).toBe(false);
    scroll(260);
    expect(result.current.hidden).toBe(true);
    panel.remove();
  });
  it('can hide again when a short list gains real content below the reader', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const panel = document.createElement('div');
    document.body.append(panel);
    let contentHeight = 350;
    Object.defineProperties(panel, {
      scrollHeight: { get: () => contentHeight },
      clientHeight: { value: 300 },
    });
    const { result } = renderHook(() => useHideFooterOnScroll('/tournaments/a'));
    const scroll = (top: number) =>
      act(() => {
        panel.scrollTop = top;
        fireEvent.scroll(panel);
        frames.splice(0).forEach((cb) => cb(0));
      });
    scroll(50);
    expect(result.current.hidden).toBe(false);
    contentHeight = 1000;
    scroll(160);
    expect(result.current.hidden).toBe(true);
    panel.remove();
  });
});
