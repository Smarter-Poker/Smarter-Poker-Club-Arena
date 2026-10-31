import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/utils/requestDeadline';

const { rpc, emit, signals } = vi.hoisted(() => ({
  rpc: vi.fn(),
  emit: vi.fn(),
  signals: [] as AbortSignal[],
}));
vi.mock('../../src/lib/supabase', () => ({
  getAuthUser: async () => ({ data: { user: { id: 'player' } }, error: null }),
  supabase: {
    rpc: (...args: unknown[]) => {
      const result = Promise.resolve(rpc(...args));
      return Object.assign(result, {
        abortSignal: (signal: AbortSignal) => {
          signals.push(signal);
          return result;
        },
      });
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit, subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { tournamentService } from '../../src/services/TournamentService';

beforeEach(() => {
  vi.useFakeTimers();
  rpc.mockReset();
  emit.mockClear();
  signals.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('navigator', { locks: { request: (_key: string, fn: () => unknown) => fn() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function receipt(kind: string, request?: Record<string, unknown>) {
  return {
    data:
      kind === 'unregister' || kind === 'seat'
        ? {
            ok: true,
            request_id: request?.p_request_id,
            registration_id: 'registration',
            refunded_chips: 10,
            returned_ticket_value: 0,
            wallet_chips_from_satellite_entitlements: 0,
          }
        : {
            success: true,
            new_stack: 1000,
            rebuy_type: kind,
            atomic_tournament_chip_purchase: 'v1',
            seated: true,
            table_id: 'table',
            seat_number: 1,
          },
    error: null,
  };
}
function call(kind: string, id: string) {
  if (kind === 'unregister') return tournamentService.unregisterPlayer(id, 'player');
  if (kind === 'seat') return tournamentService.leaveTournamentSeatAndRefund(id, 'player');
  return kind === 'addon'
    ? tournamentService.processAddOn(id, 'player')
    : tournamentService.processRebuy(id, 'player', 'original-prompt');
}
function tournament(kind: string, id: string) {
  return {
    id,
    starting_chips: 1000,
    rebuy_chips: 1000,
    addon_chips: 1000,
    buy_in_amount: 10,
    rebuy_cost: 10,
    addon_cost: 10,
    is_reentry: kind === 'reentry',
    is_rebuy: kind !== 'reentry',
  } as never;
}

describe('tournament financial requests preserve their identity after a hung response', () => {
  it.each(['rebuy', 'reentry', 'addon', 'unregister', 'seat'])(
    '%s releases the control, retains uncertainty, and ignores its late reply',
    async (kind) => {
      const id = 'hung-' + kind;
      vi.spyOn(tournamentService, 'getTournament').mockResolvedValue(tournament(kind, id));
      vi.spyOn(tournamentService, 'getCurrentLevelState').mockReturnValue({
        levelIndex: 3,
      } as never);
      const late: Array<() => void> = [];
      rpc.mockImplementation(
        (_name, request) =>
          new Promise((resolve) => {
            late.push(() => resolve(receipt(kind, request)));
          })
      );
      let outcome: unknown = 'pending';
      const first = call(kind, id).then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        }
      );
      try {
        await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DEADLINE_MS * 2 + 1);
        expect(outcome).toBeInstanceOf(Error);
        expect(emit).not.toHaveBeenCalled();
        const original = rpc.mock.calls[0][1];
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        vi.mocked(tournamentService.getTournament).mockRejectedValue(
          new Error('Read Must Not Repeat')
        );
        rpc.mockImplementationOnce((_name, request) => receipt(kind, request));
        await call(kind, id);
        expect(
          rpc.mock.calls.every((args) => JSON.stringify(args[1]) === JSON.stringify(original))
        ).toBe(true);
        expect(emit).toHaveBeenCalledTimes(1);
        late.forEach((resolve) => resolve());
        await vi.advanceTimersByTimeAsync(0);
        expect(emit).toHaveBeenCalledTimes(1);
      } finally {
        late.forEach((resolve) => resolve());
        await vi.advanceTimersByTimeAsync(0);
        await first;
      }
    }
  );
});

describe('purchase payload preparation has a bounded read', () => {
  it.each(['rebuy', 'reentry', 'addon'])(
    '%s never submits after a late preparation read',
    async (kind) => {
      const id = 'read-' + kind;
      let finishRead!: (value: never) => void;
      const read = vi.spyOn(tournamentService, 'getTournament').mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          })
      );
      vi.spyOn(tournamentService, 'getCurrentLevelState').mockReturnValue({
        levelIndex: 3,
      } as never);
      let outcome: unknown = 'pending';
      const first = call(kind, id).then(
        (value) => {
          outcome = value;
        },
        (error) => {
          outcome = error;
        }
      );
      try {
        await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DEADLINE_MS + 1);
        expect(outcome).toMatchObject({ name: 'TournamentPurchaseNotSubmittedError' });
        expect(rpc).not.toHaveBeenCalled();
        expect(localStorage.length).toBe(0);
        expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
        finishRead(tournament(kind, id));
        await first;
        await vi.advanceTimersByTimeAsync(0);
        expect(rpc).not.toHaveBeenCalled();
        read.mockResolvedValue(tournament(kind, id));
        rpc.mockResolvedValue(receipt(kind));
        await call(kind, id);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledTimes(1);
      } finally {
        finishRead(tournament(kind, id));
        await vi.advanceTimersByTimeAsync(0);
        await first;
      }
    }
  );
});
