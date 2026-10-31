import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTournamentDataAuthority,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from './services/supabase/dataActorContext.js';

vi.mock('./services/errorReporter.js', () => ({ reportError: vi.fn() }));

const sourceOwner = {
  tournamentId: 'aaaaaaaa-0000-4000-8000-000000000001',
  leaseGeneration: 'bbbbbbbb-0000-4000-8000-000000000001',
};
const targetOwner = {
  tournamentId: 'aaaaaaaa-0000-4000-8000-000000000002',
  leaseGeneration: 'bbbbbbbb-0000-4000-8000-000000000002',
};
type Callback = (payload: any) => void;
type Channel = {
  callbacks: Map<string, Callback>;
  status?: (status: string) => void;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

let GameServer: typeof import('./GameServer.js').GameServer;
let supabase: typeof import('./services/supabase/client.js').supabase;
let channels: Channel[];
let server: any;
let requestSweep: ReturnType<typeof vi.fn>;
let serviceCalls: Array<ReturnType<typeof currentTournamentDataAuthority>>;

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ GameServer } = await import('./GameServer.js'));
  ({ supabase } = await import('./services/supabase/client.js'));
}, 60_000);

beforeEach(() => {
  channels = [];
  serviceCalls = [];
  requestSweep = vi.fn(() => {
    expect(currentTournamentDataAuthority()).toEqual(targetOwner);
  });
  const manager = {
    requestEliminationSweep: bindTournamentDataAuthority(targetOwner, requestSweep),
  };
  const serviceWork = () => {
    serviceCalls.push(currentTournamentDataAuthority());
    return Promise.resolve();
  };
  vi.spyOn(supabase, 'channel').mockImplementation(() => {
    const channel: Channel = {
      callbacks: new Map(),
      on: vi.fn(),
      subscribe: vi.fn(),
    };
    channel.on.mockImplementation((_kind, filter, callback) => {
      channel.callbacks.set(filter.table + ':' + filter.event, callback);
      return channel;
    });
    channel.subscribe.mockImplementation((callback) => {
      channel.status = callback;
      return channel;
    });
    channels.push(channel);
    return channel as any;
  });
  vi.spyOn(supabase, 'removeChannel').mockResolvedValue('ok');
  server = Object.assign(Object.create(GameServer.prototype), {
    running: true,
    tournamentEngines: new Map([[targetOwner.tournamentId, manager]]),
    tournamentBountyObligationChannel: null,
    tournamentManagerWakeChannel: null,
    requestPendingTournamentBountyRecovery: vi.fn(serviceWork),
    drainTournamentManagerWakes: vi.fn(serviceWork),
    scheduleTournamentBountySubscriptionReconnect: vi.fn(serviceWork),
    scheduleTournamentManagerWakeSubscriptionReconnect: vi.fn(serviceWork),
    launchServerLifecycleJob: vi.fn((job: Promise<unknown>) => {
      void job.catch(() => {});
    }),
    admitTournamentManagerWake: vi.fn(() => {
      serviceCalls.push(currentTournamentDataAuthority());
      manager.requestEliminationSweep('wake');
      return Promise.resolve(true);
    }),
  });
}, 60_000); // importing GameServer alone can pass 10s on a loaded CI runner

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function deliverFromOtherManager(work: () => void): Promise<void> {
  await runWithTournamentDataAuthority(sourceOwner, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    work();
    // Restoring a receiver must not exchange the sender's own authority.
    expect(currentTournamentDataAuthority()).toEqual(sourceOwner);
  });
  expect(currentTournamentDataAuthority()).toBeNull();
}

