import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Finite qualification envelope, not replacement values or production changes.
export const bounds = Object.freeze({
  max_connections: [1, 1000],
  max_locks_per_transaction: [10, 1024],
  max_prepared_transactions: [0, 1000],
  autovacuum_max_workers: [1, 64],
  max_worker_processes: [0, 256],
  max_wal_senders: [0, 256],
});
export const query = `SELECT jsonb_agg(jsonb_build_object('name',name,'setting',setting) ORDER BY name) FROM pg_catalog.pg_settings WHERE name IN (${Object.keys(
  bounds
)
  .map((name) => `'${name}'`)
  .join(',')});`;

export function profile(input) {
  if (!Array.isArray(input) || input.length !== 6) throw new Error('profile refused');
  const values = new Map();
  for (const row of input) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).length !== 2 ||
      !Object.hasOwn(row, 'name') ||
      !Object.hasOwn(row, 'setting') ||
      !Object.hasOwn(bounds, row.name) ||
      values.has(row.name) ||
      typeof row.setting !== 'string' ||
      !/^(0|[1-9][0-9]{0,6})$/.test(row.setting)
    )
      throw new Error('profile refused');
    const value = Number(row.setting);
    const [minimum, maximum] = bounds[row.name];
    if (value < minimum || value > maximum) throw new Error('profile refused');
    values.set(row.name, value);
  }
  // Reject oversized combinations rather than silently lowering source settings.
  // This bounded envelope counts the six source-controlled contributors; the
  // selected PG17 binary retains its own fixed special-worker contribution.
  const capacity =
    values.get('max_locks_per_transaction') *
    [
      'max_connections',
      'max_prepared_transactions',
      'autovacuum_max_workers',
      'max_worker_processes',
      'max_wal_senders',
    ].reduce((total, name) => total + values.get(name), 0);
  if (!Number.isSafeInteger(capacity) || capacity > 200000) throw new Error('profile refused');
  return Object.keys(bounds)
    .map((name) => `${name} = ${values.get(name)}\n`)
    .join('');
}

export function same(left, right) {
  if (profile(left) !== profile(right)) throw new Error('profile mismatch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, first, second, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('arguments refused');
    if (mode === 'query' && !first && !second) process.stdout.write(query);
    else if (mode === 'config' && first && !second)
      process.stdout.write(profile(JSON.parse(readFileSync(first, 'utf8'))));
    else if (mode === 'verify' && first && second)
      same(JSON.parse(readFileSync(first, 'utf8')), JSON.parse(readFileSync(second, 'utf8')));
    else throw new Error('arguments refused');
  } catch {
    console.error('Numeric startup profile refused or differs.');
    process.exitCode = 1;
  }
}
