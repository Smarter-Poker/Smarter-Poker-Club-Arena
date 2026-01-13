/**
 * ♠ CLUB ARENA — Table Store (Zustand)
 * Game state management for poker tables
 */

import { create } from 'zustand';
import { tableService } from '../services/TableService';
import type { PokerTable, HandState, SeatPlayer, ActionType, Card } from '../types/database.types';

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

    // Actions
    loadTable: (tableId: string) => Promise<void>;
    joinTable: (tableId: string, seat: number, buyIn: number) => Promise<void>;
    leaveTable: () => void;

    // Game actions
    performAction: (action: ActionType, amount?: number) => Promise<void>;

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

    joinTable: async (tableId: string, seat: number, buyIn: number) => {
        const { currentTable, seats } = get();
        if (!currentTable) return;

        // In real app, would call tableService.joinTable
        const newSeat: SeatPlayer = {
            seat,
            user_id: 'demo-user',
            username: 'Player123',
            stack: buyIn,
            bet: 0,
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

        // Update table player count
        await tableService.updatePlayerCount(
            tableId,
            newSeats.filter(Boolean).length
        );
    },

    leaveTable: () => {
        const { currentTable, mySeat, seats } = get();
        if (!currentTable || mySeat === null) return;

        const newSeats = [...seats];
        newSeats[mySeat - 1] = null;

        // Update player count
        tableService.updatePlayerCount(
            currentTable.id,
            newSeats.filter(Boolean).length
        );

        set({
            mySeat: null,
            myCards: [],
            myStack: 0,
            seats: newSeats,
        });
    },

    performAction: async (action: ActionType, amount?: number) => {
        const { mySeat, myStack, pot, currentBet } = get();
        if (mySeat === null) return;

        // Update local state immediately (optimistic)
        switch (action) {
            case 'fold':
                set((state) => {
                    const newSeats = [...state.seats];
                    const seat = newSeats[mySeat - 1];
                    if (seat) seat.is_folded = true;
                    return { seats: newSeats, isMyTurn: false };
                });
                break;

            case 'check':
                set({ isMyTurn: false });
                break;

            case 'call':
                const callAmount = currentBet - (get().seats[mySeat - 1]?.bet || 0);
                set((state) => {
                    const newSeats = [...state.seats];
                    const seat = newSeats[mySeat - 1];
                    if (seat) {
                        seat.bet = currentBet;
                        seat.stack -= callAmount;
                    }
                    return {
                        seats: newSeats,
                        pot: pot + callAmount,
                        myStack: myStack - callAmount,
                        isMyTurn: false,
                    };
                });
                break;

            case 'bet':
            case 'raise':
                if (!amount) return;
                set((state) => {
                    const newSeats = [...state.seats];
                    const seat = newSeats[mySeat - 1];
                    if (seat) {
                        seat.bet = amount;
                        seat.stack -= amount;
                    }
                    return {
                        seats: newSeats,
                        pot: pot + amount,
                        currentBet: amount,
                        myStack: myStack - amount,
                        isMyTurn: false,
                    };
                });
                break;

            case 'all_in':
                set((state) => {
                    const newSeats = [...state.seats];
                    const seat = newSeats[mySeat - 1];
                    if (seat) {
                        seat.bet = seat.stack;
                        seat.is_all_in = true;
                        seat.stack = 0;
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

        // In real app, would send to server via WebSocket
        console.log(`Action: ${action}${amount ? ` $${amount}` : ''}`);
    },

    subscribeToUpdates: () => {
        const { currentTable } = get();
        if (!currentTable) return () => { };

        // Subscribe to table updates
        const unsubTable = tableService.subscribeToTable(
            currentTable.id,
            (table) => set({ currentTable: table })
        );

        // Subscribe to hand updates
        const unsubHand = tableService.subscribeToHand(
            currentTable.id,
            (hand) => {
                set({
                    currentHand: hand,
                    communityCards: hand.community_cards,
                    pot: hand.pot,
                    currentBet: hand.current_bet,
                });
            }
        );

        return () => {
            unsubTable();
            unsubHand();
        };
    },

    reset: () => set(initialState),
}));
