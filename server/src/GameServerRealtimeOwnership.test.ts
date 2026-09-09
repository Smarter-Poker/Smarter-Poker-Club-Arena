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
});

afterEach(() => vi.restoreAllMocks());

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
    expect(serviceCalls.length).toBeGreaterThanOrEqual(5);
    expect(serviceCalls.every((authority) => authority === null)).toBe(true);
    expect(supabase.removeChannel).toHaveBeenCalledOnce();
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
