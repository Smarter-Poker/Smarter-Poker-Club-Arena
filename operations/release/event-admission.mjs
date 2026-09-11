import http from 'node:http';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { connect } from './journal.mjs';
import { providerCall } from './provider-journal.mjs';

const invalid = () => {
  throw new Error('RELEASE_AUTHENTICATED_DELIVERY_REQUIRED');
};
export function verifiedDelivery({ headers, body, secret, repositories }) {
  if (
    !Buffer.isBuffer(body) ||
    body.length > 65536 ||
    !Buffer.isBuffer(secret) ||
    secret.length < 24 ||
    headers['x-github-event'] !== 'repository_dispatch' ||
    !/^[0-9a-f-]{36}$/.test(headers['x-github-delivery'] ?? '') ||
    !/^sha256=[0-9a-f]{64}$/.test(headers['x-hub-signature-256'] ?? '')
  )
    invalid();
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(headers['x-hub-signature-256'].slice(7), 'hex');
  if (!timingSafeEqual(expected, actual)) invalid();
  const payload = JSON.parse(body.toString('utf8'));
  const { intent, client_key: key } = payload.client_payload ?? {};
  if (
    payload.action !== 'release_intent' ||
    !repositories.includes(payload.repository?.full_name) ||
    payload.repository.full_name !== intent?.repository ||
    !Number.isSafeInteger(payload.sender?.id) ||
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > 200
  )
    invalid();
  return {
    delivery_id: headers['x-github-delivery'],
    payload_digest: createHash('sha256').update(body).digest('hex'),
    client_key: key,
    intent,
    actor: `github-actor:${payload.sender.id}`,
  };
}

// One in-process Unix socket endpoint. An installed authenticated HTTPS ingress
// forwards the untouched signed bytes here. No second polling coordinator.
export async function admissionServer({
  database,
  principal,
  secret,
  repositories,
  certificateCallback,
  staticPublicationCallback,
  socket = '/var/lib/club-arena-release-controller/admission.sock',
}) {
  if (
    !Array.isArray(repositories) ||
    !repositories.length ||
    socket !== '/var/lib/club-arena-release-controller/admission.sock'
  )
    throw new Error('RELEASE_ADMISSION_INSTALLATION_REQUIRED');
  try {
    const prior = await lstat(socket);
    if (!prior.isSocket() || prior.uid !== process.getuid())
      throw new Error('RELEASE_ADMISSION_SOCKET_REFUSED');
    await unlink(socket);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = http.createServer(
    admissionHandler({
      database,
      principal,
      secret,
      repositories,
      certificateCallback,
      staticPublicationCallback,
    })
  );
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 2;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return async () => {
    await new Promise((resolve) => server.close(resolve));
    await unlink(socket);
  };
}

// Shared by the installed Unix socket and local HTTP integration tests.
export async function verifyAdmissionPrincipal(client, principal) {
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/.test(principal) ||
    client.connection?.stream?.encrypted !== true ||
    client.connection.stream.authorized !== true
  )
    invalid();
  const identity = (
    await client.query(`SELECT rolname, rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
    AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
    AND pg_has_role(oid,'release_journal_submitter','MEMBER')
    AND NOT EXISTS(SELECT 1 FROM pg_roles authority WHERE authority.rolname IN
      ('release_journal_controller','release_journal_operator','release_journal_verifier','release_certification_callback')
      AND pg_has_role(session_user,authority.oid,'MEMBER')) AS allowed
    FROM pg_roles WHERE rolname=session_user`)
  ).rows[0];
  if (identity?.rolname !== principal || identity?.allowed !== true) invalid();
}

export function admissionHandler({
  database,
  principal,
  secret,
  repositories,
  certificateCallback,
  staticPublicationCallback,
}) {
  let active = false;
  return async (request, response) => {
    const done = (code, result) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    };
    const callbackRoute =
      request.url === '/certification'
        ? certificateCallback
        : request.url === '/static-publication'
          ? staticPublicationCallback
          : null;
    if (request.method !== 'POST' || (!callbackRoute && request.url !== '/github') || active) {
      done(503, { accepted: false });
      request.resume();
      return;
    }
    active = true;
    let client;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65536) invalid();
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (callbackRoute) {
        const result = await callbackRoute.handle({
          authorization: request.headers.authorization,
          body: JSON.parse(body.toString('utf8')),
        });
        done(200, result);
        return;
      }
      const delivery = verifiedDelivery({
        headers: request.headers,
        body,
        secret,
        repositories,
      });
      client = await connect(database);
      await verifyAdmissionPrincipal(client, principal);
      const result = await providerCall(client, 'enqueue_delivery', [
        delivery.delivery_id,
        delivery.payload_digest,
        delivery.client_key,
        delivery.intent,
        delivery.actor,
      ]);
      done(200, {
        release_id: result.id,
        admission_seq: result.admission_seq,
        duplicate: result.duplicate,
      });
    } catch {
      if (!response.headersSent) done(400, { accepted: false });
    } finally {
      await client?.end().catch(() => {});
      active = false;
    }
  };
}
