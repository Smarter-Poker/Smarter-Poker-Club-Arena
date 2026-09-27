import React from 'react';
import { createServer } from 'node:http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { WebSocket, WebSocketServer } from 'ws';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  client: null as SupabaseClient | null,
  user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  toast: { success: vi.fn() },
}));
vi.mock('../../src/lib/supabase', () => ({
  get supabase() {
    return state.client;
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: state.user.id }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
// Unused application-store initialization is outside this transport/consumer fixture.
vi.mock('../../src/stores/useArenaStore', () => ({ useArenaStore: {} }));
vi.mock('../../src/stores/useClubStore', () => ({ useClubStore: {} }));
vi.mock('../../src/stores/useTableStore', () => ({ useTableStore: {} }));
vi.mock('../../src/stores/useUnionStore', () => ({ useUnionStore: {} }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: {} }));
vi.mock('../../src/stores/useSettingsStore', () => ({ useSettingsStore: {} }));
vi.mock('../../src/stores/useUserStore', () => ({ useUserStore: {} }));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.unmock('../../src/core/MasterBus');
import { masterBus } from '../../src/core/MasterBus';
import GlobalWaitlistListener from '../../src/components/common/GlobalWaitlistListener';
import WaitlistBanner from '../../src/components/common/WaitlistBanner';

type Row = Record<string, string | null>;
type Binding = { id: number; event: string; schema: string; table: string; filter: string };
const tableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const watchTopic = 'realtime:global-waitlist-auto-seat-watch';

/** A local PostgREST/Phoenix peer, not a production DB or an RLS simulator. */
async function localQueue() {
  let row: Row = {
    id: rowId,
    table_id: tableId,
    user_id: state.user.id,
    status: 'waiting',
    created_at: '2026-09-01T00:00:00Z',
    notified_at: null,
    hold_expires_at: null,
  };
  let ahead = 2;
  const reads: Array<{ method: string; path: string; select: string | null }> = [];
  const writes: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    response.setHeader('access-control-expose-headers', 'content-range');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url!, 'http://local');
    if (!['GET', 'HEAD'].includes(request.method!)) writes.push(request.method!);
    reads.push({
      method: request.method!,
      path: url.pathname,
      select: url.searchParams.get('select'),
    });
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/rest/v1/table_waitlist') {
      if (request.method === 'HEAD') {
        response.setHeader('content-range', `0-${Math.max(0, ahead - 1)}/${ahead}`);
        response.end();
      } else
        response.end(
          JSON.stringify(['waiting', 'notified'].includes(String(row.status)) ? [row] : [])
        );
    } else if (url.pathname === '/rest/v1/tables')
      response.end(JSON.stringify([{ name: 'Local Queue Table' }]));
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const sockets = new WebSocketServer({ server });
  const channels = new Map<string, { socket: WebSocket; bindings: Binding[] }>();
  const sent: unknown[] = [];
  let nextId = 0;
  const send = (
    socket: WebSocket,
    topic: string,
    event: string,
    payload: unknown,
    ref?: string
  ) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ topic, event, payload, ref }));
  };
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      let response = {};
      if (frame.event === 'phx_join') {
        const bindings = frame.payload.config.postgres_changes.map(
          (filter: Omit<Binding, 'id'>) => ({ ...filter, id: ++nextId })
        );
        channels.set(frame.topic, { socket, bindings });
        response = { postgres_changes: bindings };
      } else if (frame.event === 'phx_leave') channels.delete(frame.topic);
      send(socket, frame.topic, 'phx_reply', { status: 'ok', response }, frame.ref);
    });
    socket.on('close', () => {
      for (const [topic, channel] of channels)
        if (channel.socket === socket) channels.delete(topic);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local queue did not bind');
  const createLocalClient = () =>
    createClient(`http://127.0.0.1:${address.port}`, 'local-fixture-only', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { transport: WebSocket },
    });
  state.client = createLocalClient();
  return {
    reads,
    writes,
    sent,
    channels,
    patch(next: Partial<Row>) {
      row = { ...row, ...next };
    },
    setAhead(count: number) {
      ahead = count;
    },
    update(own: boolean) {
      const topic = own ? watchTopic : 'realtime:global-waitlist-auto-seat';
      const channel = channels.get(topic);
      if (!channel) throw new Error(`No subscribed local channel ${topic}`);
      const binding = channel.bindings.find(
        (entry) => entry.table === 'table_waitlist' && entry.event === (own ? '*' : 'UPDATE')
      );
      if (!binding) throw new Error('SDK did not register expected Postgres Changes binding');
      const payload = {
        ids: [binding.id],
        data: {
          schema: 'public',
          table: 'table_waitlist',
          type: 'UPDATE',
          commit_timestamp: new Date().toISOString(),
          errors: null,
          columns: Object.keys(row).map((name) => ({ name, type: 'text' })),
          record: own
            ? row
            : {
                ...row,
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                user_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              },
          // The original defect: RLS/replica identity may expose ONLY the old PK.
          old_record: { id: own ? rowId : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        },
      };
      sent.push(payload);
      send(channel.socket, topic, 'postgres_changes', payload);
    },
    async reloadClient() {
      // A page reload constructs a new SDK client, after retiring the old one.
      await state.client!.removeAllChannels();
      state.client!.realtime.disconnect();
      state.client = createLocalClient();
    },
    async close() {
      await state.client!.removeAllChannels();
      state.client!.realtime.disconnect();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      state.client = null;
    },
  };
}

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function MountedQueue() {
  return (
    <MemoryRouter initialEntries={['/lobby']}>
      <WaitlistBanner />
      <GlobalWaitlistListener />
      <Location />
    </MemoryRouter>
  );
}

it('delivers real SDK row updates through the mounted listener, bus, service and banner without old.status', async () => {
  const queue = await localQueue();
  masterBus.reset();
  state.toast.success.mockClear();
  const offers: unknown[] = [];
  const unlisten = masterBus.subscribe('WAITLIST_SEAT_OFFERED', (event) =>
    offers.push(event.payload)
  );
  let mounted = render(<MountedQueue />);
  try {
    await expect.poll(() => queue.channels.size).toBe(2);
    expect(
      queue.channels
        .get(watchTopic)!
        .bindings.map(({ event, table, filter }) => ({ event, table, filter }))
    ).toEqual([{ event: '*', table: 'table_waitlist', filter: `user_id=eq.${state.user.id}` }]);
    expect(
      queue.channels
        .get('realtime:global-waitlist-auto-seat')!
        .bindings.filter((entry) => entry.table === 'table_waitlist')
        .map(({ event, filter }) => ({ event, filter }))
    ).toEqual([
      { event: 'INSERT', filter: `table_id=in.(${tableId})` },
      { event: 'UPDATE', filter: `table_id=in.(${tableId})` },
    ]);
    // Another player's real wire update triggers the actual FIFO service GET+HEAD.
    await act(async () => {
      queue.update(false);
    });
    await screen.findByText('#3');
    expect(queue.reads.some((read) => read.method === 'HEAD')).toBe(true);
    queue.setAhead(0);
    await act(async () => {
      queue.update(false);
    });
    await screen.findByText('#1');

    const firstDeadline = new Date(Date.now() + 60_000).toISOString();
    queue.patch({
      status: 'notified',
      notified_at: new Date().toISOString(),
      hold_expires_at: firstDeadline,
    });
    await act(async () => {
      queue.update(true);
    });
    await screen.findByText('Seat Held');
    await screen.findByText('Local Queue Table');
    await expect.poll(() => state.toast.success.mock.calls.length).toBe(1);
    expect(screen.getByTestId('location').textContent).toBe('/lobby');
    expect(offers).toContainEqual({ tableId, tableName: '', holdExpiresAt: firstDeadline });
    const offerCount = offers.length;
    const readCount = queue.reads.length;
    await act(async () => {
      queue.update(true);
    });
    await expect.poll(() => queue.reads.length).toBeGreaterThan(readCount);
    expect(offers).toHaveLength(offerCount);
    expect(state.toast.success).toHaveBeenCalledTimes(1);

    const movedDeadline = new Date(Date.now() + 360_000).toISOString();
    queue.patch({ hold_expires_at: movedDeadline });
    await act(async () => {
      queue.update(true);
    });
    await expect
      .poll(() => offers.at(-1))
      .toEqual({ tableId, tableName: '', holdExpiresAt: movedDeadline });
    expect(state.toast.success).toHaveBeenCalledTimes(1);
    // Deterministic local clock only: after the old deadline, the actual banner
    // still displays the reseeded hold. No production clock or offer is changed.
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(firstDeadline) + 1_000);
    try {
      mounted.rerender(<MountedQueue />);
      expect(screen.getByText('Seat Held')).toBeTruthy();
    } finally {
      dateNow.mockRestore();
    }

    mounted.unmount();
    await expect.poll(() => queue.channels.size).toBe(0);
    masterBus.reset();
    await queue.reloadClient();
    mounted = render(<MountedQueue />);
    await screen.findByText('Seat Held');
    await expect.poll(() => queue.channels.size).toBe(2);
    expect(state.toast.success).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location').textContent).toBe('/lobby');
    expect(queue.writes).toEqual([]);
    expect(queue.sent.length).toBe(5);
    expect(
      queue.sent.every((payload: any) => Object.keys(payload.data.old_record).join() === 'id')
    ).toBe(true);
  } finally {
    mounted.unmount();
    cleanup();
    unlisten();
    masterBus.reset();
    await queue.close();
  }
}, 15_000);
