/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableModals (renderHook behavioral tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableModals } from '../../src/hooks/useTableModals';

describe('useTableModals', () => {
  it('should export useTableModals as a function', () => {
    expect(typeof useTableModals).toBe('function');
  });

  it('should start with no active modal', () => {
    const { result } = renderHook(() => useTableModals());
    expect(result.current.activeModal).toBeNull();
  });

  it('should open a modal', () => {
    const { result } = renderHook(() => useTableModals());
    act(() => {
      result.current.openModal('buyIn');
    });
    expect(result.current.activeModal).toBe('buyIn');
  });

  it('should close a modal', () => {
    const { result } = renderHook(() => useTableModals());
    act(() => {
      result.current.openModal('settings');
    });
    act(() => {
      result.current.closeModal();
    });
    expect(result.current.activeModal).toBeNull();
  });

  it('should report isOpen correctly', () => {
    const { result } = renderHook(() => useTableModals());
    act(() => {
      result.current.openModal('cashier');
    });
    expect(result.current.isOpen('cashier')).toBe(true);
    expect(result.current.isOpen('buyIn')).toBe(false);
  });

  it('should enforce mutual exclusivity (only one modal open)', () => {
    const { result } = renderHook(() => useTableModals());
    act(() => {
      result.current.openModal('buyIn');
    });
    act(() => {
      result.current.openModal('settings');
    });
    expect(result.current.activeModal).toBe('settings');
    expect(result.current.isOpen('buyIn')).toBe(false);
  });
});