describe('GameServer shared Realtime callback ownership', () => {
  it('delivers settled bounty notifications to the actual manager without crashing the process', async () => {
    server.startTournamentBountyObligationSubscription();
    await deliverFromOtherManager(() => {
      channels[0].callbacks.get('tournament_bounty_obligations:UPDATE')!({
        new: { state: 'settled', tournament_id: targetOwner.tournamentId },
      });
    });
    expect(requestSweep).toHaveBeenCalledOnce();
    expect(requestSweep).toHaveBeenCalledWith('bounty_settled');
  });

  it('keeps pending bounty recovery in its process owner context', async () => {
    server.startTournamentBountyObligationSubscription();
    serviceCalls.length = 0;
    await deliverFromOtherManager(() => {
      channels[0].callbacks.get('tournament_bounty_obligations:INSERT')!({
        new: { state: 'pending', tournament_id: targetOwner.tournamentId },
      });
    });
    expect(serviceCalls).toEqual([null]);
  });

  it('admits durable manager wakes under the receiver context and preserves acknowledgement filtering', async () => {
    server.startTournamentManagerWakeSubscription();
    serviceCalls.length = 0;
    const receive = channels[0].callbacks.get('tournament_manager_wakes:INSERT')!;
    await deliverFromOtherManager(() => {
      receive({ new: { id: 1, tournament_id: targetOwner.tournamentId, consumed_at: null } });
      receive({
        new: { id: 1, tournament_id: targetOwner.tournamentId, consumed_at: '2026-09-09' },
      });
    });
    expect(requestSweep).toHaveBeenCalledOnce();
    expect(requestSweep).toHaveBeenCalledWith('wake');
    expect(serviceCalls).toEqual([null]);
  });

  it('delivers compatibility vote notifications under the target manager and rejects old channel callbacks', async () => {
    server.startTournamentManagerWakeSubscription();
    const receive = channels[0].callbacks.get('tournament_deal_votes:INSERT')!;
    await deliverFromOtherManager(() =>
      receive({ new: { tournament_id: targetOwner.tournamentId } })
    );
    expect(requestSweep).toHaveBeenCalledOnce();
    expect(requestSweep).toHaveBeenCalledWith('deal_vote');
    server.tournamentManagerWakeChannel = null;
    await deliverFromOtherManager(() =>
      receive({ new: { tournament_id: targetOwner.tournamentId } })
    );
    expect(requestSweep).toHaveBeenCalledTimes(1);
  });

  it.each([
    'startTournamentBountyObligationSubscription',
    'startTournamentManagerWakeSubscription',
  ])('%s keeps status recovery and recreation outside a foreign manager context', async (start) => {
    server[start]();
    serviceCalls.length = 0;
    await deliverFromOtherManager(() => {
      for (const status of ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
        channels[0].status!(status);
      }
    });
    // SUBSCRIBED drains; CHANNEL_ERROR drains, retires the channel and
    // schedules its recreation, after which the retired channel's later
    // TIMED_OUT and CLOSED belong to nobody (2026-10-15).
    expect(serviceCalls.length).toBeGreaterThanOrEqual(3);
    expect(serviceCalls.every((authority) => authority === null)).toBe(true);
    expect(supabase.removeChannel).toHaveBeenCalledOnce();
  });

  /**
   * A CHANNEL THAT ERRORS OR TIMES OUT IS RECREATED BY THIS PROCESS
   * (2026-10-15). Both process channels were disconnected for 27 hours after a
   * Realtime restart on 2026-10-13, with no join refused server-side, until an
   * engine release restarted the process: the error branches trusted
   * realtime-js to rejoin, and realtime-js never reopens a socket and never
   * recovers a channel its topic-keyed registry has dropped. Each such status
   * now retires the channel and schedules its recreation on a new topic.
   */
  it.each([
    [
      'startTournamentBountyObligationSubscription',
      'tournamentBountyObligationChannel',
      'scheduleTournamentBountySubscriptionReconnect',
      'CHANNEL_ERROR',
    ],
    [
      'startTournamentBountyObligationSubscription',
      'tournamentBountyObligationChannel',
      'scheduleTournamentBountySubscriptionReconnect',
      'TIMED_OUT',
    ],
    [
      'startTournamentManagerWakeSubscription',
      'tournamentManagerWakeChannel',
      'scheduleTournamentManagerWakeSubscriptionReconnect',
      'CHANNEL_ERROR',
    ],
    [
      'startTournamentManagerWakeSubscription',
      'tournamentManagerWakeChannel',
      'scheduleTournamentManagerWakeSubscriptionReconnect',
      'TIMED_OUT',
    ],
  ])('%s retires and recreates its channel on %s', (start, field, reconnect, status) => {
    server[start]();
    channels[0].status!('SUBSCRIBED');
    expect(server[reconnect]).not.toHaveBeenCalled();
    channels[0].status!(status);
    expect(server[field]).toBeNull();
    expect(supabase.removeChannel).toHaveBeenCalledOnce();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(server[reconnect]).toHaveBeenCalledOnce();
    // The retired channel's later statuses are not this process's any more.
    channels[0].status!('CLOSED');
    expect(supabase.removeChannel).toHaveBeenCalledOnce();
    expect(server[reconnect]).toHaveBeenCalledOnce();
  });

  it.each([
    ['startTournamentBountyObligationSubscription', 'tournamentBountyObligationChannel'],
    ['startTournamentManagerWakeSubscription', 'tournamentManagerWakeChannel'],
  ])('%s gives every recreated channel its own topic', (start, field) => {
    server.tournamentRealtimeChannelGeneration = 0;
    server[start]();
    server[field] = null;
    server[start]();
    const topics = vi.mocked(supabase.channel).mock.calls.map((call) => String(call[0]));
    expect(topics).toHaveLength(2);
    expect(new Set(topics).size).toBe(2);
    for (const topic of topics) expect(topic).toMatch(/:\d+:\d+$/);
  });

  it.each([
    'startTournamentBountyObligationSubscription',
    'startTournamentManagerWakeSubscription',
  ])('%s refuses to establish process authority from manager work', (start) => {
    expect(() => runWithTournamentDataAuthority(sourceOwner, () => server[start]())).toThrow(
      /must start outside tournament authority/
    );
    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('still refuses direct authority exchange between managers', () => {
    const target = bindTournamentDataAuthority(targetOwner, requestSweep);
    expect(() => runWithTournamentDataAuthority(sourceOwner, () => target())).toThrow(
      /cannot be rebound/
    );
    expect(requestSweep).not.toHaveBeenCalled();
  });
});

describe('durable wake page read ownership', () => {
  function page(data: unknown, afterRead?: () => void) {
    const query: any = {};
    for (const key of ['select', 'is', 'gt', 'order', 'limit', 'eq']) {
      query[key] = vi.fn(() => query);
    }
    query.then = (resolve: (value: unknown) => unknown) => {
      afterRead?.();
      return Promise.resolve({
        data: typeof data === 'function' ? data() : data,
        error: null,
      }).then(resolve);
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query);
  }

  it('does not certify an unreadable inbox as drained', async () => {
    page(null);
    expect(await server.drainTournamentManagerWakePages()).toBe(false);
    expect(server.admitTournamentManagerWake).not.toHaveBeenCalled();
  });

  it('does not admit a page returned to a retired server generation', async () => {
    server.lifecycleGeneration = 1;
    page([{ id: 1, tournament_id: targetOwner.tournamentId, generation: 1 }], () => {
      server.lifecycleGeneration = 2;
    });
    await server.drainTournamentManagerWakePages();
    expect(server.admitTournamentManagerWake).not.toHaveBeenCalled();
  });

  it('admits a readable current page without acknowledging unfinished work', async () => {
    const row = { id: 1, tournament_id: targetOwner.tournamentId, generation: 1 };
    page([row]);
    expect(await server.drainTournamentManagerWakePages()).toBe(true);
    expect(server.admitTournamentManagerWake).toHaveBeenCalledWith(row);
  });

  it('does not start a read after shutdown', async () => {
    page([]);
    server.running = false;
    await server.drainTournamentManagerWakePages();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('accepts a proved empty page', async () => {
    page([]);
    expect(await server.drainTournamentManagerWakePages()).toBe(true);
  });

  it('keeps a rejected admission pending without starving the rest of its readable page', async () => {
    const first = { id: 1, tournament_id: targetOwner.tournamentId, generation: 1 };
    const later = { id: 2, tournament_id: sourceOwner.tournamentId, generation: 1 };
    page([first, later]);
    server.admitTournamentManagerWake.mockRejectedValueOnce(
      new Error('capacity admission unknown')
    );

    await expect(server.drainTournamentManagerWakePages()).resolves.toBe(false);
    expect(server.admitTournamentManagerWake.mock.calls).toEqual([[first], [later]]);
    expect(supabase.from).toHaveBeenCalledWith('tournament_manager_wakes');
  });

  function ownDrain() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    delete server.drainTournamentManagerWakes;
    Object.assign(server, {
      lifecycleGeneration: 1,
      tournamentManagerWakeDrainRequested: false,
      tournamentManagerWakeDrainInFlight: false,
      tournamentManagerWakeDrainRetryTimer: null,
      tournamentManagerWakeDrainRetryGeneration: 0,
      tournamentManagerWakeDrainRetryBackoffMs: 250,
    });
  }

  it('does not forget an earlier admission failure when the drain advances to its next page', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1,
      tournament_id: targetOwner.tournamentId,
      generation: 1,
    }));
    const pages = [rows.slice(0, 200), rows.slice(200)];
    page(() => pages.shift());
    server.admitTournamentManagerWake.mockRejectedValueOnce(new Error('first admission unknown'));

    await expect(server.drainTournamentManagerWakePages()).resolves.toBe(false);
    expect(server.admitTournamentManagerWake).toHaveBeenCalledTimes(201);
    expect(server.admitTournamentManagerWake).toHaveBeenLastCalledWith(rows[200]);
    expect(pages).toEqual([]);
  });

  it('hands a rejected live notification to the same durable drain without a reconnect', async () => {
    server.startTournamentManagerWakeSubscription();
    ownDrain();
    const row = {
      id: 3,
      tournament_id: targetOwner.tournamentId,
      generation: 8,
      consumed_at: null,
    };
    page([row]);
    server.admitTournamentManagerWake.mockRejectedValueOnce(new Error('live admission unknown'));
    await deliverFromOtherManager(() =>
      channels[0].callbacks.get('tournament_manager_wakes:INSERT')!({ new: row })
    );

    expect(server.admitTournamentManagerWake.mock.calls).toEqual([[row]]);
    expect(server.tournamentManagerWakeDrainRequested).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(server.admitTournamentManagerWake.mock.calls).toEqual([[row], [row]]);
    expect(server.tournamentManagerWakeDrainRequested).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['shutdown', 'lifecycle', 'channel'])(
    'does not pass a late live-admission rejection to a retired %s owner',
    async (retirement) => {
      server.startTournamentManagerWakeSubscription();
      ownDrain();
      let rejectAdmission!: (error: Error) => void;
      server.admitTournamentManagerWake.mockImplementationOnce(
        () => new Promise((_resolve, reject) => (rejectAdmission = reject))
      );
      const row = { id: 3, tournament_id: targetOwner.tournamentId, generation: 8 };
      await deliverFromOtherManager(() =>
        channels[0].callbacks.get('tournament_manager_wakes:INSERT')!({ new: row })
      );
      if (retirement === 'shutdown') server.running = false;
      else if (retirement === 'lifecycle') server.lifecycleGeneration++;
      else server.tournamentManagerWakeChannel = null;
      rejectAdmission(new Error('retired live admission'));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(server.admitTournamentManagerWake).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(server.tournamentManagerWakeDrainRequested).toBe(false);
    }
  );

  it.each([undefined, targetOwner.tournamentId])(
    'retries the same durable requests through the existing backoff after a %s drain admission rejects',
    async (scope) => {
      ownDrain();
      const first = {
        id: 1,
        tournament_id: targetOwner.tournamentId,
        generation: 7,
        consumed_at: null,
      };
      const later = { ...first, id: 2, generation: 4 };
      page([first, later]);
      const rpc = vi.spyOn(supabase, 'rpc');
      server.admitTournamentManagerWake.mockRejectedValueOnce(new Error('recovery not confirmed'));

      await server.drainTournamentManagerWakes(scope);
      expect(server.admitTournamentManagerWake.mock.calls).toEqual([[first], [later]]);
      expect(server.tournamentManagerWakeDrainRequested).toBe(true);
      expect(server.tournamentManagerWakeDrainInFlight).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(server.admitTournamentManagerWake).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(server.admitTournamentManagerWake.mock.calls).toEqual([
        [first],
        [later],
        [first],
        [later],
      ]);
      expect(server.tournamentManagerWakeDrainRequested).toBe(false);
      expect(server.tournamentManagerWakeDrainRetryTimer).toBeNull();
      expect(server.tournamentManagerWakeDrainRetryBackoffMs).toBe(250);
      expect(vi.getTimerCount()).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
      expect([first.consumed_at, later.consumed_at]).toEqual([null, null]);
    }
  );

  it('does not retain or retry an admission rejection from a retired lifecycle', async () => {
    ownDrain();
    const first = { id: 1, tournament_id: targetOwner.tournamentId, generation: 1 };
    const later = { ...first, id: 2 };
    page([first, later]);
    server.admitTournamentManagerWake.mockImplementationOnce(async () => {
      server.lifecycleGeneration++;
      throw new Error('retired recovery');
    });

    await server.drainTournamentManagerWakes();
    expect(server.admitTournamentManagerWake.mock.calls).toEqual([[first]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not re-admit after shutdown while its causal retry is pending', async () => {
    ownDrain();
    const row = { id: 1, tournament_id: targetOwner.tournamentId, generation: 1 };
    page([row]);
    server.admitTournamentManagerWake.mockRejectedValueOnce(new Error('admission unknown'));
    await server.drainTournamentManagerWakes();
    expect(vi.getTimerCount()).toBe(1);
    server.running = false;
    await vi.advanceTimersByTimeAsync(250);

    expect(server.admitTournamentManagerWake).toHaveBeenCalledOnce();
    expect(server.tournamentManagerWakeDrainRetryTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
