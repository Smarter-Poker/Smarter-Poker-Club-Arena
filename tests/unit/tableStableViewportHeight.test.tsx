import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useTableEnvironment } from '../../src/hooks/useTableEnvironment';
const property = '--sp-table-stable-viewport-h';
let layoutWidth = 320;
let smallHeight = 568;
beforeEach(() => {
  layoutWidth = 320;
  smallHeight = 568;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: 600, scale: 320 / 600 },
  });
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => layoutWidth,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return {
      x: 0,
      y: 0,
      width: 0,
      height:
        this.style.position === 'fixed' && this.style.visibility === 'hidden' ? smallHeight : 0,
      top: 0,
      right: 0,
      bottom: smallHeight,
      left: 0,
      toJSON() {},
    };
  });
  Object.defineProperty(screen, 'width', { configurable: true, value: 390 });
  Object.defineProperty(screen, 'height', { configurable: true, value: 844 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('captures stable height before the phone switches into its scaled desktop viewport', () => {
  renderHook(() => useTableEnvironment('table'));
  expect(document.querySelector('meta[name=viewport]')?.getAttribute('content')).toContain(
    'width=600'
  );
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1065px');
});
it('keeps one original stable height across table switches and browser-control resizing', () => {
  const first = renderHook(
    ({ active }) => useTableEnvironment('first', undefined, { isActive: active }),
    { initialProps: { active: true } }
  );
  layoutWidth = 600;
  window.dispatchEvent(new Event('resize'));
  first.rerender({ active: false });
  expect(document.documentElement.style.getPropertyValue(property)).toBe('');
  const second = renderHook(() => useTableEnvironment('second'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1065px');
  first.unmount();
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1065px');
  second.unmount();
  expect(document.documentElement.style.getPropertyValue(property)).toBe('');
  expect(document.querySelector('meta[name=viewport]')?.getAttribute('content')).toBe(
    'width=device-width, initial-scale=1'
  );
});
it('leaves desktop and inactive-table height under the existing CSS contract', () => {
  Object.defineProperty(screen, 'width', { configurable: true, value: 1024 });
  Object.defineProperty(screen, 'height', { configurable: true, value: 768 });
  renderHook(() => useTableEnvironment('table'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('');
});

it('keeps the existing CSS fallback when stable viewport units cannot be measured', () => {
  smallHeight = 0;
  renderHook(() => useTableEnvironment('table'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('');
});

it('renormalizes a real viewport resize while leaving browser chrome events stable', () => {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: 600, scale: 320 / 600 },
  });
  renderHook(() => useTableEnvironment('table'));
  layoutWidth = 600;
  window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1065px');
  smallHeight = 852;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: 600, scale: 375 / 600 },
  });
  window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1363px');
  window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1363px');
});

it('does not double scale browsers whose stable units already follow the new layout', () => {
  renderHook(() => useTableEnvironment('table'));
  layoutWidth = 600;
  smallHeight = 1065;
  window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1065px');
  smallHeight = 1363;
  window.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue(property)).toBe('1363px');
});
