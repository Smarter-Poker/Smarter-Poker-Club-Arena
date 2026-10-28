import { readFileSync } from 'node:fs';
import {
  gatewayListenTarget,
  PRIVATE_RECORD_GATEWAY_ORIGINS,
} from './transport/privateRecordGatewayRuntime.js';
import { privateRecordTransportReady } from './services/supabase/privateRecordTransportReady.js';
/** Separate process entry point. Never imported by index.ts or the game engine. */
import { createServer } from 'node:http';
import { PrivateRecordGateway } from './transport/PrivateRecordGateway.js';
import { PrivateRecordListener } from './services/supabase/privateRecordListener.js';
import { defaultOpenSession } from './services/supabase/pgListenSession.js';
import { supabase, privateRecordTopicAllowed } from './services/supabase/client.js';
import { playerSessionVerdict } from './services/PlayerSessionAccess.js';
import { verifySupabaseToken, type TokenVerdict } from './transport/wsHelpers.js';

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
async function authenticate(token: string): Promise<TokenVerdict> {
  const verdict = await verifySupabaseToken(supabase.auth, token);
  if (!verdict.userId) return verdict;
  const session = await playerSessionVerdict(verdict.userId, token);
  return session === 'alive'
    ? verdict
    : {
        denied: session === 'revoked' ? 'invalid' : 'unavailable',
        code: session === 'revoked' ? 'session_not_found' : 'session_check_unavailable',
      };
}
const gateway = new PrivateRecordGateway({
  origins: PRIVATE_RECORD_GATEWAY_ORIGINS,
  authenticate,
  authorize: async (token, userId, topic) => {
    const verdict = await authenticate(token);
    if (!verdict.userId && verdict.denied === 'unavailable')
      throw new Error('record authorization unavailable');
    return verdict.userId === userId && (await privateRecordTopicAllowed(token, topic));
  },
  source: (changed, readiness) =>
    new PrivateRecordListener(
      changed,
      readiness,
      async () => connection,
      (url) => defaultOpenSession(url, `club-arena-private-record-gateway:${process.pid}`),
      privateRecordTransportReady
    ),
});
const server = createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  // Process reachability is deliberately not named source readiness.
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      service: 'private-record-gateway',
      revision: release.revision,
      processReachable: true,
      ...gateway.sourceState(),
    })
  );
});
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
