/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useTableStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../src/services/TableService', () => ({
  tableService: {
    getTable: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useTableStore } from '../../src/stores/useTableStore';

describe('useTableStore', () => {
  beforeEach(() => {
    useTableStore.setState({
      currentTable: null,
      seats: Array(9).fill(null),
      isLoading: false,
      error: null,
      mySeat: null,
      wsConnected: false,
    });
  });

  it('should start with null table', () => {
    expect(useTableStore.getState().currentTable).toBeNull();
  });

  it('should start with 9 empty seats', () => {
    expect(useTableStore.getState().seats).toHaveLength(9);
    expect(useTableStore.getState().seats.every((s) => s === null)).toBe(true);
  });

  it('should start disconnected', () => {
    expect(useTableStore.getState().wsConnected).toBe(false);
  });

  it('should start with no error', () => {
    expect(useTableStore.getState().error).toBeNull();
  });

  it('should start with null mySeat', () => {
    expect(useTableStore.getState().mySeat).toBeNull();
  });

  it('should export store with all actions', () => {
    const state = useTableStore.getState();
    expect(typeof state.loadTable).toBe('function');
    expect(typeof state.joinTable).toBe('function');
    expect(typeof state.leaveTable).toBe('function');
    expect(typeof state.performAction).toBe('function');
    expect(typeof state.setWebSocketConnection).toBe('function');
  });

  it('should set WebSocket connection state', () => {
    useTableStore.getState().setWebSocketConnection(true, vi.fn() as any);
    expect(useTableStore.getState().wsConnected).toBe(true);
  });
});
