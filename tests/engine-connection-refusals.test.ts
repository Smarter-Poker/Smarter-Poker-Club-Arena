import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  reload: vi.fn(async () => {}),
  session: vi.fn(async () => 'unknown' as const),
}));
vi.mock('../src/utils/lazyWithRetry', () => ({ hardReload: mocks.reload }));
vi.mock('../src/lib/sessionRevoked', () => ({ handleEngineAuthRejection: mocks.session }));
vi.mock('../src/services/clientConnectionBeacon', () => ({ reportConnectionEvent: vi.fn() }));
class Socket {
  static instances: Socket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(..._args: unknown[]) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  localStorage.setItem('ca_ws_mux', '0');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Socket.instances = [];
});
afterEach(() => {
  localStorage.removeItem('ca_ws_mux');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function make(kind: 'table' | 'channel', getToken = async () => 'token') {
  const { EngineStateClient, EngineChannelClient } =
    await import('../src/services/EngineStateClient');
  const options = { baseUrl: 'https://engine.example', getToken };
  return kind === 'table'
    ? new EngineStateClient({ ...options, tableId: 'table-a', onSnapshot: () => {} })
    : new EngineChannelClient(options);
}
describe.each(['table', 'channel'] as const)('%s refusal recovery', (kind) => {
  it('retires an incompatible connection and requests one fresh bundle', async () => {
    const c = await make(kind);
    try {
      await c.connect();
      Socket.instances[0].close(4426, 'upgrade_required:0<1');
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.reload).toHaveBeenCalledOnce();
      for (const event of ['online', 'pageshow', 'visibilitychange']) {
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
      }
      await c.connect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(Socket.instances).toHaveLength(1);
      expect(mocks.session).not.toHaveBeenCalled();
      expect(mocks.reload).toHaveBeenCalledOnce();
    } finally {
      c.disconnect();
    }
  });
  it('backs off a capacity refusal without misclassifying it as an auth failure', async () => {
    const c = await make(kind);
    try {
      await c.connect();
      for (let attempt = 0; attempt < 4; attempt++) {
        const count = Socket.instances.length;
        Socket.instances[count - 1].close(4429, 'too_many_sockets:10');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(Socket.instances).toHaveLength(count);
        await vi.advanceTimersByTimeAsync(attempt === 0 ? 6_000 : 25_000);
        expect(Socket.instances).toHaveLength(count + 1);
      }
      expect(mocks.session).not.toHaveBeenCalled();
      expect(mocks.reload).not.toHaveBeenCalled();
    } finally {
      c.disconnect();
    }
  });
});
it('a protocol refusal cancels a peer connection still waiting for its token', async () => {
  let token!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    token = resolve;
  });
  const table = await make('table');
  const channel = await make('channel', () => pending);
  try {
    await table.connect();
    const connecting = channel.connect();
    Socket.instances[0].close(4426, 'upgrade_required');
    token('token');
    await connecting;
    await vi.advanceTimersByTimeAsync(1);
    expect(Socket.instances).toHaveLength(1);
    expect(mocks.reload).toHaveBeenCalledOnce();
  } finally {
    table.disconnect();
    channel.disconnect();
  }
});

describe.each(['table', 'channel'] as const)('%s auth refusals still recover', (kind) => {
  it.each([4401, 1006])(
    'checks the session for %s and retries an unknown verdict',
    async (code) => {
      const c = await make(kind);
      try {
        await c.connect();
        const attempts = code === 4401 ? 1 : 3;
        for (let attempt = 0; attempt < attempts; attempt++) {
          Socket.instances[Socket.instances.length - 1].close(code, 'server');
          await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(mocks.session).toHaveBeenCalledOnce();
        expect(Socket.instances).toHaveLength(attempts + 1);
        expect(mocks.reload).not.toHaveBeenCalled();
      } finally {
        c.disconnect();
      }
    }
  );
});
