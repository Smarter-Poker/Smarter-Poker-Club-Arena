import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const primaryRef = 'kuklfnapbkmacvwxktbh';
const refused = () => {
  throw new Error('Replica schema route refused.');
};
const fields = [
  'identifier',
  'database_type',
  'db_host',
  'db_port',
  'db_user',
  'db_name',
  'pool_mode',
];
const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
function exact(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    refused();
}
export function descriptor(value) {
  exact(value, fields);
  if (
    typeof value.identifier !== 'string' ||
    !/^[a-z]{20}$/.test(value.identifier) ||
    value.identifier === primaryRef ||
    value.database_type !== 'READ_REPLICA' ||
    ![5432, 6543].includes(value.db_port) ||
    value.db_name !== 'postgres' ||
    !['session', 'transaction'].includes(value.pool_mode)
  )
    refused();
  const direct = value.db_host === `db.${value.identifier}.supabase.co`;
  if (
    !(
      direct &&
      value.db_user === 'postgres' &&
      value.db_port === 5432 &&
      value.pool_mode === 'session'
    ) &&
    !(
      typeof value.db_host === 'string' &&
      pooler.test(value.db_host) &&
      value.db_user === `postgres.${value.identifier}`
    )
  )
    refused();
  return Object.freeze({ ...value });
}
export function connection(primary, input) {
  const target = descriptor(input);
  let url;
  try {
    url = new URL(primary);
  } catch {
    refused();
  }
  const permitted = new Set(['sslmode', 'connect_timeout']);
  const keys = [...url.searchParams.keys()];
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash ||
    url.pathname !== '/postgres' ||
    !url.password ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !permitted.has(key)) ||
    (url.searchParams.has('sslmode') &&
      !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')))
  )
    refused();
  if (
    url.searchParams.has('connect_timeout') &&
    !/^[1-9][0-9]?$/.test(url.searchParams.get('connect_timeout'))
  )
    refused();
  const direct =
    url.hostname === `db.${primaryRef}.supabase.co` &&
    url.username === 'postgres' &&
    (!url.port || url.port === '5432');
  const pooled =
    pooler.test(url.hostname) &&
    decodeURIComponent(url.username) === `postgres.${primaryRef}` &&
    ['5432', '6543'].includes(url.port);
  if (!direct && !pooled) refused();
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require');
  url.hostname = target.db_host;
  url.port = String(target.db_port);
  url.username = target.db_user;
  return url.toString();
}
export const primaryQuery =
  "SELECT jsonb_build_object('version_num',current_setting('server_version_num'),'current_wal_lsn',pg_catalog.pg_current_wal_lsn()::text);";
export const query =
  "SELECT jsonb_build_object('in_recovery',pg_catalog.pg_is_in_recovery(),'in_hot_standby',current_setting('in_hot_standby'),'read_only',current_setting('transaction_read_only'),'feedback',current_setting('hot_standby_feedback'),'version_num',current_setting('server_version_num'),'replay_lsn',pg_catalog.pg_last_wal_replay_lsn()::text);";
function lsn(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(value)) refused();
  const [high, low] = value.split('/');
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}
export function verify(primary, replica) {
  exact(primary, ['version_num', 'current_wal_lsn']);
  exact(replica, [
    'in_recovery',
    'in_hot_standby',
    'read_only',
    'feedback',
    'version_num',
    'replay_lsn',
  ]);
  if (
    typeof primary.version_num !== 'string' ||
    !/^17[0-9]{4}$/.test(primary.version_num) ||
    replica.version_num !== primary.version_num ||
    replica.in_recovery !== true ||
    replica.in_hot_standby !== 'on' ||
    replica.read_only !== 'on' ||
    replica.feedback !== 'off' ||
    lsn(replica.replay_lsn) < lsn(primary.current_wal_lsn)
  )
    refused();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    if (extra.length) refused();
    if (mode === 'connection' && !first && !second)
      process.stdout.write(
        connection(
          process.env.DATABASE_URL,
          JSON.parse(process.env.LEADERBOARD_SCHEMA_REPLICA_DESCRIPTOR)
        )
      );
    else if (mode === 'query' && !first && !second) process.stdout.write(query);
    else if (mode === 'primary-query' && !first && !second) process.stdout.write(primaryQuery);
    else if (mode === 'verify' && first && second)
      verify(JSON.parse(readFileSync(first, 'utf8')), JSON.parse(readFileSync(second, 'utf8')));
    else refused();
  } catch {
    console.error('Replica schema route refused.');
    process.exitCode = 1;
  }
}
