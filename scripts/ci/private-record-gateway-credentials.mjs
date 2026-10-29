import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const PROJECT = 'kuklfnapbkmacvwxktbh';
export const disabledMarker = 'ca-private-record-listener:v1:disabled:20261028154533';
export const roleAdmissionSql = readFileSync(
  new URL('./private-record-gateway-role-admission.sql', import.meta.url),
  'utf8'
);
// Complete bodies read on production 2026-10-28. These existing PUBLIC definers
// only read leaderboards/staff/challenges, or transform NEW in a trigger. No
// financial mutation definer is allowed. Changed/new bodies refuse admission.
const benignDefiners = new Map([
  ['public.fn_club_leaderboard_period_v2', '9c7467edd1c92389dc846a396492cafb'],
  ['public.fn_global_leaderboard_period', '994e42b923d79f029ea4f71b8f6e1896'],
  ['public.fn_home_is_group_staff', '34c272e636299f9f5eb201f3762502d3'],
  ['public.fn_tournament_fee_names_its_player', 'a34e26b81ceeda38237b739245ff11f6'],
  ['public.fn_user_rank_global_period', 'dc9990b44cae07eb70ed4c296e6a8f7e'],
  ['public.get_daily_challenge', '4d64ebacbfa5bd2c333f9d38ad32ebe7'],
]);
export function deriveGatewayConnection(adminConnection, newPassword) {
  if (typeof newPassword !== 'string' || !/^[a-f0-9]{64,128}$/.test(newPassword))
    throw Error('new canonical gateway password missing or invalid');
  let admin;
  try {
    admin = new URL(adminConnection);
  } catch {
    throw Error('canonical database endpoint unavailable');
  }
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || admin.pathname !== '/postgres')
    throw Error('canonical database endpoint unavailable');
  const direct = admin.hostname === `db.${PROJECT}.supabase.co`;
  const pooler =
    admin.hostname.endsWith('.pooler.supabase.com') &&
    decodeURIComponent(admin.username) === `postgres.${PROJECT}`;
  if (!direct && !pooler) throw Error('canonical endpoint does not establish production project');
  if (admin.port && !['5432', '6543'].includes(admin.port))
    throw Error('unsupported canonical database endpoint');
  if (direct && admin.port === '6543')
    throw Error('direct database endpoint cannot use transaction pooling');
  const result = new URL(admin.toString());
  result.username = pooler ? `ca_record_gateway.${PROJECT}` : 'ca_record_gateway';
  result.password = newPassword;
  result.port = '5432';
  result.search = '';
  result.hash = '';
  return result.toString();
}
// PG17 grants a nonsuperuser CREATEROLE creator ADMIN on its new role, with
// INHERIT/SET false. This reverse administration edge grants the listener no
// powers. Admit only the explicit trusted postgres creator, never a role that
// the listener itself can inherit/SET, an extra administrator or broader edge.
export function assertRoleAdmission(audit) {
  const role = audit?.role;
  if (
    !role ||
    role.name !== 'ca_record_gateway' ||
    ['superuser', 'inherit', 'createRole', 'createDb', 'replication', 'bypassRls'].some(
      (key) => role[key] !== false
    ) ||
    typeof role.login !== 'boolean' ||
    role.connectionLimit !== 4
  )
    throw Error('dedicated role attributes are unqualified');
  if (
    !Array.isArray(audit.memberships) ||
    audit.memberships.length > 1 ||
    audit.memberships.some(
      (edge) =>
        edge.role !== 'ca_record_gateway' ||
        edge.member !== 'postgres' ||
        edge.admin !== true ||
        edge.inherit !== false ||
        edge.set !== false ||
        edge.memberSuperuser !== false ||
        edge.memberCreateRole !== true
    ) ||
    audit.ownedObjects !== 0 ||
    audit.canConnect !== true ||
    audit.canCreateDatabaseObjects !== false
  )
    throw Error('dedicated role membership/ownership/database privilege is unqualified');
  if (
    !Array.isArray(audit.writableRelations) ||
    audit.writableRelations.length ||
    !Array.isArray(audit.creatableSchemas) ||
    audit.creatableSchemas.length ||
    !Array.isArray(audit.executableDefiners)
  )
    throw Error('effective inherited PUBLIC privileges are unqualified');
  for (const routine of audit.executableDefiners)
    if (benignDefiners.get(routine.name) !== routine.hash)
      throw Error('effective unreviewed privileged routine execution is unqualified');
  return role;
}
export function gatewayScramVerifier(password, salt = randomBytes(16)) {
  if (!/^[a-f0-9]{64,128}$/.test(password))
    throw Error('canonical generated password must be high-entropy hexadecimal');
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
export async function installGatewayCredential({
  admin,
  newPassword,
  adminConnection,
  operationId,
  verify,
}) {
  if (!/^[0-9]+$/.test(operationId ?? '')) throw Error('credential operation identity missing');
  const connection = deriveGatewayConnection(adminConnection, newPassword);
  const readyPrefix = `ca-private-record-credentials:v1:${fingerprint(newPassword)}:`;
  const expectedReady = readyPrefix + operationId;
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s'");
    const lock = await admin.query('SELECT pg_try_advisory_xact_lock(530091,1) AS admitted');
    if (lock.rows[0]?.admitted !== true) throw Error('another credential operation owns the role');
    const role = assertRoleAdmission((await admin.query(roleAdmissionSql)).rows[0]?.admission);
    if (role.login) {
      if (
        !role.marker?.startsWith(readyPrefix) ||
        !/^\d+$/.test(role.marker.slice(readyPrefix.length))
      )
        throw Error('already-enabled role has unknown credential ownership; no rotation allowed');
      await admin.query('ROLLBACK');
      await verify(connection);
      return {
        status: 'already-ready',
        operationId,
        originalOperationId: role.marker.slice(readyPrefix.length),
        role: 'ca_record_gateway',
      };
    }
    if (role.marker !== disabledMarker)
      throw Error('disabled role marker changed; no credential adoption allowed');
    // The new canonical secret already exists. This first-login transaction never
    // rotates an enabled identity. Send a fresh SCRAM verifier rather than the
    // plaintext canonical password, which database statement logs could expose.
    // Escape the verifier locally and never log its SQL.
    const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
    await admin.query(
      `ALTER ROLE ca_record_gateway LOGIN PASSWORD ${literal(gatewayScramVerifier(newPassword))}`
    );
    await admin.query(`COMMENT ON ROLE ca_record_gateway IS ${literal(expectedReady)}`);
    assertRoleAdmission((await admin.query(roleAdmissionSql)).rows[0]?.admission);
    await admin.query('COMMIT');
  } catch (error) {
    try {
      await admin.query('ROLLBACK');
    } catch {}
    throw error;
  }
  // A failed acknowledgment/probe does not reverse or rotate the now committed
  // credential. Re-read the same marker and verify on its next explicit attempt.
  await verify(connection);
  return { status: 'installed', operationId, role: 'ca_record_gateway' };
}
async function main() {
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const { Client } = require('pg');
  const { enginePgSsl } = await import('../../server/src/services/supabase/enginePgSession.ts');
  const canonical = process.env.DATABASE_URL;
  const password = process.env.PRIVATE_RECORD_GATEWAY_DB_PASSWORD;
  const dedicated = deriveGatewayConnection(canonical, password);
  const adminUrl = new URL(canonical);
  // pg's connection-string SSL options can override explicit verified CA roots.
  for (const key of [...adminUrl.searchParams.keys()])
    if (/^ssl/i.test(key)) adminUrl.searchParams.delete(key);
  const options = {
    ssl: enginePgSsl(),
    connectionTimeoutMillis: 10000,
    application_name: 'ca-private-record-credential-install',
  };
  const admin = new Client({ ...options, connectionString: adminUrl.toString() });
  const verify = async (connection) => {
    const client = new Client({
      ...options,
      connectionString: connection,
      application_name: 'ca-private-record-listener-qualification',
    });
    try {
      await client.connect();
      const result = await client.query('SELECT current_user AS role');
      if (result.rows[0]?.role !== 'ca_record_gateway')
        throw Error('dedicated connection identity mismatch');
      await client.query("SET statement_timeout='5s'; SET lock_timeout='500ms'");
      const role = assertRoleAdmission((await client.query(roleAdmissionSql)).rows[0]?.admission);
      const prefix = `ca-private-record-credentials:v1:${fingerprint(password)}:`;
      if (
        role.login !== true ||
        !role.marker?.startsWith(prefix) ||
        !/^\d+$/.test(role.marker.slice(prefix.length))
      )
        throw Error('dedicated credential ownership is not qualified');
      await client.query('LISTEN ca_private_record_changes');
      await client.query('UNLISTEN ca_private_record_changes');
    } finally {
      await client.end();
    }
  };
  if (process.argv[2] === 'verify') {
    await verify(dedicated);
    console.log(JSON.stringify({ status: 'verified-read-only', role: 'ca_record_gateway' }));
    return;
  }
  try {
    await admin.connect();
    const result = await installGatewayCredential({
      admin,
      newPassword: password,
      adminConnection: canonical,
      operationId: process.env.GITHUB_RUN_ID,
      verify,
    });
    if (dedicated !== deriveGatewayConnection(canonical, password))
      throw Error('canonical endpoint changed');
    console.log(JSON.stringify(result));
  } finally {
    await admin.end();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch(() => {
    console.error(
      'Dedicated gateway credential refused or verification failed; inspect role attributes/owned marker and the original operation. No enabled credential was rotated.'
    );
    process.exitCode = 1;
  });
