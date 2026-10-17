import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSeatChangeVisibility } from '../../src/hooks/useSeatChangeVisibility';
let viewer = 'first-player';
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: any) => select({ user: { id: viewer } }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  viewer = 'first-player';
});
it('dismissal and menu share the same preference across mounted tables and remounts', () => {
  const hud = renderHook(useSeatChangeVisibility);
  const menu = renderHook(useSeatChangeVisibility);
  expect(hud.result.current.visible).toBe(true);
  act(() => hud.result.current.setVisible(false));
  expect(menu.result.current.visible).toBe(false);
  hud.unmount();
  expect(renderHook(useSeatChangeVisibility).result.current.visible).toBe(false);
  act(() => menu.result.current.setVisible(true));
  expect(menu.result.current.visible).toBe(true);
});
it('one player cannot hide controls for another account', () => {
  const h = renderHook(useSeatChangeVisibility);
  act(() => h.result.current.setVisible(false));
  viewer = 'second-player';
  h.rerender();
  expect(h.result.current.visible).toBe(true);
});
