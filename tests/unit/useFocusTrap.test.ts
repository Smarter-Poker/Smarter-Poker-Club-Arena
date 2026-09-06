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
});
