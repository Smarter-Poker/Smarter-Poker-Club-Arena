#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ORB SQL Deploy — Supabase SQL Execution via exec_sql RPC
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Usage:
 *    node scripts/orb-sql-deploy.cjs --file supabase/migrations/XXXXXX.sql
 *    node scripts/orb-sql-deploy.cjs --query "SELECT 1"
 *    npm run db:push -- supabase/migrations/XXXXXX.sql
 *
 *  Reads credentials from:
 *    1. .env / .env.local (VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *    2. supabase/.temp/project-ref (project reference)
 *
 *  Executes SQL through the exec_sql RPC using the Supabase service role key.
 *  Falls back to direct Postgres connection if RPC is unavailable.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ─── Credential Resolution ──────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPaths = [
    path.join(ROOT, '.env'),
    path.join(ROOT, '.env.local'),
  ];
  const vars = {};
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  return vars;
}

function resolveCredentials() {
  const env = loadEnvFile();
  const tempDir = path.join(ROOT, 'supabase', '.temp');

  // Supabase URL
  const supabaseUrl =
    env.VITE_SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    '';

  // Service Role Key (bypasses RLS)
  const serviceRoleKey =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

  // DB Password (for direct PG connection fallback)
  const dbPassword =
    env.SUPABASE_DB_PASSWORD ||
    process.env.SUPABASE_DB_PASSWORD ||
    '';

  // Project ref
  let projectRef = '';
  const refPath = path.join(tempDir, 'project-ref');
  if (fs.existsSync(refPath)) {
    projectRef = fs.readFileSync(refPath, 'utf-8').trim();
  }

  if (!supabaseUrl) {
    console.error('❌ Supabase URL not found (VITE_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL)');
    process.exit(1);
  }

  if (!serviceRoleKey) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY not found in .env or .env.local');
    process.exit(1);
  }

  return { supabaseUrl, serviceRoleKey, dbPassword, projectRef };
}

// ─── Strategy 1: exec_sql RPC via Supabase JS SDK ──────────────────────────

async function executeViaRpc(sql, supabaseUrl, serviceRoleKey) {
  console.log('\n🔄 Strategy 1: exec_sql RPC via Supabase SDK...');

  const sb = createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: 'public' },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const startTime = Date.now();
  const { data, error } = await sb.rpc('exec_sql', { query: sql });
  const elapsed = Date.now() - startTime;

  if (error) {
    console.error(`   ⚠️ exec_sql RPC failed: ${error.message}`);
    return false;
  }

  console.log(`✅ SQL executed successfully via exec_sql RPC (${elapsed}ms)`);
  if (data) {
    console.log(`   Response: ${JSON.stringify(data).substring(0, 300)}`);
  }
  return true;
}

// ─── Strategy 2: Direct REST call to PostgREST ─────────────────────────────

async function executeViaRest(sql, supabaseUrl, serviceRoleKey) {
  console.log('\n🔄 Strategy 2: Direct REST call to PostgREST...');

  const startTime = Date.now();
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const elapsed = Date.now() - startTime;

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`   ⚠️ REST exec_sql failed (${resp.status}): ${text.substring(0, 200)}`);
    return false;
  }

  const data = await resp.json();
  console.log(`✅ SQL executed successfully via REST (${elapsed}ms)`);
  if (data) {
    console.log(`   Response: ${JSON.stringify(data).substring(0, 300)}`);
  }
  return true;
}

// ─── Strategy 3: Direct Postgres (if pg is installed and password available)

async function executeViaPg(sql, projectRef, dbPassword) {
  if (!dbPassword || !projectRef) {
    console.log('\n⏭️ Strategy 3: Skipped (no DB password or project ref)');
    return false;
  }

  console.log('\n🔄 Strategy 3: Direct Postgres connection...');

  let Client;
  try {
    Client = require('pg').Client;
  } catch {
    console.log('   ⏭️ pg library not installed, skipping');
    return false;
  }

  // Try session pooler first, then direct
  const configs = [
    {
      label: 'Session Pooler',
      host: `aws-0-us-west-2.pooler.supabase.com`,
      port: 5432,
      user: `postgres.${projectRef}`,
      password: dbPassword,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    },
    {
      label: 'Direct PG',
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      user: 'postgres',
      password: dbPassword,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    },
  ];

  for (const config of configs) {
    const { label, ...pgConfig } = config;
    const client = new Client(pgConfig);
    try {
      await client.connect();
      const startTime = Date.now();
      const result = await client.query(sql);
      const elapsed = Date.now() - startTime;

      console.log(`✅ SQL executed successfully via ${label} (${elapsed}ms)`);
      if (result.rowCount !== null) {
        console.log(`   Rows affected: ${result.rowCount}`);
      }
      return true;
    } catch (err) {
      console.error(`   ⚠️ ${label} failed: ${err.message}`);
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  }

  return false;
}

// ─── CLI Interface ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let sql = '';
  let sourceLabel = '';

  // --file path/to/file.sql
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = path.resolve(args[fileIdx + 1]);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    sql = fs.readFileSync(filePath, 'utf-8');
    sourceLabel = path.relative(ROOT, filePath);
  }

  // --query "SQL string"
  const queryIdx = args.indexOf('--query');
  if (queryIdx !== -1 && args[queryIdx + 1]) {
    sql = args[queryIdx + 1];
    sourceLabel = 'inline query';
  }

  // Bare argument: first arg is file path (for npm run db:push compatibility)
  if (!sql && args.length > 0 && !args[0].startsWith('--')) {
    const filePath = path.resolve(args[0]);
    if (fs.existsSync(filePath)) {
      sql = fs.readFileSync(filePath, 'utf-8');
      sourceLabel = path.relative(ROOT, filePath);
    } else {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
  }

  if (!sql) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ORB SQL Deploy — Supabase Direct SQL Execution             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Usage:                                                      ║
║    node scripts/orb-sql-deploy.cjs --file <path.sql>         ║
║    node scripts/orb-sql-deploy.cjs --query "SELECT 1"        ║
║    npm run db:push -- <path.sql>                             ║
║                                                              ║
║  Strategies (in order):                                      ║
║    1. exec_sql RPC via Supabase SDK (service role key)       ║
║    2. Direct REST call to PostgREST exec_sql                 ║
║    3. Direct Postgres connection (if pg + password avail.)   ║
║                                                              ║
║  Reads credentials from .env / .env.local                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    process.exit(0);
  }

  const { supabaseUrl, serviceRoleKey, dbPassword, projectRef } = resolveCredentials();

  console.log(`\n🚀 Deploying: ${sourceLabel} (${sql.length} bytes)`);
  console.log(`   Project: ${projectRef || 'unknown'}`);
  console.log(`   URL: ${supabaseUrl}`);

  // Try strategies in order
  let success = await executeViaRpc(sql, supabaseUrl, serviceRoleKey);

  if (!success) {
    success = await executeViaRest(sql, supabaseUrl, serviceRoleKey);
  }

  if (!success) {
    success = await executeViaPg(sql, projectRef, dbPassword);
  }

  if (success) {
    console.log(`\n🎉 Deployment complete.`);
    process.exit(0);
  } else {
    console.error(`\n❌ All strategies failed. SQL needs manual deployment.`);
    console.error(`   File: ${sourceLabel}`);
    console.error(`   Fallback: Paste the SQL into the Supabase Dashboard SQL Editor.`);
    process.exit(1);
  }
}

main();
