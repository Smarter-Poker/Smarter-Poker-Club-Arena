/**
 * ♠ CLUB ARENA — Table Store (Zustand)
 * Game state management for poker tables
 */

import { create } from 'zustand';
import { tableService } from '../services/TableService';
import { masterBus } from '../core/MasterBus';
import type { PokerTable, HandState, SeatPlayer, ActionType, Card } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

// WebSocket send function type
type SendActionFn = (action: string, data: Record<string, unknown>) => Promise<boolean>;

interface TableState {
  // Current table
  currentTable: PokerTable | null;
  isLoading: boolean;
  error: string | null;

  // Hand state
  currentHand: HandState | null;
  communityCards: Card[];
  pot: number;
  currentBet: number;

  // Player's state
  mySeat: number | null;
  myCards: Card[];
  myStack: number;
  isMyTurn: boolean;

  // All players
  seats: (SeatPlayer | null)[];

  // WebSocket connection
  wsConnected: boolean;
  wsSendAction: SendActionFn | null;

  // Actions
  loadTable: (tableId: string) => Promise<void>;
  joinTable: (
    tableId: string,
    seat: number,
    buyIn: number,
    userId: string,
    username: string
  ) => Promise<void>;
  leaveTable: () => void;

  // Game actions
  performAction: (action: ActionType, amount?: number) => Promise<void>;

  // WebSocket integration
  setWebSocketConnection: (connected: boolean, sendAction: SendActionFn | null) => void;

  // Real-time
  subscribeToUpdates: () => () => void;

  // Reset
  reset: () => void;
}

const EMPTY_SEATS = Array(9).fill(null);

const initialState = {
  currentTable: null,
  isLoading: false,
  error: null,
  currentHand: null,
  communityCards: [],
  pot: 0,
  currentBet: 0,
  mySeat: null,
  myCards: [],
  myStack: 0,
  isMyTurn: false,
  seats: EMPTY_SEATS,
  wsConnected: false,
  wsSendAction: null,
};

