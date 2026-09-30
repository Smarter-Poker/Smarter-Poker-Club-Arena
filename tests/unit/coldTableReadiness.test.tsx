import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { WebSocket as NativeWebSocket, WebSocketServer } from 'ws';
import type { Page } from '@playwright/test';
import TableConnectionBanner, { GRACE_MS } from '../../src/components/table/TableConnectionBanner';
import {
  whileConnectionBannerStaysHidden,
  whileInitialTableConnects,
} from '../e2e/support/liveTableRealtime';
import { remainingInitialTableReadinessMs } from '../e2e/support/initialTableReadiness';

// Only credentials are a local fixture. Hook, client, mux, native WebSocket,
// React banner and the exact production observer all execute unchanged.
vi.mock('../../src/lib/authToken', () => ({ getFreshAccessToken: async () => 'local-fixture' }));
const TABLE = 'aaaaaaaa-1111-4111-8111-111111111111';
let server: WebSocketServer;
let peer: NativeWebSocket | undefined;
let subscriptions: unknown[] = [];
let useEngineTableState: typeof import('../../src/hooks/useEngineTableState').useEngineTableState;
let mux: typeof import('../../src/services/EngineSocketMux').engineSocketMux;

const page = {
  getByTestId(id: string) {
    return {
      isVisible: async () => screen.queryByTestId(id) !== null,
      textContent: async () => screen.queryByTestId(id)?.textContent ?? null,
      getAttribute: async (name: string) => screen.queryByTestId(id)?.getAttribute(name) ?? null,
    };
  },
  waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
} as unknown as Page;

function TableEntry() {
  const { snapshot, status } = useEngineTableState(TABLE);
  return (
    <>
      <output data-testid="wire-status">{status}</output>
      <output data-testid="wire-state">{snapshot?.handNumber ?? 'no-state'}</output>
      <TableConnectionBanner status={status} hasLiveState={(snapshot?.handNumber ?? 0) > 0} />
    </>
  );
}

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native socket has no address');
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'SUBSCRIBE') subscriptions.push(frame);
    });
  });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  // The hook's maintained development URL is compiled by Vite. Redirect only
  // that exact local endpoint to this fixture's ephemeral native listener.
  class LocalFixtureWebSocket extends NativeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      const target = new URL(url);
      if (target.origin !== 'ws://localhost:8080') throw new Error('Unexpected fixture endpoint');
      target.hostname = '127.0.0.1';
      target.port = String(address.port);
      super(target, protocols);
    }
  }
  vi.stubGlobal('WebSocket', LocalFixtureWebSocket);
  ({ useEngineTableState } = await import('../../src/hooks/useEngineTableState'));
  ({ engineSocketMux: mux } = await import('../../src/services/EngineSocketMux'));
});

afterEach(async () => {
  cleanup();
  mux.closeOfflineTransport();
  for (const client of server.clients) client.terminate();
  peer = undefined;
  subscriptions = [];
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function enter() {
  render(<TableEntry />);
  await waitFor(() =>
    expect(
      subscriptions,
      screen.getByTestId('wire-status').textContent || 'unknown'
    ).toContainEqual({ type: 'SUBSCRIBE', tableId: TABLE })
  );
  expect(screen.getByTestId('wire-state')).toHaveTextContent('no-state');
}
async function passGrace() {
  await act(() => new Promise((resolve) => setTimeout(resolve, GRACE_MS + 70)));
}
async function deliver(type: string, extra = {}) {
  if (!peer) throw new Error('No native peer');
  await act(async () => {
    peer!.send(JSON.stringify({ type, tableId: TABLE, ...extra }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('cold navigation readiness is distinct from established table continuity', () => {
  it('keeps the required initial Connecting message while real wire admission and state finish', async () => {
    await enter();
    const ready = deferred();
    const oldResult = whileConnectionBannerStaysHidden(page, ready.promise, 'old cold entry').then(
      () => 'passed',
      (error: Error) => error.message
    );
    const result = whileInitialTableConnects(page, ready.promise, 'cold entry');
    // Actual source requires this message. The former cold-route observer
    // rejects the same healthy, still bounded lifecycle before admission.
    await passGrace();
    expect(screen.getByTestId('table-connection-banner')).toHaveTextContent('Connecting');
    expect(await oldResult).toContain('became visible after its grace period');
    await deliver('SUBSCRIBED');
    expect(screen.getByTestId('wire-state')).toHaveTextContent('no-state');
    await deliver('SNAPSHOT', { seq: 1, state: { handNumber: 77 } });
    await waitFor(() => expect(screen.getByTestId('wire-state')).toHaveTextContent('77'));
    expect(screen.queryByTestId('table-connection-banner')).toBeNull();
    ready.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it('still rejects a real access refusal before the first state', async () => {
    await enter();
    const result = whileInitialTableConnects(page, new Promise<void>(() => {}), 'cold entry').then(
      () => 'passed',
      (error: Error) => error.message
    );
    await deliver('ERROR', { code: 'CLUB_MEMBERSHIP_REQUIRED', message: 'Join this club' });
    await passGrace();
    expect(await result).toContain('became visible after its grace period');
    expect(screen.getByTestId('wire-state')).toHaveTextContent('no-state');
    expect(screen.getByTestId('table-connection-banner').className).toContain('access_refused');
  });

  it('still rejects a real connection loss before the first snapshot', async () => {
    await enter();
    const result = whileInitialTableConnects(page, new Promise<void>(() => {}), 'cold entry').then(
      () => 'passed',
      (error: Error) => error.message
    );
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await passGrace();
    expect(await result).toContain('became visible after its grace period');
    expect(screen.getByTestId('wire-state')).toHaveTextContent('no-state');
    expect(screen.getByTestId('table-connection-banner')).toHaveTextContent('Reconnecting');
  });

  it('does not treat a lost established connection as initial readiness', async () => {
    await enter();
    await deliver('SUBSCRIBED');
    await deliver('SNAPSHOT', { seq: 1, state: { handNumber: 78 } });
    const result = whileConnectionBannerStaysHidden(
      page,
      new Promise<void>(() => {}),
      'live play'
    ).then(
      () => 'passed',
      (error: Error) => error.message
    );
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await passGrace();
    expect(await result).toContain('became visible after its grace period');
    expect(screen.getByTestId('wire-state')).toHaveTextContent('78');
    expect(screen.getByTestId('table-connection-banner')).toHaveTextContent('Reconnecting');
  });

  it('never grants rendering or an absent snapshot a fresh navigation budget', () => {
    expect(remainingInitialTableReadinessMs(1_000, 12_000, 2_300)).toBe(10_700);
    expect(remainingInitialTableReadinessMs(1_000, 12_000, 12_999)).toBe(1);
    for (const now of [13_000, 13_001, Infinity, NaN, 999]) {
      expect(() => remainingInitialTableReadinessMs(1_000, 12_000, now)).toThrow(
        'navigation deadline'
      );
    }
    for (const budget of [0, -1, Infinity, NaN]) {
      expect(() => remainingInitialTableReadinessMs(1_000, budget, 1_000)).toThrow(
        'navigation deadline'
      );
    }
  });
});
