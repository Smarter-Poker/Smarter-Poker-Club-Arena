/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state management for unions, member clubs, and settlement
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  UnionService,
  type Union,
  type UnionClub,
  type UnionSettlement,
} from '@/services/UnionService';
import { SettlementService } from '@/services/SettlementService';
import type {
  SettlementPeriod,
  SettlementSummary,
  ClubSettlement,
  AgentSettlement,
} from '@/services/SettlementService';
import { reportError } from '../utils/errorReporter';

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
  consolidatedReport: UnionSettlement | null;
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
  executeMondayPayouts: (
    periodId: string
  ) => Promise<{ agentsPaid: number; playersWithRakeback: number; totalDisbursed: number }>;

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
  consolidatedReport: null as UnionSettlement | null,
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
          reportError(error, 'useUnionStore.Load_unions_failed');
        } finally {
          set({ isLoadingUnions: false });
        }
      },

      loadUnion: async (unionId) => {
        set({ isLoadingUnion: true, activeUnion: null });
        try {
          const union = await UnionService.getUnion(unionId);
          set({ activeUnion: union });
          // Also load member clubs
          await get().loadUnionClubs(unionId);
        } catch (error) {
          reportError(error, 'useUnionStore.Load_union_failed');
        } finally {
          set({ isLoadingUnion: false });
        }
      },

      loadUnionClubs: async (unionId) => {
        try {
          const clubs = await UnionService.getUnionClubs(unionId);
          set({ activeUnionClubs: clubs });
        } catch (error) {
          reportError(error, 'useUnionStore.Load_union_clubs_failed');
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
          reportError(error, 'useUnionStore.Create_union_failed');
          throw error;
        }
      },

      joinUnion: async (unionId, clubId) => {
        try {
          const success = await UnionService.addClub(unionId, clubId);
          if (success) {
            await get().loadUnionClubs(unionId);
          }
          return success;
        } catch (error) {
          reportError(error, 'useUnionStore.Join_union_failed');
          throw error;
        }
      },

      leaveUnion: async (unionId, clubId) => {
        try {
          const success = await UnionService.removeClub(unionId, clubId);
          if (success) {
            await get().loadUnionClubs(unionId);
          }
          return success;
        } catch (error) {
          reportError(error, 'useUnionStore.Leave_union_failed');
          throw error;
        }
      },

      approveClub: async (unionId, clubId) => {
        try {
          // Approval is handled via status in this implementation
          const success = await UnionService.addClub(unionId, clubId);
          if (success) {
            await get().loadUnionClubs(unionId);
          }
          return success;
        } catch (error) {
          reportError(error, 'useUnionStore.Approve_club_failed');
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
          reportError(error, 'useUnionStore.Load_current_period_failed');
        } finally {
          set({ isLoadingSettlement: false });
        }
      },

      loadPeriodHistory: async (limit = 12) => {
        try {
          const history = await SettlementService.getPeriodHistory(limit);
          set({ periodHistory: history });
        } catch (error) {
          reportError(error, 'useUnionStore.Load_period_history_failed');
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
          reportError(error, 'useUnionStore.Load_settlement_summary_failed');
        } finally {
          set({ isLoadingSettlement: false });
        }
      },

      loadConsolidatedReport: async (unionId, periodId) => {
        set({ isLoadingSettlement: true });
        try {
          const report = await UnionService.getSettlementReport(unionId, periodId);
          set({ consolidatedReport: report });
        } catch (error) {
          reportError(error, 'useUnionStore.Load_consolidated_report_failed');
        } finally {
          set({ isLoadingSettlement: false });
        }
      },

      loadClubSettlements: async (periodId) => {
        try {
          const summary = await SettlementService.generateSettlements(periodId);
          set({ clubSettlements: summary.clubSettlements });
        } catch (error) {
          reportError(error, 'useUnionStore.Load_club_settlements_failed');
        }
      },

      loadAgentSettlements: async (periodId) => {
        try {
          const summary = await SettlementService.generateSettlements(periodId);
          set({ agentSettlements: summary.agentSettlements });
        } catch (error) {
          reportError(error, 'useUnionStore.Load_agent_settlements_failed');
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
          reportError(error, 'useUnionStore.Close_period_failed');
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
          reportError(error, 'useUnionStore.Execute_payouts_failed');
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
