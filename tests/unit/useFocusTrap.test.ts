/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useFocusTrap (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, renderHook, waitFor } from '@testing-library/react';
import { useFocusTrap } from '../../src/hooks/useFocusTrap';

describe('useFocusTrap', () => {
  it('should export useFocusTrap as a function', () => {
    expect(typeof useFocusTrap).toBe('function');
  });

  it('should return a ref object when inactive', () => {
    const { result } = renderHook(() => useFocusTrap(false));
    expect(result.current).toBeDefined();
    expect(result.current.current).toBeNull();
  });

  it('should return a ref object when active', () => {
    const { result } = renderHook(() => useFocusTrap(true));
    expect(result.current).toBeDefined();
  });

  it('should toggle between active and inactive', () => {
    const { result, rerender } = renderHook(({ active }) => useFocusTrap(active), {
      initialProps: { active: false },
    });
    expect(result.current.current).toBeNull();
    rerender({ active: true });
    expect(result.current).toBeDefined();
  });

  it('focuses nominated context without scrolling and traps Tab in either direction', async () => {
    const { result, rerender } = renderHook(
      ({ active }) => useFocusTrap(active, '#dialog-heading'),
      { initialProps: { active: false } }
    );
    const container = document.createElement('div');
    const heading = document.createElement('h2');
    const first = document.createElement('button');
    const last = document.createElement('button');
    heading.id = 'dialog-heading';
    heading.tabIndex = -1;
    container.append(heading, first, last);
    document.body.append(container);
    result.current.current = container;

    rerender({ active: true });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(container.scrollTop).toBe(0);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    heading.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    container.remove();
  });

  it('G-05: with two traps active the most recent one owns Tab, and the outer one takes it back', async () => {
    const build = (label: string) => {
      const box = document.createElement('div');
      const a = document.createElement('button');
      const b = document.createElement('button');
      a.textContent = `${label} first`;
      b.textContent = `${label} last`;
      box.append(a, b);
      document.body.append(box);
      return { box, a, b };
    };
    const outerDom = build('outer');
    const innerDom = build('inner');
    const outer = renderHook(({ active }) => useFocusTrap(active), {
      initialProps: { active: false },
    });
    outer.result.current.current = outerDom.box;
    outer.rerender({ active: true });
    await waitFor(() => expect(outerDom.a).toHaveFocus());

    outerDom.b.focus();
    const inner = renderHook(({ active }) => useFocusTrap(active), {
      initialProps: { active: false },
    });
    inner.result.current.current = innerDom.box;
    inner.rerender({ active: true });
    await waitFor(() => expect(innerDom.a).toHaveFocus());

    // The outer trap is still active but does not pull focus back to itself:
    // a Tab from the inner trap's first control is left to the browser.
    innerDom.a.focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    expect(innerDom.a).toHaveFocus();
    innerDom.b.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(innerDom.a).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(innerDom.b).toHaveFocus();

    // Closing the inner trap returns focus to where it was opened from, and the
    // outer trap owns Tab again.
    inner.rerender({ active: false });
    expect(outerDom.b).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(outerDom.a).toHaveFocus();

    outer.unmount();
    inner.unmount();
    outerDom.box.remove();
    innerDom.box.remove();
  });
});
