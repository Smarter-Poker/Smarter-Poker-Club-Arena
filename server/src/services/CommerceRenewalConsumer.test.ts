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
    executeRefunds: vi.fn(async (token: string, limit: number) => {
      calls.push(['refunds', [token, limit]]);
      return { success: true, claimed: 2, refunded: 1, owed: 1, failed: 0 };
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
  it('claims due mandates under one lease (the heartbeat), executes each once, then approved refunds, then delivers due notices', async () => {
    const { doors, calls } = fakeDoors();
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const token = (calls[0][1] as unknown[])[0];
    expect(calls.map((c) => c[0])).toEqual(['claim', 'execute', 'execute', 'refunds', 'deliver']);
    expect((calls[1][1] as unknown[])[1]).toBe(token);
    expect((calls[2][1] as unknown[])[1]).toBe(token);
    expect((calls[3][1] as unknown[])[0]).toBe(token);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(status.lastRenewals).toEqual({ claimed: 2, renewed: 1, attention: 1, leaseLost: 0 });
    expect(status.lastRefunds).toEqual({ claimed: 2, refunded: 1, owed: 1, failed: 0 });
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
    expect(doors.executeRefunds).not.toHaveBeenCalled();
    expect(doors.deliverNotices).not.toHaveBeenCalled();
  });

  it('a freeze that begins mid-wake stops the refunds (money) but not the notices', async () => {
    let frozen = false;
    const { doors } = fakeDoors({
      frozen: () => frozen,
      execute: vi.fn(async () => {
        frozen = true;
        return { success: true, outcome: 'renewed' as const };
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(doors.execute).toHaveBeenCalledTimes(1);
    expect(doors.executeRefunds).not.toHaveBeenCalled();
    expect(doors.deliverNotices).toHaveBeenCalledTimes(1);
  });

  it('refunds run on every wake even when no renewal is due: an owed refund is retried by its owner on the next wake', async () => {
    const { doors } = fakeDoors({ claim: vi.fn(async () => []) });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(consumer.COMMERCE_RENEWAL_POLL_MS + 1);
    expect(doors.claim).toHaveBeenCalledTimes(2);
    expect(doors.executeRefunds).toHaveBeenCalledTimes(2);
    expect(doors.deliverNotices).toHaveBeenCalledTimes(2);
  });

  it('a refused refund run is reported, not swallowed, and notices are still delivered in the same wake', async () => {
    const { doors } = fakeDoors({
      executeRefunds: vi.fn(async () => ({ success: false, error: 'lease_token_required' })),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(status.lastError).toContain('lease_token_required');
    expect(status.stepErrors.refunds).toContain('lease_token_required');
    expect(status.stepErrors.renewals).toBeNull();
    expect(status.stepErrors.notices).toBeNull();
    expect(mocked.report).toHaveBeenCalledTimes(1);
    expect(mocked.report.mock.calls[0][1]).toBe('CommerceRenewalConsumer.refunds');
    expect(doors.deliverNotices).toHaveBeenCalledTimes(1);
    expect(status.lastNoticesDelivered).toBe(3);
  });

  it('a thrown refund step (for example the door not installed yet) does not stop the notices', async () => {
    const { doors } = fakeDoors({
      executeRefunds: vi.fn(async () => {
        throw new Error('fn_ca_commerce_execute_approved_refunds: function does not exist');
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(doors.execute).toHaveBeenCalledTimes(2);
    expect(doors.deliverNotices).toHaveBeenCalledTimes(1);
    expect(status.lastRenewals).toEqual({ claimed: 2, renewed: 1, attention: 1, leaseLost: 0 });
    expect(status.stepErrors).toEqual({
      renewals: null,
      refunds: 'fn_ca_commerce_execute_approved_refunds: function does not exist',
      notices: null,
    });
    expect(mocked.report).toHaveBeenCalledTimes(1);
  });

  it('a failed claim does not stop the refunds or the notices in the same wake', async () => {
    const { doors } = fakeDoors({
      claim: vi.fn(async () => {
        throw new Error('claim down');
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(doors.execute).not.toHaveBeenCalled();
    expect(doors.executeRefunds).toHaveBeenCalledTimes(1);
    expect(doors.deliverNotices).toHaveBeenCalledTimes(1);
    expect(status.lastRefunds).toEqual({ claimed: 2, refunded: 1, owed: 1, failed: 0 });
    expect(status.lastNoticesDelivered).toBe(3);
    expect(status.stepErrors).toEqual({ renewals: 'claim down', refunds: null, notices: null });
    expect(mocked.report).toHaveBeenCalledTimes(1);
    expect(mocked.report.mock.calls[0][1]).toBe('CommerceRenewalConsumer.renewals');
  });

  it('a renewal execution that throws mid-batch does not stop the refunds or the notices', async () => {
    const { doors } = fakeDoors({
      execute: vi.fn(async () => {
        throw new Error('execute down');
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(doors.execute).toHaveBeenCalledTimes(1);
    expect(doors.executeRefunds).toHaveBeenCalledTimes(1);
    expect(doors.deliverNotices).toHaveBeenCalledTimes(1);
    expect(consumer.commerceRenewalConsumerStatus().stepErrors.renewals).toBe('execute down');
  });

  it('a failed notice delivery is reported on its own and leaves the money steps reported clean', async () => {
    const { doors } = fakeDoors({
      deliverNotices: vi.fn(async () => {
        throw new Error('notices down');
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const status = consumer.commerceRenewalConsumerStatus();
    expect(status.lastRenewals?.renewed).toBe(1);
    expect(status.lastRefunds?.refunded).toBe(1);
    expect(status.stepErrors).toEqual({ renewals: null, refunds: null, notices: 'notices down' });
    expect(status.lastError).toBe('notices down');
    expect(mocked.report.mock.calls.map((c) => c[1])).toEqual(['CommerceRenewalConsumer.notices']);
  });

  it('every failing step reports separately, and each clears on its own next success', async () => {
    let wake = 0;
    const { doors } = fakeDoors({
      claim: vi.fn(async () => {
        wake += 1;
        if (wake === 1) throw new Error('claim down');
        return [];
      }),
      executeRefunds: vi.fn(async () => {
        if (wake === 1) throw new Error('refunds down');
        return { success: true, claimed: 0, refunded: 0, owed: 0, failed: 0 };
      }),
      deliverNotices: vi.fn(async () => {
        if (wake <= 2) throw new Error('notices down');
        return 0;
      }),
    });
    consumer.__setCommerceConsumerDoors(doors);
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.commerceRenewalConsumerStatus().lastError).toBe(
      'claim down; refunds down; notices down'
    );
    expect(mocked.report).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(consumer.COMMERCE_RENEWAL_POLL_MS + 1);
    expect(consumer.commerceRenewalConsumerStatus().stepErrors).toEqual({
      renewals: null,
      refunds: null,
      notices: 'notices down',
    });
    await vi.advanceTimersByTimeAsync(consumer.COMMERCE_RENEWAL_POLL_MS + 1);
    expect(consumer.commerceRenewalConsumerStatus().lastError).toBeNull();
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
    expect(doors.executeRefunds).not.toHaveBeenCalled();
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

  it('the production doors call the four named database functions with the lease', async () => {
    mocked.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_commerce_claim_due_renewals')
        return { data: [mandate('m1')], error: null };
      if (name === 'fn_ca_commerce_execute_renewal')
        return { data: { success: true, outcome: 'renewed' }, error: null };
      if (name === 'fn_ca_commerce_execute_approved_refunds')
        return {
          data: { success: true, claimed: 1, refunded: 0, owed: 1, failed: 0 },
          error: null,
        };
      if (name === 'fn_ca_commerce_deliver_due_notices') return { data: 2, error: null };
      return { data: null, error: { message: `unexpected ${name}` } };
    });
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    const names = mocked.rpc.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'fn_ca_commerce_claim_due_renewals',
      'fn_ca_commerce_execute_renewal',
      'fn_ca_commerce_execute_approved_refunds',
      'fn_ca_commerce_deliver_due_notices',
    ]);
    const claimArgs = mocked.rpc.mock.calls[0][1] as { p_lease_token: string; p_limit: number };
    const execArgs = mocked.rpc.mock.calls[1][1] as { p_mandate_id: string; p_lease_token: string };
    const refundArgs = mocked.rpc.mock.calls[2][1] as { p_lease_token: string; p_limit: number };
    expect(execArgs.p_lease_token).toBe(claimArgs.p_lease_token);
    expect(execArgs.p_mandate_id).toBe('m1');
    expect(refundArgs.p_lease_token).toBe(claimArgs.p_lease_token);
    expect(refundArgs.p_limit).toBeGreaterThan(0);
    expect(consumer.commerceRenewalConsumerStatus().lastRefunds).toEqual({
      claimed: 1,
      refunded: 0,
      owed: 1,
      failed: 0,
    });
    expect(consumer.commerceRenewalConsumerStatus().lastNoticesDelivered).toBe(2);
  });

  it('a database error from the refund door is reported with the function name', async () => {
    mocked.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_commerce_claim_due_renewals') return { data: [], error: null };
      if (name === 'fn_ca_commerce_execute_approved_refunds')
        return { data: null, error: { message: 'permission denied' } };
      return { data: 0, error: null };
    });
    consumer.startCommerceRenewalConsumer();
    await vi.advanceTimersByTimeAsync(0);
    expect(consumer.commerceRenewalConsumerStatus().lastError).toBe(
      'fn_ca_commerce_execute_approved_refunds: permission denied'
    );
    expect(mocked.report).toHaveBeenCalledTimes(1);
  });
});
