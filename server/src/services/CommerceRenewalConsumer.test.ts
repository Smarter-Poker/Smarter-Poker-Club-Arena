import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn(), frozen: vi.fn(() => false) }));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: mocked.rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError: mocked.report }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: mocked.frozen }));

type Consumer = typeof import('./CommerceRenewalConsumer.js');
let consumer: Consumer;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mocked.rpc.mockReset();
  mocked.report.mockReset();
  mocked.frozen.mockReset();
  mocked.frozen.mockReturnValue(false);
  consumer = await import('./CommerceRenewalConsumer.js');
});
afterEach(async () => {
  await consumer.stopCommerceRenewalConsumer();
  vi.useRealTimers();
});

const mandate = (id: string) => ({
  id,
  scope_kind: 'club',
  scope_id: 'club-1',
  sku: 'capacity_100',
  due_at: '2026-10-22T00:00:00Z',
});

function fakeDoors(
  overrides: Partial<import('./CommerceRenewalConsumer.js').CommerceConsumerDoors> = {}
) {
  const calls: Array<[string, unknown[]]> = [];
  const doors = {
    claim: vi.fn(async (token: string, limit: number) => {
      calls.push(['claim', [token, limit]]);
      return [mandate('m1'), mandate('m2')];
    }),
    execute: vi.fn(async (id: string, token: string) => {
      calls.push(['execute', [id, token]]);
      return id === 'm1'
        ? { success: true, outcome: 'renewed' as const }
        : {
            success: true,
            outcome: 'needs_attention' as const,
            reason: 'price_above_accepted_ceiling',
          };
    }),
    deliverNotices: vi.fn(async (limit: number) => {
      calls.push(['deliver', [limit]]);
      return 3;
    }),
    frozen: () => false,
    ...overrides,
  };
  return { doors, calls };
}

describe('the durable renewal consumer', () => {
  it('claims due mandates under one lease, executes each once with that lease, then delivers due notices', async () => {
    const { doors, calls } = fakeDoors();
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const token = (calls[0][1] as unknown[])[0];
    expect(calls.map((c) => c[0])).toEqual(['claim', 'execute', 'execute', 'deliver']);
    expect((calls[1][1] as unknown[])[1]).toBe(token);
    expect((calls[2][1] as unknown[])[1]).toBe(token);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(status.lastRenewals).toEqual({ claimed: 2, renewed: 1, attention: 1, leaseLost: 0 });
    expect(status.lastNoticesDelivered).toBe(3);
    expect(status.lastError).toBeNull();
    expect(mocked.report).not.toHaveBeenCalled();
  });

  it('never claims during the maintenance freeze: the platform is frozen and a renewal is a money movement', async () => {
    const { doors } = fakeDoors({ frozen: () => true });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(doors.claim).not.toHaveBeenCalled();
    expect(doors.deliverNotices).not.toHaveBeenCalled();
  });

  it('a stale lease is counted, not retried, and a stop fences the rest of the batch', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    const { doors } = fakeDoors({
      execute: vi.fn(async (id: string) => {
        if (id === 'm1') {
          await first;
          return { success: false, error: 'lease_lost' };
        }
        return { success: true, outcome: 'renewed' as const };
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = consumer.stopCommerceRenewalConsumer();
    resolveFirst();
    await stopping;
    expect(doors.execute).toHaveBeenCalledTimes(1);
    expect(doors.deliverNotices).not.toHaveBeenCalled();
    expect(consumer.commerceRenewalConsumerStatus().active).toBe(false);
  });

  it('a database failure is reported and the next wake still runs', async () => {
    let n = 0;
    const { doors } = fakeDoors({
      claim: vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return [];
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.commerceRenewalConsumerStatus().lastError).toBe('boom');
    expect(mocked.report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(consumer.COMMERCE_RENEWAL_POLL_MS + 1);
    expect(doors.claim).toHaveBeenCalledTimes(2);
    expect(consumer.commerceRenewalConsumerStatus().lastError).toBeNull();
  });

  it('the production doors call the three named database functions with the lease', async () => {
    mocked.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_commerce_claim_due_renewals')
        return { data: [mandate('m1')], error: null };
      if (name === 'fn_ca_commerce_execute_renewal')
        return { data: { success: true, outcome: 'renewed' }, error: null };
      if (name === 'fn_ca_commerce_deliver_due_notices') return { data: 2, error: null };
      return { data: null, error: { message: `unexpected ${name}` } };
    });
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const names = mocked.rpc.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'fn_ca_commerce_claim_due_renewals',
      'fn_ca_commerce_execute_renewal',
      'fn_ca_commerce_deliver_due_notices',
    ]);
    const claimArgs = mocked.rpc.mock.calls[0][1] as { p_lease_token: string; p_limit: number };
    const execArgs = mocked.rpc.mock.calls[1][1] as { p_mandate_id: string; p_lease_token: string };
    expect(execArgs.p_lease_token).toBe(claimArgs.p_lease_token);
    expect(execArgs.p_mandate_id).toBe('m1');
    expect(consumer.commerceRenewalConsumerStatus().lastNoticesDelivered).toBe(2);
  });
});
