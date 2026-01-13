/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Hooks Index
 * ═══════════════════════════════════════════════════════════════════════════════
 * Custom React hooks for Club Arena functionality
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useClubStore } from '@/stores/useClubStore';
import { useUnionStore } from '@/stores/useUnionStore';
import { useWalletStore } from '@/stores/useWalletStore';
import { useUserStore } from '@/stores/useUserStore';
import { MembershipService } from '@/services/MembershipService';
import type { ClubMembership, MemberRole } from '@/services/MembershipService';

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
    const { user } = useUserStore();
    const [membership, setMembership] = useState<ClubMembership | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!user?.id || !clubId) {
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        MembershipService.getMembership(clubId, user.id)
            .then(setMembership)
            .catch(console.error)
            .finally(() => setIsLoading(false));
    }, [clubId, user?.id]);

    const role = membership?.role || null;

    return {
        role,
        membership,
        isLoading,
        isOwner: role === 'club_owner' || role === 'platform_admin',
        isAdmin: role === 'club_admin' || role === 'club_owner' || role === 'platform_admin',
        isAgent: role === 'agent' || role === 'sub_agent',
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
            console.error('Failed to load members:', error);
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
    const { user } = useUserStore();
    const [isMember, setIsMember] = useState(false);

    useEffect(() => {
        if (!user?.id || !clubId) {
            setIsMember(false);
            return;
        }

        MembershipService.getMembership(clubId, user.id)
            .then(m => setIsMember(m?.status === 'active'))
            .catch(() => setIsMember(false));
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
    const {
        activeUnion,
        activeUnionClubs,
        isLoadingUnion,
        loadUnion,
        loadUnionClubs,
    } = useUnionStore();

    useEffect(() => {
        if (unionId) {
            loadUnion(unionId);
        }
    }, [unionId, loadUnion]);

    return {
        union: activeUnion,
        clubs: activeUnionClubs,
        isLoading: isLoadingUnion,
        refresh: () => loadUnion(unionId),
        refreshClubs: () => loadUnionClubs(unionId),
    };
}

/**
 * Get union settlement data
 */
export function useUnionSettlement(unionId: string) {
    const {
        currentPeriod,
        periodHistory,
        consolidatedReport,
        isLoadingSettlement,
        loadCurrentPeriod,
        loadPeriodHistory,
        loadConsolidatedReport,
    } = useUnionStore();

    useEffect(() => {
        loadCurrentPeriod();
        loadPeriodHistory();
        if (unionId) {
            loadConsolidatedReport(unionId);
        }
    }, [unionId, loadCurrentPeriod, loadPeriodHistory, loadConsolidatedReport]);

    return {
        currentPeriod,
        periodHistory,
        consolidatedReport,
        isLoading: isLoadingSettlement,
        refresh: () => {
            loadCurrentPeriod();
            loadPeriodHistory();
            if (unionId) loadConsolidatedReport(unionId);
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get user's wallet balances and operations
 */
export function useWallet() {
    const { user } = useUserStore();
    const {
        balances,
        diamonds,
        isLoadingWallet,
        isLoadingDiamonds,
        loadBalances,
        loadDiamonds,
        lockForBuyIn,
        unlockFromTable,
        internalTransfer,
        mintChips,
    } = useWalletStore();

    useEffect(() => {
        if (user?.id) {
            loadBalances(user.id);
            loadDiamonds(user.id);
        }
    }, [user?.id, loadBalances, loadDiamonds]);

    const totalBalance = useMemo(() =>
        balances.BUSINESS.total + balances.PLAYER.total + balances.PROMO.total,
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
        unlockFromTable,
        internalTransfer,
        mintChips,
        refresh: () => {
            if (user?.id) {
                loadBalances(user.id);
                loadDiamonds(user.id);
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
 * Format chip amount with proper notation
 */
export function useChipFormatter() {
    return useCallback((amount: number, showSign = false): string => {
        const prefix = showSign && amount > 0 ? '+' : '';
        const sign = amount < 0 ? '-' : '';
        const absAmount = Math.abs(amount);

        if (absAmount >= 1000000) {
            return `${prefix}${sign}$${(absAmount / 1000000).toFixed(2)}M`;
        }
        if (absAmount >= 1000) {
            return `${prefix}${sign}$${(absAmount / 1000).toFixed(1)}K`;
        }
        return `${prefix}${sign}$${absAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    }, []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get nearby clubs using geolocation
 */
export function useNearbyClubs(radiusKm = 50) {
    const {
        nearbyClubs,
        isDiscovering,
        userLocation,
        setUserLocation,
        discoverNearby,
    } = useClubStore();

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
                    setGeoError(error.message);
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
        const formatAmount = (n: number) => n >= 1000 ? `${n / 1000}K` : n.toString();
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
