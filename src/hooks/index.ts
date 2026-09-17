/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Hooks Index
 * ═══════════════════════════════════════════════════════════════════════════════
 * Custom React hooks for Club Arena functionality
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useClubStore } from '@/stores/useClubStore';
import { useUnionStore } from '@/stores/useUnionStore';
import { useWalletStore } from '@/stores/useWalletStore';
import { useAuthUser } from './useAuthUser';
import { MembershipService } from '@/services/MembershipService';
import { isAgentRole, isClubPrincipal, isClubStaff } from '@/types/clubRoles';
import type { ClubMembership, MemberRole } from '@/services/MembershipService';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
// ═══════════════════════════════════════════════════════════════════════════════
// CLUB HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current user's role in a specific club
 */
export function useClubRole(clubId: string): {
  role: MemberRole | null;
  membership: ClubMembership | null;
  isLoading: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isAgent: boolean;
  canManageMembers: boolean;
  canManageSettings: boolean;
  canCreateTables: boolean;
  canViewFinancials: boolean;
} {
  const { user } = useAuthUser();
  const [membership, setMembership] = useState<ClubMembership | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    /* THE LAST ANSWER TO LAND IS NOT THE ANSWER TO THE CURRENT QUESTION
       (2026-09-10). This had no cancellation flag and no ordering fence, so
       switching clubs while a read was in flight let the PREVIOUS club's
       membership resolve last and win - and isAdmin / canManageMembers /
       canViewFinancials then described the wrong club. The stale membership
       is also cleared on every change so nothing renders the old club's
       permissions while the new club's are being read. */
    if (!user?.id || !clubId) {
      setMembership(null);
      setIsLoading(false);
      return undefined;
    }

    let cancelled = false;
    setMembership(null);
    setIsLoading(true);
    MembershipService.getMembership(clubId, user.id)
      .then((m) => {
        if (!cancelled) setMembership(m);
      })
      .catch((e) => {
        if (!cancelled) reportError(e, 'useClubRole.getMembership');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  const role = membership?.role || null;

  return {
    role,
    membership,
    isLoading,
    // These compared against 'club_owner' / 'club_admin' / 'platform_admin',
    // none of which club_members.role has ever contained, so all three were
    // permanently false. Ask clubRoles, which is the definition.
    isOwner: isClubPrincipal(role),
    isAdmin: isClubStaff(role),
    isAgent: isAgentRole(role),
    canManageMembers: MembershipService.canPerformAction(role || 'guest', 'manage_members'),
    canManageSettings: MembershipService.canPerformAction(role || 'guest', 'change_settings'),
    canCreateTables: MembershipService.canPerformAction(role || 'guest', 'create_tables'),
    canViewFinancials: MembershipService.canPerformAction(role || 'guest', 'view_financials'),
  };
}

/**
 * Get members of a club with counts
 */
export function useClubMembers(clubId: string) {
  const [members, setMembers] = useState<ClubMembership[]>([]);
  const [counts, setCounts] = useState({ total: 0, active: 0, pending: 0, online: 0 });
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clubId) return;
    setIsLoading(true);
    try {
      const [memberList, memberCounts] = await Promise.all([
        MembershipService.getClubMembers(clubId),
        MembershipService.getMemberCounts(clubId),
      ]);
      setMembers(memberList);
      setCounts(memberCounts);
    } catch (error) {
      reportError(error, 'index.Failed_to_load_members');
    } finally {
      setIsLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { members, counts, isLoading, refresh };
}

/**
 * Check if user is a member of a club
 */
export function useIsMember(clubId: string): boolean {
  const { user } = useAuthUser();
  const [isMember, setIsMember] = useState(false);

  useEffect(() => {
    // Same fence as useClubRole: a stale answer for the previous club must
    // not land after the current club's.
    if (!user?.id || !clubId) {
      setIsMember(false);
      return undefined;
    }

    let cancelled = false;
    setIsMember(false);
    MembershipService.getMembership(clubId, user.id)
      .then((m) => {
        if (!cancelled) setIsMember(m?.status === 'active');
      })
      .catch(() => {
        if (!cancelled) setIsMember(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  return isMember;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNION HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current union and clubs
 */
export function useUnion(unionId: string) {
  const { activeUnion, activeUnionClubs, isLoadingUnion, loadUnion, loadUnionClubs } =
    useUnionStore();

  useEffect(() => {
    if (unionId) {
      loadUnion(unionId);
    }
  }, [unionId, loadUnion]);

  return {
    union: activeUnion?.id === unionId.toLowerCase() ? activeUnion : null,
    clubs: activeUnion?.id === unionId.toLowerCase() ? activeUnionClubs : [],
    isLoading: isLoadingUnion,
    refresh: () => loadUnion(unionId),
    refreshClubs: () => loadUnionClubs(unionId),
  };
}

/**
 * Get union settlement data
 */
export function useUnionSettlement(unionId: string) {
  const { user } = useAuthUser();
  const {
    accountingScopeId,
    accountingObservation,
    accountingUnavailable,
    accountingCurrent,
    periodHistory,
    isLoadingSettlement,
    loadAccounting,
  } = useUnionStore();
  useEffect(() => {
    if (unionId && user?.id)
      void loadAccounting(unionId).catch((error) => reportError(error, 'useUnionSettlement'));
  }, [unionId, user?.id, loadAccounting]);
  const current = accountingScopeId === unionId.toLowerCase() && accountingCurrent?.() === true;
  return {
    currentPeriod: null,
    consolidatedReport: null,
    observation: current ? accountingObservation : null,
    periodHistory: current ? periodHistory : [],
    unavailable: !current || accountingUnavailable,
    isLoading: current && isLoadingSettlement,
    refresh: () => loadAccounting(unionId),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get user's wallet balances and operations
 */
export function useWallet() {
  const { user } = useAuthUser();
  const {
    balances,
    diamonds,
    isLoadingWallet,
    isLoadingDiamonds,
    loadBalances,
    loadDiamonds,
    lockForBuyIn,
    internalTransfer,
    mintChips,
  } = useWalletStore();

  useEffect(() => {
    if (user?.id) {
      loadBalances(user.id);
      loadDiamonds(user.id);
    }
  }, [user?.id, loadBalances, loadDiamonds]);

  const totalBalance = useMemo(
    () => balances.BUSINESS.total + balances.PLAYER.total + balances.PROMO.total,
    [balances]
  );

  const availableForPlay = balances.PLAYER.available;

  return {
    balances,
    diamonds,
    totalBalance,
    availableForPlay,
    isLoading: isLoadingWallet || isLoadingDiamonds,
    lockForBuyIn,
    // AUDIT M17: unlockFromTable is gone. Table cash-out is engine-owned via
    // (removed 2026-09-04: no partial cash-out at a cash table); see WalletService.
    internalTransfer,
    mintChips,
    // force: this is the EXPLICIT "give me fresh numbers" entry point. A caller
    // reaching for refresh() is stating that what is on screen may be wrong, so
    // the store's freshness window (which exists to make mounts free) must not
    // turn it into a no-op.
    refresh: () => {
      if (user?.id) {
        loadBalances(user.id, { force: true });
        loadDiamonds(user.id, { force: true });
      }
    },
  };
}

/**
 * Check if user can afford a buy-in
 */
export function useCanAfford(amount: number): boolean {
  const { balances } = useWalletStore();
  return balances.PLAYER.available >= amount;
}

/**
 * Format chip amount — EXACT precision, NO rounding, NO abbreviations.
 * Every value down to the penny.
 */
export function useChipFormatter() {
  return useCallback((amount: number, showSign = false): string => {
    const prefix = showSign && amount > 0 ? '+' : '';
    const sign = amount < 0 ? '-' : '';
    const absAmount = Math.abs(amount);
    const formatted = absAmount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${prefix}${sign}${formatted}`;
  }, []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get nearby clubs using geolocation
 */
export function useNearbyClubs(radiusKm = 50) {
  const { nearbyClubs, isDiscovering, userLocation, setUserLocation, discoverNearby } =
    useClubStore();

  const [geoError, setGeoError] = useState<string | null>(null);

  // Request geolocation on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError('Geolocation not supported');
      return;
    }

    if (!userLocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            club_id: '', // User's location, not a club
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (error) => {
          setGeoError(safeErrorMessage(error));
        }
      );
    }
  }, [userLocation, setUserLocation]);

  // Discover when location is available
  useEffect(() => {
    if (userLocation) {
      discoverNearby(radiusKm);
    }
  }, [userLocation, radiusKm, discoverNearby]);

  return {
    clubs: nearbyClubs,
    isLoading: isDiscovering,
    hasLocation: !!userLocation,
    error: geoError,
    refresh: () => discoverNearby(radiusKm),
  };
}

/**
 * Search clubs
 */
export function useClubSearch() {
  const { searchResults, isSearching, searchClubs } = useClubStore();
  const [query, setQuery] = useState('');

  // Debounced search
  useEffect(() => {
    if (!query.trim()) return;

    const timeout = setTimeout(() => {
      searchClubs(query);
    }, 300);

    return () => clearTimeout(timeout);
  }, [query, searchClubs]);

  return {
    query,
    setQuery,
    results: searchResults,
    isSearching,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format poker stakes (e.g., "1/2", "5/10")
 */
export function useStakesFormatter() {
  return useCallback((smallBlind: number, bigBlind: number): string => {
    const formatAmount = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${formatAmount(smallBlind)}/${formatAmount(bigBlind)}`;
  }, []);
}

/**
 * Format time duration
 */
export function useDurationFormatter() {
  return useCallback((ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }, []);
}

/**
 * Countdown timer hook
 */
export function useCountdown(endTime: Date | null) {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    if (!endTime) {
      setRemaining(0);
      return;
    }

    const update = () => {
      const now = Date.now();
      const end = endTime.getTime();
      setRemaining(Math.max(0, end - now));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [endTime]);

  return remaining;
}

// Export all hooks
export default {
  useClubRole,
  useClubMembers,
  useIsMember,
  useUnion,
  useUnionSettlement,
  useWallet,
  useCanAfford,
  useChipFormatter,
  useNearbyClubs,
  useClubSearch,
  useStakesFormatter,
  useDurationFormatter,
  useCountdown,
};

// Re-export animation hooks
export { useStaggerAnimation } from './useStaggerAnimation';

// Re-export realtime master bus hook
export {
  useMasterBusChannel,
  type UseMasterBusChannelOptions,
  type PostgresChangeEvent,
} from './useMasterBusChannel';

// Re-export masterBus subscription hooks
export { useMasterBusSubscription, useMasterBusSubscriptions } from './useMasterBusSubscription';

// Re-export utility hooks
export { useAuthUser } from './useAuthUser';
export { useDebounce } from './useDebounce';
export { useFocusTrap } from './useFocusTrap';
export { useIsMounted } from './useIsMounted';
export { useVirtualScroll } from './useVirtualScroll';
export { useVisibilityRefresh } from './useVisibilityRefresh';
export { useSwipeAction } from './useSwipeAction';
export { useSwipeTabs } from './useSwipeTabs';
export { useTabKeepAlive } from './useTabKeepAlive';
export { useFrameBudgetMonitor } from './useFrameBudgetMonitor';
