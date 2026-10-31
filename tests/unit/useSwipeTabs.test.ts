/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useSwipeTabs (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSwipeTabs } from '../../src/hooks/useSwipeTabs';

describe('useSwipeTabs', () => {
  it('should export useSwipeTabs as a function', () => {
    expect(typeof useSwipeTabs).toBe('function');
  });

  it('should return pointer event handlers and style', () => {
    const onTabChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipeTabs({ tabs: ['a', 'b', 'c'], activeTab: 'a', onTabChange })
    );
    expect(typeof result.current.onPointerDown).toBe('function');
    expect(typeof result.current.onPointerUp).toBe('function');
    expect(typeof result.current.onPointerCancel).toBe('function');
    expect(result.current.style).toBeDefined();
  });

  it('should have touchAction pan-y in style', () => {
    const onTabChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipeTabs({ tabs: ['a', 'b'], activeTab: 'a', onTabChange })
    );
    expect(result.current.style.touchAction).toBe('pan-y');
  });
});

describe('descendant control pointer ownership', () => {
  function harness(markup: string) {
    const onTabChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipeTabs({ tabs: ['a', 'b'], activeTab: 'a', onTabChange })
    );
    const host = document.createElement('div');
    host.innerHTML = markup;
    const capture = vi.fn();
    host.setPointerCapture = capture;
    const target = host.querySelector('[data-target]')!;
    const event = (x: number) =>
      ({
        currentTarget: host,
        target,
        pointerId: 1,
        clientX: x,
        clientY: 10,
      }) as unknown as React.PointerEvent;
    return { result, host, target, capture, onTabChange, event };
  }
  it.each([
    '<button><span data-target>Show More</span></button>',
    '<a href="/stats"><span data-target>Ledger</span></a>',
    '<input data-target>',
    '<select data-target><option>All</option></select>',
    '<textarea data-target></textarea>',
    '<label data-target>Search</label>',
    '<details><summary data-target>Scope</summary></details>',
    '<div contenteditable="true"><span data-target>Text</span></div>',
    ...['button', 'slider'].map(
      (role) => `<div role="${role}"><span data-target>Control</span></div>`
    ),
  ])('leaves %s with its control instead of capturing or changing tabs', (markup) => {
    const probe = harness(markup);
    probe.result.current.onPointerDown(probe.event(100));
    probe.result.current.onPointerUp(probe.event(0));
    expect(probe.capture).not.toHaveBeenCalled();
    expect(probe.onTabChange).not.toHaveBeenCalled();
  });
  it('preserves capture and horizontal swipes on ordinary content', () => {
    const probe = harness('<p data-target>Readout</p>');
    probe.result.current.onPointerDown(probe.event(100));
    probe.result.current.onPointerUp(probe.event(0));
    expect(probe.capture).toHaveBeenCalledWith(1);
    expect(probe.onTabChange).toHaveBeenCalledWith('b');
  });
  it('clears a previous swipe when the next gesture belongs to a control', () => {
    const probe = harness('<button data-target>More</button>');
    probe.result.current.onPointerDown({ ...probe.event(100), target: probe.host });
    probe.result.current.onPointerDown(probe.event(100));
    probe.result.current.onPointerUp(probe.event(0));
    expect(probe.onTabChange).not.toHaveBeenCalled();
  });
  it('does not mistake an interactive ancestor outside the pane for a descendant', () => {
    const probe = harness('<p data-target>Readout</p>');
    const outside = document.createElement('div');
    outside.setAttribute('role', 'button');
    outside.append(probe.host);
    probe.result.current.onPointerDown(probe.event(100));
    probe.result.current.onPointerUp(probe.event(0));
    expect(probe.capture).toHaveBeenCalledWith(1);
    expect(probe.onTabChange).toHaveBeenCalledWith('b');
  });
});
