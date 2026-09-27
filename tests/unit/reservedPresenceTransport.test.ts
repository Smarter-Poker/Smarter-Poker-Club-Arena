import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { createReservedPresenceTransport } from '../e2e/support/reservedPresenceTransport';
import type { TemporaryCustomizationAccount } from '../e2e/support/temporaryCustomizationAccount';

// Exercise the real installed SDK and real local sockets. No production
// credentials, application data or synthetic app bus events are involved.
it('uses actual SDK join/leave/reconnect and closes only its reserved sessions', async () => {
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const accounts = ids.map(
    (id, index) =>
      ({
        id,
        email: `ca-customization-cert-presence-${index}@example.invalid`,
        password: 'local-fixture-only',
      }) as TemporaryCustomizationAccount
  );
  const logoutScopes: string[] = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    requests.push(request.url || '');
    let body = '';
    for await (const part of request) body += String(part);
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/auth/v1/token')) {
      const account = accounts.find((entry) => entry.email === JSON.parse(body).email)!;
      const token =
        [
          { alg: 'HS256', typ: 'JWT' },
          { sub: account.id, exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated' },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
          .join('.') + '.fixture';
      response.end(
        JSON.stringify({
          access_token: token,
          refresh_token: 'local-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          user: { id: account.id, email: account.email },
        })
      );
    } else if (request.url?.startsWith('/auth/v1/logout')) {
      logoutScopes.push(new URL(request.url, 'http://local').searchParams.get('scope') || '');
      response.end('{}');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const sockets = new WebSocketServer({ server });
  const members = new Map<WebSocket, { key: string; ref: string; topic: string }>();
  let nextRef = 0;
  const send = (
    socket: WebSocket,
    topic: string,
    event: string,
    payload: unknown,
    ref?: string
  ) => {
    if (socket.readyState === socket.OPEN)
      socket.send(JSON.stringify({ topic, event, payload, ref }));
  };
  const remove = (socket: WebSocket) => {
    const old = members.get(socket);
    members.delete(socket);
    if (old)
      for (const peer of members.keys())
        send(peer, old.topic, 'presence_diff', {
          joins: {},
          leaves: { [old.key]: { metas: [{ phx_ref: old.ref }] } },
        });
  };
  sockets.on('connection', (socket) => {
    let key = '';
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      const reply = () =>
        send(
          socket,
          frame.topic,
          'phx_reply',
          { status: 'ok', response: { postgres_changes: [] } },
          frame.ref
        );
      if (frame.event === 'phx_join') {
        key = frame.payload.config.presence.key;
        reply();
        send(
          socket,
          frame.topic,
          'presence_state',
          Object.fromEntries(
            [...members.values()].map((member) => [
              member.key,
              { metas: [{ phx_ref: member.ref }] },
            ])
          )
        );
      } else if (frame.event === 'presence' && frame.payload.event === 'track') {
        const member = { key, ref: String(++nextRef), topic: frame.topic };
        members.set(socket, member);
        reply();
        for (const peer of members.keys())
          send(peer, frame.topic, 'presence_diff', {
            joins: { [key]: { metas: [{ phx_ref: member.ref }] } },
            leaves: {},
          });
      } else if (frame.event === 'phx_leave') {
        remove(socket);
        reply();
      } else if (frame.event === 'heartbeat') reply();
    });
    socket.on('close', () => remove(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture did not bind.');
  const environment = {
    supabaseUrl: `http://127.0.0.1:${address.port}`,
    publishableKey: 'local-fixture-only',
    serviceRoleKey: 'unused',
  };
  const topic = `cert-presence:${ids[0]}`;
  const peers: Array<Awaited<ReturnType<typeof createReservedPresenceTransport>>> = [];
  try {
    await expect(
      createReservedPresenceTransport(
        environment,
        { ...accounts[0], email: 'real@example.com' },
        topic
      )
    ).rejects.toThrow('reserved identity');
    await expect(
      createReservedPresenceTransport(environment, accounts[0], 'union:live')
    ).rejects.toThrow('reserved topic');
    expect(requests).toEqual([]);
    for (const account of accounts)
      peers.push(await createReservedPresenceTransport(environment, account, topic));
    await expect.poll(() => peers[0].state.peers, { timeout: 3000 }).toEqual(ids);
    await expect.poll(() => peers[1].state.peers, { timeout: 3000 }).toEqual(ids);
    expect(peers.map((peer) => peer.state.tracks)).toEqual([1, 1]);
    await peers[1].leave();
    await expect.poll(() => peers[0].state.peers, { timeout: 3000 }).toEqual([ids[0]]);
    await peers[1].reconnect();
    await expect.poll(() => peers[0].state.peers, { timeout: 3000 }).toEqual(ids);
    expect(peers[1].state.tracks).toBe(2);
    expect(peers.flatMap((peer) => peer.state.errors)).toEqual([]);
  } finally {
    const closed = await Promise.allSettled(peers.map((peer) => peer.close()));
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  }
  expect(logoutScopes).toEqual(['local', 'local']);
  expect(requests.every((url) => url.startsWith('/auth/v1/'))).toBe(true);
}, 15_000);
