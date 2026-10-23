/**
 * AN EXACT AMOUNT PRINTS WHOLE, OR TO TWO PLACES (launch audit R-10, round 2,
 * 2026-10-09). The cashout sheet prints the amount about to move and the
 * balance it is measured against exactly, never abbreviated - and
 * `toLocaleString()` alone printed a pending 18,400.50 as "18,400.5 Chips",
 * which is neither a whole chip count nor cents. A whole amount stays whole.
 * Harness: the mounted-form setup of tests/unit/CashoutRequestModal.test.tsx.
 */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import {
  CASHOUT_IDS as ID,
  cashoutV2Receipt,
  cashoutLookupEnvelope,
} from '../helpers/cashoutV2Receipt';
const identity = vi.hoisted(() => ({
  userId: '',
  auth: new Set<(event: { payload: { userId: string; isAuthenticated: boolean } }) => void>(),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !!identity.userId,
    authenticated: !!identity.userId,
    userId: identity.userId,
  }),
}));
// Exercises the mounted form, real prepared wrapper and strict receipt service.
// The lock shim remains a unit boundary; native browser storage is separate.
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((name, handler) => {
      if (name === 'AUTH_STATE_CHANGED') identity.auth.add(handler);
      return () => {
        identity.auth.delete(handler);
      };
    }),
    getOrCreateChannel: () => ({
      on() {
        return this;
      },
      subscribe: vi.fn(),
    }),
    subscribeDebounced: () => () => {},
    removeRegisteredChannel: vi.fn(),
    registerChannelFactory: vi.fn(),
    removeChannelFactory: vi.fn(),
  },
}));
vi.mock('../../src/lib/subscribeRealtime', () => ({ subscribeRealtime: vi.fn(async () => {}) }));
vi.mock('../../src/utils/retryAsync', () => ({ retryAsync: (fn: any) => fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: vi.fn(async (id: string) => id),
}));
vi.mock('../../src/services/PushNotificationService', () => ({
  pushNotificationService: { sendToUser: vi.fn() },
}));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: vi.fn(async () => ({ locked: false })),
}));
vi.mock('../../src/lib/date', () => ({ formatRelativeShort: () => '' }));
// Only the buzz is stubbed; the rest of the gate (TapHaptic asks it whether
// this is an iPhone browser) stays real.
vi.mock('../../src/utils/vibrationGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/vibrationGate')>()),
  fireVibration: vi.fn(),
}));
vi.mock('../../src/utils/safeErrorMessage', () => ({
  safeErrorMessage: (error: Error) => error.message,
}));
import CashoutRequestModal from '../../src/components/wallet/CashoutRequestModal';
import { cashoutService } from '../../src/services/CashoutService';
import { supabase } from '../../src/lib/supabase';
import { checkSettlementLock } from '../../src/utils/settlementLock';
import { resolveClubUUIDStrict } from '../../src/utils/strictClubIdResolver';
const rpc = vi.fn(); // Financial transition transport only; lookup is separately asserted.
const lookup = vi.fn();
const transport = vi.mocked(supabase.rpc);
const complete = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  identity.userId = '';
  for (const handler of identity.auth) handler({ payload: { userId: '', isAuthenticated: false } });
  identity.userId = ID.player;
  for (const handler of identity.auth)
    handler({ payload: { userId: ID.player, isAuthenticated: true } });
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(resolveClubUUIDStrict)
    .mockReset()
    .mockImplementation(async (id) => id);
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, _options: unknown, callback: () => unknown) => {
        const pending = (locks.get(key) ?? Promise.resolve()).then(callback);
        locks.set(
          key,
          pending.catch(() => undefined)
        );
        return pending;
      },
    },
  });
  lookup.mockReset().mockImplementation(async (_name, args) => ({
    data: cashoutLookupEnvelope(args),
    error: null,
  }));
  transport
    .mockReset()
    .mockImplementation(
      (name, args) =>
        (name === 'fn_cashout_operation_receipt_v2' ? lookup(name, args) : rpc(name, args)) as never
    );
  rpc.mockReset().mockImplementation(
    async (name, args) =>
      ({
        data: {
          ...cashoutV2Receipt(name === 'fn_cashout_release_v2' ? 'cancellation' : 'hold', {
            amount: Number(args?.p_amount),
            note: args?.p_note as string | undefined,
          }),
          op_id: args?.p_op_id,
        },
        error: null,
      }) as never
  );
  vi.spyOn(cashoutService, 'getPlayerCashouts').mockResolvedValue([]);
  vi.spyOn(cashoutService, 'getCashout').mockResolvedValue(null);
  vi.mocked(checkSettlementLock).mockResolvedValue({ locked: false } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(balance: number | null = 1e9) {
  render(
    <CashoutRequestModal
      isOpen
      onClose={() => {}}
      playerId={ID.player}
      clubId={ID.club}
      currentBalance={balance}
      onComplete={complete}
    />
  );
  return await screen.findByLabelText('Amount');
}

const pending = (id: string, amount: number) => ({
  id,
  clubId: ID.club,
  playerId: ID.player,
  agentId: ID.agent,
  amount,
  status: 'pending' as const,
  createdAt: '2026-09-15T09:00:00+00:00',
  updatedAt: '2026-09-15T09:00:00+00:00',
});
const cents = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

it('prints a fractional pending amount to two places and a whole one whole', async () => {
  vi.mocked(cashoutService.getPlayerCashouts).mockResolvedValue([
    pending(ID.cashout, 18400.5),
    pending(ID.other, 18400),
  ]);
  await mount();
  expect(await screen.findByText(`${cents(18400.5)} Chips`)).toBeTruthy();
  expect(screen.getByText(`${(18400).toLocaleString()} Chips`)).toBeTruthy();
  expect(screen.queryByText(`${(18400.5).toLocaleString()} Chips`)).toBeNull();
});

it('prints the available balance the same way', async () => {
  await mount(1000.5);
  expect(screen.getByText(`${cents(1000.5)} Chips`)).toBeTruthy();
  expect(screen.queryByText(`${(1000.5).toLocaleString()} Chips`)).toBeNull();
  cleanup();
  await mount(25000);
  expect(screen.getByText('25,000.00 Chips')).toBeTruthy();
});
