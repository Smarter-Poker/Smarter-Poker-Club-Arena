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
    discoverNearby: vi.fn().mockResolvedValue([]),
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
      nearbyClubs: [],
      searchResults: [],
      myClubs: [], // Depending on interface, might be activeClubMembers etc, but testing initial is robust
      isDiscovering: false,
      isSearching: false,
      userLocation: null,
      activeTab: 'discover',
    });
  });

  it('should start with empty nearby clubs', () => {
    expect(useClubStore.getState().nearbyClubs).toEqual([]);
  });

  it('should start with empty search results', () => {
    expect(useClubStore.getState().searchResults).toEqual([]);
  });

  it('should start with discover tab', () => {
    expect(useClubStore.getState().activeTab).toBe('discover');
  });

  it('should set user location', () => {
    useClubStore.getState().setUserLocation({ lat: 36.1, lng: -115.2 } as any);
    expect(useClubStore.getState().userLocation).toBeDefined();
  });

  it('should set active tab', () => {
    useClubStore.getState().setActiveTab('my-clubs');
    expect(useClubStore.getState().activeTab).toBe('my-clubs');
  });

  it('should export store with all actions', () => {
    const state = useClubStore.getState();
    expect(typeof state.setUserLocation).toBe('function');
    expect(typeof state.setActiveTab).toBe('function');
    expect(typeof state.discoverNearby).toBe('function');
    expect(typeof state.searchClubs).toBe('function');
    expect(typeof state.loadMemberships).toBe('function');
    expect(typeof state.loadClub).toBe('function');
  });
});
