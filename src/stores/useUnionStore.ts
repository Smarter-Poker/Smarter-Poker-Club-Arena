/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Union Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state management for unions, member clubs, and settlement
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { UnionService } from '@/services/UnionService';
import { SettlementService } from '@/services/SettlementService';
import type {
    Union,
    UnionClub,
    UnionConsolidatedReport,
} from '@/services/UnionService';
import type {
    SettlementPeriod,
    SettlementSummary,
    ClubSettlement,
    AgentSettlement,
} from '@/services/SettlementService';

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 STORE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UnionState {
    // Union List
    unions: Union[];
    isLoadingUnions: boolean;

    // Active union context
    activeUnion: Union | null;
    activeUnionClubs: UnionClub[];
    isLoadingUnion: boolean;

    // Settlement & Financials
    currentPeriod: SettlementPeriod | null;
    periodHistory: SettlementPeriod[];
    settlementSummary: SettlementSummary | null;
    consolidatedReport: UnionConsolidatedReport | null;
    clubSettlements: ClubSettlement[];
    agentSettlements: AgentSettlement[];
    isLoadingSettlement: boolean;

    // Active Tab State
    activeTab: 'overview' | 'clubs' | 'tables' | 'financials';

    // Actions
    loadUnions: () => Promise<void>;
    loadUnion: (unionId: string) => Promise<void>;
    loadUnionClubs: (unionId: string) => Promise<void>;
    createUnion: (name: string, description: string, ownerId: string) => Promise<Union | null>;
    joinUnion: (unionId: string, clubId: string) => Promise<boolean>;
    leaveUnion: (unionId: string, clubId: string) => Promise<boolean>;
    approveClub: (unionId: string, clubId: string) => Promise<boolean>;

    // Settlement Actions
    loadCurrentPeriod: () => Promise<void>;
    loadPeriodHistory: (limit?: number) => Promise<void>;
    loadSettlementSummary: (periodId: string) => Promise<void>;
    loadConsolidatedReport: (unionId: string, periodId?: string) => Promise<void>;
    loadClubSettlements: (periodId: string) => Promise<void>;
    loadAgentSettlements: (periodId: string) => Promise<void>;
    closePeriod: (periodId: string) => Promise<boolean>;
    executeMondayPayouts: (periodId: string) => Promise<{ agentsPaid: number; playersWithRakeback: number; totalDisbursed: number }>;

    setActiveTab: (tab: 'overview' | 'clubs' | 'tables' | 'financials') => void;
    reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏪 STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

const initialState = {
    unions: [] as Union[],
    isLoadingUnions: false,
    activeUnion: null as Union | null,
    activeUnionClubs: [] as UnionClub[],
    isLoadingUnion: false,
    currentPeriod: null as SettlementPeriod | null,
    periodHistory: [] as SettlementPeriod[],
    settlementSummary: null as SettlementSummary | null,
    consolidatedReport: null as UnionConsolidatedReport | null,
    clubSettlements: [] as ClubSettlement[],
    agentSettlements: [] as AgentSettlement[],
    isLoadingSettlement: false,
    activeTab: 'overview' as const,
};

export const useUnionStore = create<UnionState>()(
    persist(
        (set, get) => ({
            ...initialState,

            // ─────────────────────────────────────────────────────────────────────
            // UNION OPERATIONS
            // ─────────────────────────────────────────────────────────────────────

            loadUnions: async () => {
                set({ isLoadingUnions: true });
                try {
                    const unions = await UnionService.getUnions();
                    set({ unions });
                } catch (error) {
                    console.error('🔴 Load unions failed:', error);
                } finally {
                    set({ isLoadingUnions: false });
                }
            },

            loadUnion: async (unionId) => {
                set({ isLoadingUnion: true, activeUnion: null });
                try {
                    const union = await UnionService.getUnionById(unionId);
                    set({ activeUnion: union });
                    // Also load member clubs
                    await get().loadUnionClubs(unionId);
                } catch (error) {
                    console.error('🔴 Load union failed:', error);
                } finally {
                    set({ isLoadingUnion: false });
                }
            },

            loadUnionClubs: async (unionId) => {
                try {
                    const clubs = await UnionService.getUnionClubs(unionId);
                    set({ activeUnionClubs: clubs });
                } catch (error) {
                    console.error('🔴 Load union clubs failed:', error);
                }
            },

            createUnion: async (name, description, ownerId) => {
                try {
                    const union = await UnionService.createUnion(name, description, ownerId);
                    if (union) {
                        // Refresh unions list
                        await get().loadUnions();
                    }
                    return union;
                } catch (error) {
                    console.error('🔴 Create union failed:', error);
                    throw error;
                }
            },

            joinUnion: async (unionId, clubId) => {
                try {
                    const success = await UnionService.joinUnion(unionId, clubId);
                    if (success) {
                        await get().loadUnionClubs(unionId);
                    }
                    return success;
                } catch (error) {
                    console.error('🔴 Join union failed:', error);
                    throw error;
                }
            },

            leaveUnion: async (unionId, clubId) => {
                try {
                    const success = await UnionService.leaveUnion(unionId, clubId);
                    if (success) {
                        await get().loadUnionClubs(unionId);
                    }
                    return success;
                } catch (error) {
                    console.error('🔴 Leave union failed:', error);
                    throw error;
                }
            },

            approveClub: async (unionId, clubId) => {
                try {
                    const success = await UnionService.approveClub(unionId, clubId);
                    if (success) {
                        await get().loadUnionClubs(unionId);
                    }
                    return success;
                } catch (error) {
                    console.error('🔴 Approve club failed:', error);
                    throw error;
                }
            },

            // ─────────────────────────────────────────────────────────────────────
            // SETTLEMENT & FINANCIAL OPERATIONS
            // ─────────────────────────────────────────────────────────────────────

            loadCurrentPeriod: async () => {
                set({ isLoadingSettlement: true });
                try {
                    const period = await SettlementService.getCurrentPeriod();
                    set({ currentPeriod: period });
                } catch (error) {
                    console.error('🔴 Load current period failed:', error);
                } finally {
                    set({ isLoadingSettlement: false });
                }
            },

            loadPeriodHistory: async (limit = 12) => {
                try {
                    const history = await SettlementService.getPeriodHistory(limit);
                    set({ periodHistory: history });
                } catch (error) {
                    console.error('🔴 Load period history failed:', error);
                }
            },

            loadSettlementSummary: async (periodId) => {
                set({ isLoadingSettlement: true });
                try {
                    const summary = await SettlementService.generateSettlements(periodId);
                    set({
                        settlementSummary: summary,
                        clubSettlements: summary.clubSettlements,
                        agentSettlements: summary.agentSettlements,
                    });
                } catch (error) {
                    console.error('🔴 Load settlement summary failed:', error);
                } finally {
                    set({ isLoadingSettlement: false });
                }
            },

            loadConsolidatedReport: async (unionId, periodId) => {
                set({ isLoadingSettlement: true });
                try {
                    const report = await UnionService.getConsolidatedReport(unionId, periodId);
                    set({ consolidatedReport: report });
                } catch (error) {
                    console.error('🔴 Load consolidated report failed:', error);
                } finally {
                    set({ isLoadingSettlement: false });
                }
            },

            loadClubSettlements: async (periodId) => {
                try {
                    const summary = await SettlementService.generateSettlements(periodId);
                    set({ clubSettlements: summary.clubSettlements });
                } catch (error) {
                    console.error('🔴 Load club settlements failed:', error);
                }
            },

            loadAgentSettlements: async (periodId) => {
                try {
                    const summary = await SettlementService.generateSettlements(periodId);
                    set({ agentSettlements: summary.agentSettlements });
                } catch (error) {
                    console.error('🔴 Load agent settlements failed:', error);
                }
            },

            closePeriod: async (periodId) => {
                try {
                    const success = await SettlementService.closePeriod(periodId);
                    if (success) {
                        await get().loadCurrentPeriod();
                        await get().loadPeriodHistory();
                    }
                    return success;
                } catch (error) {
                    console.error('🔴 Close period failed:', error);
                    throw error;
                }
            },

            executeMondayPayouts: async (periodId) => {
                try {
                    const result = await SettlementService.executeMondayPayouts(periodId);
                    // Refresh after payouts
                    await get().loadCurrentPeriod();
                    return result;
                } catch (error) {
                    console.error('🔴 Execute payouts failed:', error);
                    throw error;
                }
            },

            setActiveTab: (tab) => {
                set({ activeTab: tab });
            },

            reset: () => {
                set(initialState);
            },
        }),
        {
            name: 'union-store',
            partialize: (state) => ({
                // Only persist tab preference
                activeTab: state.activeTab,
            }),
        }
    )
);
