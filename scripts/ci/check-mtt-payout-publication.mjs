import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const payoutMigrations = [
  '20261029202310_all_new_mtt_tournaments_pay_the_top_fifteen_percent.sql',
  '20261029202847_unfinalized_mtt_fields_adopt_fifteen_percent_payout_depth.sql',
];

export function requirements(root) {
  if (!existsSync(join(root, 'supabase/migrations', payoutMigrations[0]))) return [];
  return payoutMigrations.map((file) => ({
    version: file.slice(0, 14),
    name: file.slice(15, -4),
    sql_md5: createHash('md5')
      .update(readFileSync(join(root, 'supabase/migrations', file)))
      .digest('hex'),
  }));
}

export function assertInstalled(expected, rows) {
  for (const migration of expected) {
    const matches = rows.filter((row) => row.version === migration.version);
    if (
      matches.length !== 1 ||
      matches[0].name !== migration.name ||
      matches[0].statement_count !== 1 ||
      matches[0].sql_md5 !== migration.sql_md5
    ) {
      throw new Error(
        `MTT payout publication refused: exact migration ${migration.version} is not proved installed`
      );
    }
  }
}

export async function verifyInstalled(client, expected) {
  if (!expected.length) return;
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'");
    const { rows } = await client.query(
      `SELECT version, name, cardinality(statements)::integer AS statement_count,
              md5(statements[1]) AS sql_md5
         FROM supabase_migrations.schema_migrations WHERE version = ANY($1::text[])`,
      [expected.map((migration) => migration.version)]
    );
    assertInstalled(expected, rows);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const expected = requirements(root);
  if (!expected.length) return;
  // Keep failures credential-free: pg errors can include connection details.
  let client;
  try {
    const connection = new URL(process.env.DATABASE_URL);
    const project = 'kuklfnapbkmacvwxktbh';
    if (
      !['postgres:', 'postgresql:'].includes(connection.protocol) ||
      !(
        connection.hostname === `db.${project}.supabase.co` ||
        (connection.hostname.endsWith('.pooler.supabase.com') &&
          decodeURIComponent(connection.username) === `postgres.${project}`)
      ) ||
      connection.pathname !== '/postgres' ||
      ['sslcert', 'sslkey'].some((key) => connection.searchParams.has(key))
    ) {
      throw new Error('unproved production database');
    }
    for (const key of ['sslmode', 'ssl', 'sslrootcert']) connection.searchParams.delete(key);
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    const { Client } = require('pg');
    client = new Client({
      connectionString: connection.toString(),
      ssl: {
        rejectUnauthorized: true,
        ca: readFileSync(
          new URL('./certificates/supabase-prod-ca-2021.crt', import.meta.url),
          'utf8'
        ),
      },
      connectionTimeoutMillis: 5000,
      query_timeout: 6000,
      statement_timeout: 5000,
      application_name: 'mtt-payout-publication-readonly',
    });
    client.on('error', () => {
      process.exitCode = 1;
    });
    await client.connect();
    await verifyInstalled(client, expected);
    console.log('Both exact MTT payout migrations are installed; client publication admitted.');
  } catch {
    console.error(
      'MTT payout publication refused: database policy installation is missing or unreadable. Install and verify the two protected migrations before publishing.'
    );
    process.exitCode = 1;
  } finally {
    if (client)
      await client.end().catch(() => {
        process.exitCode = 1;
      });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
