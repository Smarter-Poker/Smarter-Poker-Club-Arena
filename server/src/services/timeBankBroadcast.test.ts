import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
const state = vi.hoisted(() => ({ client: undefined as any }));
vi.mock('./supabase.js', () => ({
  get supabase() {
    return state.client;
  },
}));
// The real engine also imports database submodules directly. Keep that path
// on the same closed test transport, independent of ambient service credentials.
vi.mock('./supabase/client.js', () => ({
  get supabase() {
    return state.client;
  },
  get maintenanceSupabase() {
    return state.client;
  },
  get seedingSupabase() {
    return state.client;
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
import { broadcastTimeBankActivation } from './timeBankBroadcast.js';
import { reportError } from './errorReporter.js';
afterEach(async () => {
  await state.client?.removeAllChannels();
  vi.restoreAllMocks();
});
function client(fetcher: typeof fetch) {
  state.client = createClient('https://example.test', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetcher },
    realtime: { fetch: fetcher },
  });
  return state.client;
}
const payload = {
  player_id: 'player-1',
  table_id: 'table-1',
  additional_seconds: 20,
  uses_remaining: 2,
  unlimited_activations: false,
  auto_activated: true,
};
describe('time-bank announcements own their temporary channel', () => {
  it('preserves every message and releases repeated real SDK sends without joining', async () => {
    const calls: any[] = [];
    const c = client(async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)));
      return new Response(null, { status: 202 });
    });
    const connect = vi.spyOn(c.realtime, 'connect');
    for (let n = 0; n < 40; n++) await broadcastTimeBankActivation('table-1', payload);
    expect(calls).toHaveLength(40);
    for (const call of calls)
      expect(call.messages).toEqual([
        { topic: 'table:table-1', event: 'time_bank_activated', payload, private: false },
      ]);
    expect(c.getChannels()).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
  for (const failure of ['http', 'network'])
    it(
      'releases and reports ' + failure + ' failure without retrying or failing the turn',
      async () => {
        const fetcher = vi.fn(async () => {
          if (failure === 'network') throw Error('transport unavailable');
          return new Response(JSON.stringify({ message: 'refused' }), { status: 503 });
        });
        const c = client(fetcher);
        await expect(broadcastTimeBankActivation('table-1', payload)).resolves.toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(c.getChannels()).toHaveLength(0);
        expect(reportError).toHaveBeenCalled();
      }
    );
  it('removes only its captured channel when sends overlap', async () => {
    const finish: Array<() => void> = [];
    const c = client(
      () =>
        new Promise<Response>((resolve) => {
          finish.push(() => resolve(new Response(null, { status: 202 })));
        })
    );
    const first = broadcastTimeBankActivation('table-1', payload);
    const second = broadcastTimeBankActivation('table-2', { ...payload, table_id: 'table-2' });
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    expect(c.getChannels()).toHaveLength(2);
    finish[1]();
    await second;
    expect(c.getChannels().map((x: any) => x.topic)).toEqual(['realtime:table:table-1']);
    finish[0]();
    await first;
    expect(c.getChannels()).toHaveLength(0);
  });
});

// Exercise the real engine caller, not only the transport helper.
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
for (const auto of [false, true])
  it(
    (auto ? 'automatic' : 'manual') +
      ' activation updates the real clock and sends the unchanged opponent payload',
    async () => {
      const requests: any[] = [];
      const c = client(async (_url, options) => {
        requests.push(JSON.parse(String(options?.body)));
        return new Response(null, { status: 202 });
      });
      const engine = new ServerTableEngine('table-1') as any;
      try {
        engine.running = true;
        engine.isCurrentEngine = () => true;
        engine.tableInfo = {};
        engine.handController = {
          getState: () => ({
            currentPlayerSeat: 3,
            currentBet: 0,
            players: [{ user_id: 'player-1', seat: 3, bet: 0 }],
          }),
        };
        engine.timeBankEngine.configure('table-1', { secondsPerUse: 20 });
        engine.timeBankEngine.initializePlayer('table-1', 'player-1', {
          remainingSeconds: 60,
          usesRemaining: 3,
        });
        engine.playerTurnDuration = 15;
        engine.playerTurnStartTime = Date.now() - 15000;
        if (auto) {
          const timer = vi.spyOn(engine.preciseTimer, 'startTimer');
          engine.startTurnTimer('player-1', 3, 15);
          const primary = timer.mock.calls.find((call) => call[1] === 'player-1');
          expect(primary).toBeDefined();
          (primary![3] as () => void)();
        } else {
          expect(await engine.activateTimeBank('player-1')).toMatchObject({ success: true });
        }
        await vi.waitFor(() => expect(c.getChannels()).toHaveLength(0));
        expect(requests).toHaveLength(1);
        expect(requests[0].messages[0]).toMatchObject({
          topic: 'table:table-1',
          event: 'time_bank_activated',
          payload: { ...payload, auto_activated: auto, ...(auto ? {} : { total_remaining: 60 }) },
        });
        expect(engine.timeBankEngine.getUsesRemaining('table-1', 'player-1')).toBe(2);
        expect(engine.preciseTimer.getRemainingMs('table-1', 'timebank:player-1')).toBeGreaterThan(
          19000
        );
      } finally {
        engine.preciseTimer.dispose();
      }
    }
  );
