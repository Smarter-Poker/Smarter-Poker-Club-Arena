#!/usr/bin/env node
// Read-only prerequisite of the existing production verifier. Never installs,
// creates a fixture, retires an account, or starts a release.
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { URL as NodeURL, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const VERSION = '20261029193107';
export const NAME = 'certification_cleanup_locks_only_its_own_club_graph';
export const EXPECTED = Object.freeze({
  'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)':
    '9b0480f2e3b78233289c31f8484a5bb2',
  'public.fn_guard_retired_club_mutation()': '66b05912e3963815a560db03d54c74c9',
  'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)':
    'c0c18ff26859194b2ad98d3186b30f1d',
  'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)':
    '11c2a704620600fad8b91d50f3b64e1a',
  'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)':
    '8bf604a9e6ea826412234d552e83e2a9',
});
// Derived from the exact migration in the isolated PostgreSQL fixture.
export const HELPER_HASH = 'be823a508db58c1c54158f106cc677be';
export const WAIT_MS = 12 * 60_000;
export const POLL_MS = 15_000;
export const PROOF_SQL = `SELECT
  (SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name)), '[]'::jsonb)
     FROM supabase_migrations.schema_migrations WHERE version=$1 OR name=$2) AS history,
  (SELECT jsonb_object_agg(signature, md5(pg_get_functiondef(to_regprocedure(signature))))
     FROM unnest($3::text[]) AS signatures(signature)) AS definitions,
  md5(pg_get_functiondef(to_regprocedure('smarter_private.certification_club_admission(uuid)'))) AS helper_hash,
  EXISTS (SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure('smarter_private.certification_club_admission(uuid)')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                       WHERE a.grantee<>p.proowner)) AS helper_owner_only`;

export function classifyProof(row) {
  if (!row || !Array.isArray(row.history))
    throw new Error('Cleanup migration history is unreadable');
  if (row.history.length === 0) return 'pending';
  if (
    row.history.length !== 1 ||
    row.history[0]?.version !== VERSION ||
    row.history[0]?.name !== NAME
  )
    throw new Error('Cleanup migration history identity differs');
  if (
    !row.definitions ||
    typeof row.definitions !== 'object' ||
    Array.isArray(row.definitions) ||
    Object.keys(row.definitions).length !== Object.keys(EXPECTED).length
  )
    throw new Error('Cleanup function catalog is incomplete');
  for (const [signature, hash] of Object.entries(EXPECTED)) {
    if (row.definitions[signature] !== hash)
      throw new Error(`Cleanup function identity differs: ${signature}`);
  }
  if (row.helper_hash !== HELPER_HASH) throw new Error('Cleanup admission helper identity differs');
  if (row.helper_owner_only !== true)
    throw new Error('Cleanup admission helper is missing or grants non-owner access');
  return 'ready';
}

export async function awaitCleanupSafety({
  read,
  now = () => performance.now(),
  pause = sleep,
  report = console.error,
}) {
  const deadline = now() + WAIT_MS;
  while (now() < deadline) {
    const state = classifyProof(await read());
    if (now() >= deadline) break;
    if (state === 'ready') return true;
    report('Scoped certification cleanup is not installed; production fixtures remain blocked.');
    await pause(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error(
    'Scoped certification cleanup was not proven within the 12-minute prerequisite budget; no fixture admitted'
  );
}

export function connectionConfig(raw) {
  const url = new NodeURL(raw || '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== '/postgres' ||
    !(
      url.hostname === 'db.kuklfnapbkmacvwxktbh.supabase.co' ||
      (url.hostname.endsWith('.pooler.supabase.com') &&
        decodeURIComponent(url.username) === 'postgres.kuklfnapbkmacvwxktbh')
    )
  )
    throw new Error('Canonical production readback endpoint is required');
  for (const key of [...url.searchParams.keys()])
    if (/^ssl/i.test(key) || key === 'options') url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ca: [
        ...rootCertificates,
        readFileSync(
          new NodeURL('./certificates/supabase-prod-ca-2021.crt', import.meta.url),
          'utf8'
        ),
      ],
    },
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
    application_name: 'ca-certification-cleanup-safety-readonly',
  };
}

export async function readProof(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const result = await client.query(PROOF_SQL, [VERSION, NAME, Object.keys(EXPECTED)]);
    if (result.rows?.length !== 1)
      throw new Error('Cleanup catalog proof must return exactly one row');
    return result.rows[0];
  } finally {
    await client.query('ROLLBACK');
  }
}

export function safeFailure(error) {
  const allowed = new Set([
    'Cleanup migration history is unreadable',
    'Cleanup migration history identity differs',
    'Cleanup function catalog is incomplete',
    'Cleanup admission helper is missing or grants non-owner access',
    'Cleanup admission helper identity differs',
    'Cleanup catalog connection became unreadable',
    'Cleanup catalog proof must return exactly one row',
    'Scoped certification cleanup was not proven within the 12-minute prerequisite budget; no fixture admitted',
    'Canonical production readback endpoint is required',
    ...Object.keys(EXPECTED).map((signature) => `Cleanup function identity differs: ${signature}`),
  ]);
  return allowed.has(error?.message)
    ? error.message
    : 'Database evidence could not be read safely; no fixture admitted';
}

export async function closeReadOnlyClient(client, { pause = sleep } = {}) {
  // A broken socket must not keep this finite prerequisite alive indefinitely.
  // pg.end destroys an active-query socket; the deadline bounds an idle close.
  const timer = new AbortController();
  try {
    await Promise.race([
      client.end(),
      pause(2000, undefined, { ref: false, signal: timer.signal }).then(() => {
        client.connection?.stream?.destroy();
        throw new Error('Database evidence connection did not close');
      }),
    ]);
  } finally {
    timer.abort();
  }
}

async function main() {
  const { default: pg } = await import('pg');
  const client = new pg.Client(connectionConfig(process.env.DATABASE_URL));
  let connectionError;
  client.on('error', (error) => {
    connectionError = error;
  });
  try {
    await client.connect();
    await awaitCleanupSafety({
      read: () => {
        if (connectionError) throw new Error('Cleanup catalog connection became unreadable');
        return readProof(client);
      },
    });
    console.log(
      'Scoped certification cleanup history, five function identities and owner-only helper ACL verified.'
    );
  } finally {
    await closeReadOnlyClient(client);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Certification prerequisite refused: ${safeFailure(error)}`);
    process.exitCode = 1;
  });
}