export const useTableStore = create<TableState>((set, get) => ({
  ...initialState,

  loadTable: async (tableId: string) => {
    set({ isLoading: true, error: null });
    try {
      const table = await tableService.getTable(tableId);
      if (!table) {
        set({ error: 'Table not found', isLoading: false });
        return;
      }
      set({
        currentTable: table,
        isLoading: false,
        seats: EMPTY_SEATS.slice(0, table.max_players),
      });
    } catch (error) {
      set({ error: 'Failed to load table', isLoading: false });
    }
  },

  joinTable: async (
    tableId: string,
    seat: number,
    buyIn: number,
    userId: string,
    username: string
  ) => {
    const { currentTable, seats } = get();
    if (!currentTable) return;

    // Create seat player from actual user data
    const newSeat: SeatPlayer = {
      seat,
      user_id: userId,
      username: username,
      stack: buyIn,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };

    const newSeats = [...seats];
    newSeats[seat - 1] = newSeat;

    set({
      mySeat: seat,
      myStack: buyIn,
      seats: newSeats,
    });

    // Notify Master Bus — include userId so MultiTablePage can filter to own events only
    masterBus.emit('TABLE_SEATED', { tableId, seat, userId });

    // Update table player count (non-blocking — seat is already visually taken)
    try {
      await tableService.updatePlayerCount(tableId, newSeats.filter(Boolean).length);
    } catch (err) {
      reportError(err, 'useTableStore.Failed_to_update_player_count_after_join');
    }
  },

  leaveTable: () => {
    const { currentTable, mySeat, seats } = get();
    if (!currentTable || mySeat === null) return;

    const newSeats = [...seats];
    newSeats[mySeat - 1] = null;

    // Update player count (fire-and-forget with error handling)
    tableService
      .updatePlayerCount(currentTable.id, newSeats.filter(Boolean).length)
      .catch((err: unknown) => {
        reportError(err, 'useTableStore.Failed_to_update_player_count_after_leav');
      });

    set({
      mySeat: null,
      myCards: [],
      myStack: 0,
      seats: newSeats,
    });
  },

  performAction: async (action: ActionType, amount?: number) => {
    const { mySeat, myStack, pot, currentBet, wsSendAction, wsConnected } = get();
    if (mySeat === null) return;

    // Validate bet/raise amounts before processing
    if ((action === 'bet' || action === 'raise') && amount !== undefined) {
      if (amount <= 0 || !Number.isFinite(amount)) {
        console.warn('[TableStore] Invalid bet amount:', amount);
        return;
      }
      if (amount > myStack) {
        console.warn('[TableStore] Bet exceeds stack, clamping to all-in');
        amount = myStack;
      }
    }

    // Snapshot for rollback on WS failure
    const snapshot = {
      seats: get().seats,
      pot: get().pot,
      currentBet: get().currentBet,
      myStack: get().myStack,
      isMyTurn: get().isMyTurn,
    };

    // Update local state immediately (optimistic)
    switch (action) {
      case 'fold':
        set((state) => {
          const newSeats = [...state.seats];
          const seat = newSeats[mySeat - 1];
          if (seat) newSeats[mySeat - 1] = { ...seat, is_folded: true };
          return { seats: newSeats, isMyTurn: false };
        });
        break;

      case 'check':
        set({ isMyTurn: false });
        break;

      case 'call': {
        const callAmount = currentBet - (get().seats[mySeat - 1]?.bet || 0);
        set((state) => {
          const newSeats = [...state.seats];
          const seat = newSeats[mySeat - 1];
          if (seat) {
            newSeats[mySeat - 1] = { ...seat, bet: currentBet, stack: seat.stack - callAmount };
          }
          return {
            seats: newSeats,
            pot: pot + callAmount,
            myStack: myStack - callAmount,
            isMyTurn: false,
          };
        });
        break;
      }

      case 'bet':
      case 'raise':
        if (!amount) return;
        set((state) => {
          const newSeats = [...state.seats];
          const seat = newSeats[mySeat - 1];
          if (seat) {
            // Clamp to available stack to prevent negative balance
            const betAmount = Math.min(amount, seat.stack);
            newSeats[mySeat - 1] = { ...seat, bet: betAmount, stack: seat.stack - betAmount };
          }
          const effectiveAmount = Math.min(amount, myStack);
          return {
            seats: newSeats,
            pot: pot + effectiveAmount,
            currentBet: amount,
            myStack: myStack - effectiveAmount,
            isMyTurn: false,
          };
        });
        break;

      case 'all_in':
        set((state) => {
          const newSeats = [...state.seats];
          const seat = newSeats[mySeat - 1];
          if (seat) {
            newSeats[mySeat - 1] = { ...seat, bet: seat.stack, is_all_in: true, stack: 0 };
          }
          return {
            seats: newSeats,
            pot: pot + myStack,
            myStack: 0,
            isMyTurn: false,
          };
        });
        break;
    }

    // Send action via WebSocket if connected
    if (wsConnected && wsSendAction) {
      const success = await wsSendAction(action, {
        amount: amount || 0,
        seat: mySeat,
      });
      if (!success) {
        console.warn(
          '[TableStore] Failed to send action via WebSocket - rolling back optimistic update'
        );
        set({
          seats: snapshot.seats,
          pot: snapshot.pot,
          currentBet: snapshot.currentBet,
          myStack: snapshot.myStack,
          isMyTurn: snapshot.isMyTurn,
        });
      }
    } else {
      console.warn('[TableStore] WebSocket not connected - rolling back');
      set({
        seats: snapshot.seats,
        pot: snapshot.pot,
        currentBet: snapshot.currentBet,
        myStack: snapshot.myStack,
        isMyTurn: snapshot.isMyTurn,
      });
    }
  },

  setWebSocketConnection: (connected: boolean, sendAction: SendActionFn | null) => {
    set({ wsConnected: connected, wsSendAction: sendAction });
  },

  subscribeToUpdates: () => {
    const { currentTable } = get();
    if (!currentTable) return () => {};

    // Subscribe to table updates (postgres-changes on `tables` row — row-level
    // metadata only; NOT live game state)
    const unsubTable = tableService.subscribeToTable(currentTable.id, (table) =>
      set({ currentTable: table })
    );

    // Phase 1.1 PR-5 (NO-GO-2): hand-state subscription DELETED.
    // Live game state now flows through the engine WebSocket consumed by
    // useEngineTableState in TablePage.tsx — not through this store's
    // currentHand slice. Any consumer that needs live hand state must
    // read it off TablePage's tableState / EngineStateClient snapshot.
    return () => {
      unsubTable();
    };
  },

  reset: () => set(initialState),
}));
