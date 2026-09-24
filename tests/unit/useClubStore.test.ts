/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useClubStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../src/services/ClubsService', () => ({
  ClubsService: {
    search: vi.fn().mockResolvedValue([]),
    getMyClubs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useClubStore } from '../../src/stores/useClubStore';

describe('useClubStore', () => {
  beforeEach(() => {
    useClubStore.setState({
      searchResults: [],
      isSearching: false,
      activeTab: 'discover',
    });
  });

  it('should start with empty search results', () => {
    expect(useClubStore.getState().searchResults).toEqual([]);
  });

  it('should start with discover tab', () => {
    expect(useClubStore.getState().activeTab).toBe('discover');
  });

  it('should set active tab', () => {
    useClubStore.getState().setActiveTab('my-clubs');
    expect(useClubStore.getState().activeTab).toBe('my-clubs');
  });

  it('should export store with all actions', () => {
    const state = useClubStore.getState();
    expect(typeof state.setActiveTab).toBe('function');
    expect(typeof state.searchClubs).toBe('function');
    expect(typeof state.loadMemberships).toBe('function');
    expect(typeof state.loadClub).toBe('function');
  });

  /* There is no location-based club discovery. The store used to carry a
     "nearby" action that ignored the position it was given and a userLocation
     it persisted to storage, fed by a hook that asked the browser for the
     player's position. None of it may come back without a real feature. */
  it('neither asks for, keeps nor persists a player location', () => {
    const state = useClubStore.getState() as unknown as Record<string, unknown>;
    for (const key of [
      'userLocation',
      'setUserLocation',
      'discoverNearby',
      'nearbyClubs',
      'isDiscovering',
    ]) {
      expect(state, key).not.toHaveProperty(key);
    }
    const partialize = useClubStore.persist.getOptions().partialize!;
    expect(Object.keys(partialize(useClubStore.getState()) as object)).toEqual(['activeTab']);
  });
});
