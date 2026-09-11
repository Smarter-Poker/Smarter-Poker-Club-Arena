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
  secret,
  repositories,
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
  let active = false;
  const server = http.createServer(async (request, response) => {
    const done = (code, result) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    };
    if (request.method !== 'POST' || request.url !== '/github' || active) {
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
      const delivery = verifiedDelivery({
        headers: request.headers,
        body: Buffer.concat(chunks),
        secret,
        repositories,
      });
      client = await connect(database);
      const identity = (
        await client.query(
          "SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND pg_has_role(oid,'release_journal_submitter','MEMBER') AS allowed FROM pg_roles WHERE rolname=session_user"
        )
      ).rows[0];
      if (identity?.allowed !== true) invalid();
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
  });
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
