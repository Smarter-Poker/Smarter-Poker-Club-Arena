#!/usr/bin/env node

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { Client } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = 'aws-0-us-west-2.pooler.supabase.com';
const DEFAULT_USER = 'postgres.kuklfnapbkmacvwxktbh';

export function readPsqlFreeContract(path = resolve(HERE, 'cashier-release-contract.sql')) {
  const source = readFileSync(path, 'utf8');
  const unsupported = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('\\') && line !== '\\set ON_ERROR_STOP on');
  if (unsupported.length) {
    throw new Error(`Cashier release contract contains unsupported psql commands: ${unsupported}`);
  }
  return source
    .split('\n')
    .filter((line) => line.trim() !== '\\set ON_ERROR_STOP on')
    .join('\n');
}

export function databaseConfig(environment = process.env) {
  if (environment.SUPABASE_DB_URL) {
    return {
      connectionString: environment.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8_000,
      query_timeout: 90_000,
    };
  }

  if (!environment.SUPABASE_DB_PASSWORD) {
    throw new Error('SUPABASE_DB_PASSWORD or SUPABASE_DB_URL is required.');
  }
  return {
    host: environment.SUPABASE_DB_HOST || DEFAULT_HOST,
    port: Number(environment.SUPABASE_DB_PORT || 6543),
    database: environment.SUPABASE_DB_NAME || 'postgres',
    user: environment.SUPABASE_DB_USER || DEFAULT_USER,
    password: environment.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8_000,
    query_timeout: 90_000,
  };
}

export async function certifyCashierContract({
  environment = process.env,
  ClientClass = Client,
} = {}) {
  const client = new ClientClass(databaseConfig(environment));
  await client.connect();
  try {
    await client.query(readPsqlFreeContract());
    console.log('[cashier-contract] versions, hashes, ACLs, RLS, triggers and indexes verified.');

    const fixture = await client.query(`
      SELECT cm.user_id::text AS user_id, cm.club_id::text AS club_id
      FROM public.club_members cm
      JOIN auth.users u ON u.id = cm.user_id
      JOIN public.clubs c ON c.id = cm.club_id
      WHERE coalesce(cm.status, 'active') IN ('active', 'approved')
      ORDER BY cm.joined_at NULLS LAST, cm.user_id
      LIMIT 1
    `);
    const canary = fixture.rows[0];
    if (!canary?.user_id || !canary?.club_id) {
      throw new Error('Cashier telemetry RLS has no active production membership fixture.');
    }

    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [canary.user_id]);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: canary.user_id, role: 'authenticated' }),
      ]);
      await client.query(
        `INSERT INTO public.cashier_operations (
          user_id, club_id, event, operation, duration_ms, item_count, page_number, sample_weight
        ) VALUES ($1::uuid, $2::uuid, 'roster_page_succeeded', 'roster', 1, 0, 0, 10)`,
        [canary.user_id, canary.club_id]
      );
    } finally {
      await client.query('ROLLBACK');
    }
    console.log('[cashier-contract] authenticated telemetry insert verified and rolled back.');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  certifyCashierContract().catch((error) => {
    console.error(`[cashier-contract] FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
