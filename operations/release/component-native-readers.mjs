import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from './journal.mjs';
import { HetznerIntakeAdapter } from './adapters/hetzner.mjs';
import { certificationCall } from './certification-callback.mjs';
import { fullSha, uuid, requireCertificate as need } from './component-certificate.mjs';

function execute(file, args, { input, ...options }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr })
    );
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}
export function nativeFrontendReader({ hostAlias, invoke = execute, read = readFile }) {
  need(/^club-arena-static-[a-z0-9-]{1,40}$/.test(hostAlias), 'RELEASE_STATIC_HOST_ALIAS_REQUIRED');
  return async (sourceSha) => {
    need(fullSha.test(sourceSha));
    const script = await read(new URL('./native/read-native-frontend.py', import.meta.url));
    // Configured SSH alias must supply the existing pinned identity/host key.
    // No shell interpolation and no remote file write or installation.
    const result = await invoke(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'ConnectTimeout=15',
        hostAlias,
        'python3',
        '-',
        sourceSha,
      ],
      { input: script, timeout: 60000, maxBuffer: 1048576, encoding: 'utf8' }
    );
    return JSON.parse(result.stdout);
  };
}

export async function observePublishedEngine(intake, operation) {
  need(
    operation?.status === 'SUCCEEDED' &&
      uuid.test(operation.id) &&
      uuid.test(operation.epoch) &&
      operation.result?.outcome === 'SUCCEEDED' &&
      operation.result.source_sha === operation.request?.source_sha &&
      operation.result.image_id === operation.request?.artifact_image_id,
    'RELEASE_ORIGINAL_ENGINE_PUBLICATION_REQUIRED'
  );
  const reader = new HetznerIntakeAdapter({
    controlSha: operation.request.control_sha,
    request: intake.request,
  });
  // Never call reconcile here: it can resume partial native acceptance. This
  // reader permits one existing observe action and refuses every partial state.
  const observed = await reader.request('observe', reader.payload(operation.request, operation));
  need(
    observed.terminal === true &&
      observed.outcome === 'SUCCEEDED' &&
      observed.operation_id === operation.id &&
      observed.run_key === operation.request.run_key &&
      observed.source_sha === operation.request.source_sha &&
      observed.control_sha === operation.request.control_sha &&
      observed.image_id === operation.request.artifact_image_id &&
      ['sealed', 'already-released'].includes(observed.result),
    'RELEASE_ORIGINAL_ENGINE_SEAL_REQUIRED'
  );
  return { source_sha: observed.source_sha, image_id: observed.image_id };
}

// One callback/read connection at a time, separate from the controller owner
// connection. A callback may reuse its connection for native input lookups.
export function privateComponentDatabase(config, principal, open = connect) {
  need(/^[a-z_][a-z0-9_]{0,62}$/.test(principal), 'RELEASE_PRIVATE_COMPONENT_IDENTITY_REQUIRED');
  let pending = Promise.resolve();
  return async () => {
    const preceding = pending;
    let release;
    pending = new Promise((resolve) => {
      release = resolve;
    });
    await preceding;
    let client;
    try {
      client = await open(config);
      need(
        client.connection.stream.encrypted === true && client.connection.stream.authorized === true,
        'RELEASE_PRIVATE_COMPONENT_TLS_REQUIRED'
      );
      const role = (
        await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
        pg_has_role(oid,'release_certification_callback','MEMBER') AS callback,
        pg_has_role(oid,'release_journal_controller','MEMBER') AS controller,
        pg_has_role(oid,'release_journal_operator','MEMBER') AS operator,
        pg_has_role(oid,'release_journal_verifier','MEMBER') AS verifier,
        pg_has_role(oid,'release_journal_submitter','MEMBER') AS submitter
        FROM pg_roles WHERE rolname=session_user`)
      ).rows[0];
      need(
        role?.rolname === principal &&
          role.rolcanlogin &&
          role.callback &&
          !role.controller &&
          !role.operator &&
          !role.verifier &&
          !role.submitter &&
          !role.rolsuper &&
          !role.rolbypassrls &&
          !role.rolcreaterole &&
          !role.rolcreatedb &&
          !role.rolreplication,
        'RELEASE_PRIVATE_COMPONENT_IDENTITY_REQUIRED'
      );
      const close = client.end.bind(client);
      let closed = false;
      client.end = async () => {
        if (!closed) {
          closed = true;
          try {
            await close();
          } finally {
            release();
          }
        }
      };
      return client;
    } catch (error) {
      await client?.end().catch(() => {});
      release();
      throw error;
    }
  };
}

export function journalEngineReader({ database, intake }) {
  return async (request, _operation, existingClient) => {
    const client = existingClient ?? (await database());
    try {
      const original = await certificationCall(client, 'component_engine_publication', [
        request.release_id,
        request.component_tuple['club-arena-engine'],
      ]);
      return await observePublishedEngine(intake, original);
    } finally {
      if (!existingClient) await client.end();
    }
  };
}
