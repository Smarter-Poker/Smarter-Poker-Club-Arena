import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import {
  loopbackRealtimeConfiguration,
  assertRealtimeHttpListener,
  verifyRealtimePeerBoundary,
} from '../../operations/release/fixture/fixture-server.mjs';

const source = await readFile(
  new URL('./fixtures/realtime-launcher/runtime.exs', import.meta.url),
  'utf8'
);

test('exact upstream runtime config receives only the HTTP socket bind adaptation', () => {
  const after = loopbackRealtimeConfiguration(source);
  assert.equal(
    after.replace(
      'socket_opts: [realtime_ip_version, {:ip, {127, 0, 0, 1}}]',
      'socket_opts: [realtime_ip_version]'
    ),
    source
  );
  for (const changed of [source + '\n', source.replace('PORT', 'OTHER_PORT'), after]) {
    assert.throws(() => loopbackRealtimeConfiguration(changed), /CONFIG_PREIMAGE_REFUSED/);
  }
});

const header =
  ' sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
const row = (address, state = '0A') =>
  ` 0: ${address}:0FA0 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 123 1`;
const table = (...rows) => header + '\n' + rows.join('\n') + '\n';

test('actual listener table permits only one IPv4 127.0.0.1 port4000 listener', () => {
  assertRealtimeHttpListener(table(row('0100007F')), table());
  assertRealtimeHttpListener(table(row('0100007F'), row('00000000', '01')), table());
  assertRealtimeHttpListener(
    table(row('0100007F')),
    table().replace('rem_address', 'remote_address')
  );
  for (const [v4, v6] of [
    [table(), table()],
    [table(row('00000000')), table()],
    [table(row('0200007F')), table()],
    [table(row('0100007F'), row('00000000')), table()],
    [table(row('0100007F')), table(row('0'.repeat(32)))],
    [table(row('0100007F'), row('0100007F')), table()],
  ])
    assert.throws(() => assertRealtimeHttpListener(v4, v6), /LISTENER_REFUSED/);
  assert.throws(() => assertRealtimeHttpListener('unreadable', table()));
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
async function withGateway(callback, healthStatus = 200, adminStatus = 403) {
  const requested = [];
  const api = http.createServer((request, response) => {
    requested.push(request.url);
    response.writeHead(request.url === '/auth/v1/health' ? healthStatus : adminStatus);
    response.end();
  });
  const apiPort = await listen(api);
  // This local transport test checks refusal semantics, not Linux peer isolation.
  const unused = net.createServer();
  const realtimePort = await listen(unused);
  await close(unused);
  try {
    return await callback({ host: '127.0.0.1', apiPort, realtimePort }, requested);
  } finally {
    await close(api);
  }
}

test('peer proof requires a reachable gateway and an actually refused direct TCP connection', async () =>
  withGateway(async (options, requests) => {
    await verifyRealtimePeerBoundary(options);
    assert.deepEqual(requests, ['/auth/v1/health', '/realtime/v1/api/tenants/realtime-dev']);
  }));

test('an exposed Realtime port fails even when the gateway denies tenant administration', async () =>
  withGateway(async (options) => {
    const exposed = net.createServer((socket) => socket.end());
    const realtimePort = await listen(exposed);
    try {
      await assert.rejects(
        verifyRealtimePeerBoundary({ ...options, realtimePort }),
        /REALTIME_EXPOSED/
      );
    } finally {
      await close(exposed);
    }
  }));

test('a failed positive control or exposed gateway administration cannot pass peer proof', async () => {
  await withGateway(async (options, requests) => {
    await assert.rejects(verifyRealtimePeerBoundary(options));
    assert.deepEqual(requests, ['/auth/v1/health']);
  }, 503);
  await withGateway(
    async (options) => {
      await assert.rejects(verifyRealtimePeerBoundary(options));
    },
    200,
    200
  );
});
