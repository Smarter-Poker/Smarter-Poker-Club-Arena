/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useUnionStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../src/services/UnionService', () => ({
  UnionService: {
    getUnions: vi.fn().mockResolvedValue([]),
    getUnion: vi.fn().mockResolvedValue(null),
    getUnionClubs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useUnionStore } from '../../src/stores/useUnionStore';

describe('useUnionStore', () => {
  beforeEach(() => {
    useUnionStore.setState({
      unions: [],
      activeUnion: null,
      activeUnionClubs: [],
      isLoadingUnions: false,
      isLoadingUnion: false,
      settlementSummary: null,
      activeTab: 'overview',
    });
  });

  it('should start with empty unions', () => {
    expect(useUnionStore.getState().unions).toEqual([]);
  });

  it('should start with null active union', () => {
    expect(useUnionStore.getState().activeUnion).toBeNull();
  });

  it('should start with overview tab', () => {
    expect(useUnionStore.getState().activeTab).toBe('overview');
  });

  it('should not be loading by default', () => {
    expect(useUnionStore.getState().isLoadingUnions).toBe(false);
    expect(useUnionStore.getState().isLoadingUnion).toBe(false);
  });

  it('should start with null settlement summary', () => {
    expect(useUnionStore.getState().settlementSummary).toBeNull();
  });

  it('should set active tab', () => {
    useUnionStore.getState().setActiveTab('clubs');
    expect(useUnionStore.getState().activeTab).toBe('clubs');
  });

  it('should export store with all actions', () => {
    const state = useUnionStore.getState();
    expect(typeof state.loadUnions).toBe('function');
    expect(typeof state.loadUnion).toBe('function');
    expect(typeof state.setActiveTab).toBe('function');
  });
});
