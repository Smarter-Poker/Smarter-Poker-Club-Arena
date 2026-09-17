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
import { masterBus } from '../core/MasterBus';
import { captureWeeklyAccountingAccount } from '../services/ClubWeeklyAccountingReader';
import { readAccountingRunObservation, latestClosedAccountingWeek, isAccountingUUID,
  type AccountingRunObservation, type AccountingWeek } from '../services/AccountingObservationService';
let accountingRead = 0;
let unionRead = 0;
let detailRead = 0;
let listRead = 0;
let clubRead = 0;


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
  accountingScopeId: string | null;
  accountingObservation: AccountingRunObservation | null;
  accountingUnavailable: boolean;
  accountingCurrent: (() => boolean) | null;
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
  loadAccounting: (unionId: string, week?: AccountingWeek) => Promise<void>;
  loadCurrentPeriod: () => Promise<void>;
  loadPeriodHistory: (limit?: number, unionId?: string) => Promise<void>;
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
  accountingScopeId: null as string|null,
  accountingObservation: null as AccountingRunObservation|null,
  accountingUnavailable: false,
  accountingCurrent: null as (()=>boolean)|null,
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
        const account=captureWeeklyAccountingAccount(), read=++listRead;
        const current=()=>account.isCurrent() && read===listRead;
        set({isLoadingUnions:true,unions:[]});
        try {const unions=await UnionService.getUnions();if(current()) set({unions});}
        catch(error) {if(current()) reportError(error,'useUnionStore.Load_unions_failed');}
        finally {if(current()) set({isLoadingUnions:false});}
      },

      loadUnion: async (unionId) => {
        // Invalidate a different/unknown financial context before any await.
        // A same-union roster refresh must not cancel that union's concurrent observer.
        if (get().accountingScopeId !== unionId.toLowerCase() || get().accountingCurrent?.() !== true) {
          ++accountingRead; ++detailRead;
          set({accountingScopeId:null,accountingCurrent:null,accountingObservation:null,
            accountingUnavailable:false,isLoadingSettlement:false,currentPeriod:null,periodHistory:[],
            consolidatedReport:null,settlementSummary:null,clubSettlements:[],agentSettlements:[]});
        }
        ++clubRead;
        const account=captureWeeklyAccountingAccount(); const read=++unionRead;
        const current=()=>account.isCurrent() && read===unionRead;
        set({ isLoadingUnion:true,activeUnion:null,activeUnionClubs:[] });
        try {
          const union=await UnionService.getUnion(unionId);
          if(!current()) return;
          if(!union || union.id!==unionId.toLowerCase()) throw new Error('Union Is Unavailable');
          const clubs=await UnionService.getUnionClubs(unionId);
          if(current()) set({activeUnion:union,activeUnionClubs:clubs});
        } catch(error) { if(current()) reportError(error,'useUnionStore.Load_union_failed'); }
        finally {if(current()) set({isLoadingUnion:false});}
      },
      loadUnionClubs: async (unionId) => {
        const account=captureWeeklyAccountingAccount(); const read=unionRead, clubsRead=++clubRead;
        const current=()=>account.isCurrent() && read===unionRead && clubsRead===clubRead && get().activeUnion?.id===unionId.toLowerCase();
        if(!current()) return;
        try {const clubs=await UnionService.getUnionClubs(unionId); if(current()) set({activeUnionClubs:clubs});}
        catch(error) {if(current()) reportError(error,'useUnionStore.Load_union_clubs_failed');}
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

      loadAccounting: async (unionId, week=latestClosedAccountingWeek()) => {
        const account=captureWeeklyAccountingAccount();
        if(!isAccountingUUID(unionId)) throw new Error('Union Accounting Scope Is Required');
        const id=unionId.toLowerCase(), read=++accountingRead;
        const current=()=>account.isCurrent() && read===accountingRead;
        set({accountingScopeId:id,accountingCurrent:current,accountingObservation:null,
          accountingUnavailable:false,isLoadingSettlement:true,currentPeriod:null,periodHistory:[],
          consolidatedReport:null,settlementSummary:null,clubSettlements:[],agentSettlements:[]});
        const [observation,history]=await Promise.allSettled([
          readAccountingRunObservation({actorId:account.userId,scopeKind:'union',scopeId:id,...week,isCurrent:current}),
          SettlementService.getPeriodHistory(12,{actorId:account.userId,scopeKind:'union',scopeId:id,isCurrent:current}),
        ]);
        if(!current()) return;
        set({accountingObservation:observation.status==='fulfilled'?observation.value:null,
          periodHistory:history.status==='fulfilled'?history.value:[],
          accountingUnavailable:observation.status==='rejected'||history.status==='rejected',isLoadingSettlement:false});
      },
      // Compatibility entrypoints refuse; the store must not revive retired RPCs.
      loadCurrentPeriod: async () => { await SettlementService.getCurrentPeriod(); },
      loadPeriodHistory: async (limit=12,unionId) => {
        if(!unionId) throw new Error('Union Accounting Scope Is Required');
        const account=captureWeeklyAccountingAccount(), id=unionId.toLowerCase(), read=++accountingRead;
        const current=()=>account.isCurrent() && read===accountingRead;
        set({accountingScopeId:id,accountingCurrent:current,periodHistory:[],accountingObservation:null,accountingUnavailable:false,currentPeriod:null,consolidatedReport:null,
          settlementSummary:null,clubSettlements:[],agentSettlements:[]});
        try {
          const history=await SettlementService.getPeriodHistory(limit,{scopeKind:'union',scopeId:id,actorId:account.userId,isCurrent:current});
          if(current()) set({periodHistory:history});
        } catch(error) {if(current()) set({accountingUnavailable:true}); throw error;}
      },
      loadSettlementSummary: async (periodId) => {
        const id=get().accountingScopeId, captured=get().accountingCurrent;
        if(!id || !captured?.()) throw new Error('Union Accounting Scope Is Required');
        const read=++detailRead,current=()=>captured() && read===detailRead;
        set({settlementSummary:null,clubSettlements:[],agentSettlements:[]});
        const summary=await SettlementService.generateSettlements(periodId,{scopeKind:'union',scopeId:id,isCurrent:current});
        if(current()) set({settlementSummary:summary,clubSettlements:summary.clubSettlements,agentSettlements:summary.agentSettlements});
      },
      loadConsolidatedReport: async (unionId,periodId) => {
        const id=get().accountingScopeId,captured=get().accountingCurrent;
        if(!id || !periodId || id!==unionId.toLowerCase() || !captured?.()) throw new Error('Explicit Union Period Is Required');
        const read=++detailRead,current=()=>captured() && read===detailRead;
        set({consolidatedReport:null});
        await SettlementService.getPeriodRecord(periodId,{scopeKind:'union',scopeId:id,isCurrent:current});
        if(!current()) return;
        const report=await UnionService.getSettlementReportForPeriod(id,periodId);
        if(current()) set({consolidatedReport:report});
      },
      loadClubSettlements: async (periodId) => {await get().loadSettlementSummary(periodId);},
      loadAgentSettlements: async (periodId) => {await get().loadSettlementSummary(periodId);},
      closePeriod: async (periodId) => SettlementService.closePeriod(periodId),
      executeMondayPayouts: async (periodId) => SettlementService.executeMondayPayouts(periodId),

      setActiveTab: (tab) => {
        set({ activeTab: tab });
      },

      reset: () => {
        ++accountingRead; ++unionRead; ++detailRead; ++listRead; ++clubRead;
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

// An account event invalidates in-flight reads and clears visible financial state,
// including A→B→A transitions with no intermediate React render.
masterBus.subscribe('AUTH_STATE_CHANGED',()=>useUnionStore.getState().reset());
