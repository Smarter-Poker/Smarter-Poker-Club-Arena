import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { openChannelWithUnavailableRetry } from '../e2e/support/channelHandshake';

it.each([{ sequence: [503, 101] }, { sequence: [401] }, { sequence: [503, 503, 503] }])(
  'handles only explicit pre-upgrade 503: $sequence',
  async ({ sequence }) => {
    let calls = 0;
    const diagnostics: object[] = [];
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const status = sequence[Math.min(calls++, sequence.length - 1)];
      if (status === 101) wss.handleUpgrade(request, socket, head, (ws) => ws.close());
      else
        socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = openChannelWithUnavailableRetry(
        () =>
          new Promise((resolve) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`, ['bearer', 'SECRET_SENTINEL']);
            let status: number | null = null;
            socket.on('open', () => {
              socket.close();
              resolve({ opened: true, index: 7, status: 101, closeCode: null });
            });
            socket.on('unexpected-response', (_request, response) => {
              status = response.statusCode ?? null;
              response.resume();
              socket.terminate();
            });
            socket.on('error', () => {});
            socket.on('close', (code) =>
              resolve({ opened: false, index: -1, status, closeCode: code })
            );
          }),
        (value) => diagnostics.push(value),
        async () => {}
      );
      if (sequence.includes(101)) expect(await result).toBe(7);
      else await expect(result).rejects.toThrow('Channel handshake refused');
      expect(calls).toBe(sequence.length);
      expect(JSON.stringify(diagnostics)).not.toContain('SECRET_SENTINEL');
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);

it.each([null, 401, 101, 503])('never retries unknown or non-503 failure %s', async (status) => {
  let calls = 0;
  await expect(
    openChannelWithUnavailableRetry(
      async () => {
        calls++;
        return { opened: false, index: -1, status, closeCode: 4401 };
      },
      () => {}
    )
  ).rejects.toThrow('Channel handshake refused');
  expect(calls).toBe(1);
});
