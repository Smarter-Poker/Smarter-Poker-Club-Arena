// Explicit session bound for the one source-pinned additive journal cover.
// Supavisor may ignore startup PGOPTIONS: set and verify on the owning backend.
import { createHash } from 'node:crypto';
export const SERIAL_JOURNAL_FILE = '20261022223439_adaptive_journal_metadata_cover.sql';
export const SERIAL_JOURNAL_SHA = '1922ecbde6a5cfa600e21d0e48aae8941036bcc08db12af5b263710dee3c6696';
export function validateSerialJournalIndex({ enabled, file, sql, preamble, otherModes }) {
  if (!enabled) return false;
  if (file !== SERIAL_JOURNAL_FILE || createHash('sha256').update(sql).digest('hex') !== SERIAL_JOURNAL_SHA)
    throw new Error('serial journal index requires exact merged migration bytes');
  if (otherModes || preamble.length !== 1 || preamble[0].schema !== 'public' || preamble[0].name !== 'horse_adaptive_journal_metadata_cover')
    throw new Error('serial journal index requires only its one ordinary concurrent preamble');
  return true;
}
export function validateSerialJournalConnection(url) {
  if (url.port !== '5432' || url.hostname !== 'aws-0-us-west-2.pooler.supabase.com' ||
      decodeURIComponent(url.username) !== 'postgres.kuklfnapbkmacvwxktbh' || url.pathname !== '/postgres')
    throw new Error('serial journal index requires supported Supavisor session port 5432');
}
// Use the configured credential unchanged on the provider's session port.
// Only this explicit source-bound mode may select the documented sibling port.
export function serialJournalConnection(url) {
  if (!['5432', '6543'].includes(url.port))
    throw new Error('serial journal index requires a configured Supavisor endpoint');
  const session = new URL(url);
  session.port = '5432';
  validateSerialJournalConnection(session);
  return session;
}
export async function bindSerialJournalIndex(client) {
  const before = await client.query('SELECT pg_backend_pid() AS pid, session_user AS session_user, current_user AS current_user, pg_is_in_recovery() AS recovery, current_database() AS database');
  if (before.rows.length !== 1 || !Number.isInteger(before.rows[0].pid) || before.rows[0].pid <= 0 ||
      before.rows[0].session_user !== 'postgres' || before.rows[0].current_user !== 'postgres' ||
      before.rows[0].recovery !== false || before.rows[0].database !== 'postgres')
    throw new Error('serial journal backend identity unknown');
  await client.query('SET max_parallel_maintenance_workers = 0');
  const after = await client.query("SELECT pg_backend_pid() AS pid, current_setting('max_parallel_maintenance_workers') AS workers");
  if (after.rows.length !== 1 || after.rows[0].pid !== before.rows[0].pid || after.rows[0].workers !== '0')
    throw new Error('serial journal worker bound or stable backend unproven; no index sent');
}
