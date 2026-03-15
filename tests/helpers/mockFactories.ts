/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED TEST HELPERS — Mock Factories & Test Data
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Centralizes the Supabase proxy mock and common test data factories
 * to eliminate duplication across 55+ test files.
 */

import { vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE PROXY MOCK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a chainable Supabase-like proxy that resolves to { data: null, error: null }
 * for any query chain (select, insert, update, delete, eq, in, etc.)
 *
 * Usage in vi.mock:
 *   vi.mock('../../src/lib/supabase', () => ({
 *     supabase: buildSupabaseMock(),
 *   }));
 */
export function buildChain(): any {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: null, error: null });
      if (prop === 'then')
        return (resolve: (v: any) => void) => resolve({ data: null, error: null });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
}

export function buildSupabaseMock() {
  return {
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    }),
    removeChannel: vi.fn(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER BUS MOCK
// ═══════════════════════════════════════════════════════════════════════════════

export function buildMasterBusMock() {
  return {
    masterBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

export function makePlayer(
  overrides: Partial<{
    id: string;
    name: string;
    seat: number;
    stack: number;
    position: string;
    isWinner: boolean;
    result: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'player-1',
    name: overrides.name ?? 'Alice',
    seat: overrides.seat ?? 0,
    stack: overrides.stack ?? 1000,
    position: overrides.position ?? 'BTN',
    isWinner: overrides.isWinner ?? false,
    result: overrides.result ?? 0,
  };
}

export function makeHandAction(
  overrides: Partial<{
    seat: number;
    action: string;
    amount: number;
    street: string;
  }> = {}
) {
  return {
    seat: overrides.seat ?? 0,
    action: overrides.action ?? 'fold',
    amount: overrides.amount ?? 0,
    street: overrides.street ?? 'PREFLOP',
  };
}

export function makeTableConfig(
  overrides: Partial<{
    gameType: string;
    smallBlind: number;
    bigBlind: number;
    ante: number;
    maxPlayers: number;
    minBuyIn: number;
    maxBuyIn: number;
  }> = {}
) {
  return {
    gameType: overrides.gameType ?? 'NLH',
    smallBlind: overrides.smallBlind ?? 5,
    bigBlind: overrides.bigBlind ?? 10,
    ante: overrides.ante ?? 0,
    maxPlayers: overrides.maxPlayers ?? 9,
    minBuyIn: overrides.minBuyIn ?? 500,
    maxBuyIn: overrides.maxBuyIn ?? 2000,
  };
}

export function makeTournamentConfig(
  overrides: Partial<{
    name: string;
    buyIn: number;
    startingStack: number;
    maxPlayers: number;
    blindLevels: Array<{
      smallBlind: number;
      bigBlind: number;
      ante: number;
      durationMinutes: number;
    }>;
  }> = {}
) {
  return {
    name: overrides.name ?? 'Test Tournament',
    buyIn: overrides.buyIn ?? 100,
    startingStack: overrides.startingStack ?? 10000,
    maxPlayers: overrides.maxPlayers ?? 50,
    blindLevels: overrides.blindLevels ?? [
      { smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 15 },
      { smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 15 },
      { smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 12 },
    ],
  };
}
