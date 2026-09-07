import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), removeChannel: vi.fn(), channel: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: mocks.getSession },
    channel: mocks.channel,
    removeChannel: mocks.removeChannel,
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/GameServerAPI', () => ({ default: {} }));
vi.mock('../../src/services/RoomService', () => ({ roomService: { registerChannel: vi.fn() } }));
import { TableWebSocket } from '../../src/services/TableWebSocket';
function makeChannel() {
  let status: (s: string) => Promise<void>;
  const channel = {
    on: vi.fn().mockReturnThis(),
    track: vi.fn().mockResolvedValue('ok'),
    subscribe: vi.fn((cb) => {
      status = cb;
      return channel;
    }),
    emit: (s: string) => status(s),
    presenceState: () => ({}),
  };
  return channel;
}
let client: TableWebSocket;
let channels: ReturnType<typeof makeChannel>[];
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.clearAllMocks();
  channels = [];
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'test-only' } } });
  mocks.removeChannel.mockResolvedValue(undefined);
  mocks.channel.mockImplementation(() => {
    const c = makeChannel();
    channels.push(c);
    return c;
  });
  client = new TableWebSocket('table-1', 'user-1', 'test');
});
afterEach(async () => {
  await client.disconnect();
  vi.useRealTimers();
});
it('shares overlapping connect attempts and keeps an already connected channel', async () => {
  const first = client.connect(),
    second = client.connect();
  await flush();
  expect(channels).toHaveLength(1);
  await channels[0].emit('SUBSCRIBED');
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(true);
  await expect(client.connect()).resolves.toBe(true);
  expect(channels).toHaveLength(1);
  expect(mocks.getSession).toHaveBeenCalledTimes(1);
});
it('ignores a late subscribed callback while channel removal is pending', async () => {
  void client.connect();
  await flush();
  let finish!: () => void;
  mocks.removeChannel.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );
  const closing = client.disconnect();
  await channels[0].emit('SUBSCRIBED');
  expect(channels[0].track).not.toHaveBeenCalled();
  expect(client.connected).toBe(false);
  finish();
  await closing;
});
it('a rejected presence track does not strand the connect promise', async () => {
  const connected = client.connect();
  await flush();
  channels[0].track.mockRejectedValueOnce(new Error('presence unavailable'));
  await expect(channels[0].emit('SUBSCRIBED')).resolves.toBeUndefined();
  await expect(connected).resolves.toBe(true);
});

it('settles a pending connection immediately when disconnected', async () => {
  const connected = client.connect();
  await flush();
  await client.disconnect();
  await expect(connected).resolves.toBe(false);
  await expect(client.connect()).resolves.toBe(false);
});
it('retries once after a connected channel fails and ignores its stale status', async () => {
  vi.useFakeTimers();
  const connected = client.connect();
  await flush();
  await channels[0].emit('SUBSCRIBED');
  await connected;
  await channels[0].emit('CHANNEL_ERROR');
  await channels[0].emit('TIMED_OUT');
  expect(client.connected).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(channels).toHaveLength(2);
  await channels[0].emit('SUBSCRIBED');
  expect(client.connected).toBe(false);
  await channels[1].emit('SUBSCRIBED');
  expect(client.connected).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
