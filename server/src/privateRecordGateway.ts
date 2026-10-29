import { readFileSync } from 'node:fs';
import { preparePrivateRecordGatewaySocket } from './transport/privateRecordGatewaySocket.js';
import {
  createPrivateRecordGatewayHealthHandler,
  gatewayListenTarget,
  PRIVATE_RECORD_GATEWAY_ORIGINS,
} from './transport/privateRecordGatewayRuntime.js';
/** Separate process entry point. Never imported by index.ts or the game engine. */
import { createServer } from 'node:http';
import { PrivateRecordGateway } from './transport/PrivateRecordGateway.js';
import { PrivateRecordListener } from './services/supabase/privateRecordListener.js';
import { defaultOpenSession } from './services/supabase/pgListenSession.js';
import {
  createPrivateRecordGatewayAccess,
  privateRecordGatewaySourceReady,
} from './services/supabase/privateRecordGatewayAccess.js';

// Supplied to this service by the canonical secret store, never copied from an engine file.
const connection = process.env.PRIVATE_RECORD_GATEWAY_DATABASE_URL;
if (!connection) throw new Error('record gateway requires its own database session');
const listenTarget = gatewayListenTarget(process.env);
const release = JSON.parse(
  readFileSync(new URL('../gateway-release.json', import.meta.url), 'utf8')
);
if (
  release.schema !== 1 ||
  release.component !== 'private-record-gateway' ||
  !/^[0-9a-f]{40}$/.test(release.revision) ||
  (process.env.PRIVATE_RECORD_GATEWAY_REVISION &&
    release.revision !== process.env.PRIVATE_RECORD_GATEWAY_REVISION)
)
  throw new Error('record gateway immutable release identity mismatch');
const access = createPrivateRecordGatewayAccess(process.env);
const gateway = new PrivateRecordGateway({
  origins: PRIVATE_RECORD_GATEWAY_ORIGINS,
  authenticate: access.authenticate,
  authorize: access.authorize,
  source: (changed, readiness) =>
    new PrivateRecordListener(
      changed,
      readiness,
      async () => connection,
      (url) => defaultOpenSession(url, `club-arena-private-record-gateway:${process.pid}`),
      privateRecordGatewaySourceReady
    ),
});
const server = createServer(
  createPrivateRecordGatewayHealthHandler(release.revision, () => gateway.sourceState())
);
if ('socket' in listenTarget) await preparePrivateRecordGatewaySocket(listenTarget.socket);
gateway.attach(server);
if ('socket' in listenTarget) server.listen(listenTarget.socket);
else server.listen(listenTarget.port, listenTarget.host);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void gateway
    .close()
    .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
    .catch(() => {
      process.exitCode = 1;
    });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
process.on('SIGUSR2', () => gateway.drain(stop));
