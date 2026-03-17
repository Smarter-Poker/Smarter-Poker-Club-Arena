#!/usr/bin/env node
/**
 * Supabase SQL Migration Runner — uses supabase-js rpc
 * 
 * Strategy:
 * 1. First try to call exec_sql RPC
 * 2. If it doesn't exist, create it via raw fetch to the /sql endpoint
 * 3. Then run all migrations through it
 */
const { createClient } = require('@supabase/supabase-js');
const { readFileSync, readdirSync } = require('fs');

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs';
const DB_PASSWORD = '215SlalomCt!';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
});

async function tryExecSQL(sql) {
  const { data, error } = await supabase.rpc('exec_sql', { query: sql });
  if (!error) return { success: true, data };
  return { success: false, error: error.message };
}

async function bootstrapExecSQL() {
  console.log('Bootstrapping exec_sql function...');
  // Use the Supabase Management API to create the function
  // The ref is "kuklfnapbkmacvwxktbh"
  const ref = 'kuklfnapbkmacvwxktbh';
  const bootstrapSQL = `
    CREATE OR REPLACE FUNCTION exec_sql(query text)
    RETURNS json
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      EXECUTE query;
      RETURN json_build_object('status', 'ok');
    END;
    $$;
  `;
  
  // Try the Management API v1
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ query: bootstrapSQL }),
  });
  
  if (res.ok) {
    console.log('  ✅ exec_sql created via Management API');
    return true;
  }

  // Try connecting directly using pg module if available
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: 'aws-0-us-east-1.pooler.supabase.com',
      port: 5432,
      database: 'postgres',
      user: 'postgres.kuklfnapbkmacvwxktbh',
      password: DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });
    
    // Try direct pg connection
    const client = await pool.connect();
    console.log('  ✅ Connected via pg module');
    return { client, pool };
  } catch (pgErr) {
    console.log(`  pg module: ${pgErr.message}`);
  }

  console.log(`  Management API returned: ${res.status} - ${await res.text()}`);
  return false;
}

async function main() {
  const migrationDir = '/Users/smarter.poker/Documents/club-arena/supabase/migrations';
  const files = readdirSync(migrationDir)
    .filter(f => f.startsWith('20260317_') && f.endsWith('.sql'))
    .sort();
  
  console.log(`Found ${files.length} migrations to deploy.\n`);
  
  // Step 1: Check if exec_sql exists
  let testResult = await tryExecSQL('SELECT 1');
  let usePG = false;
  let pgClient = null;
  let pgPool = null;
  
  if (!testResult.success) {
    console.log('exec_sql not available, bootstrapping...\n');
    const result = await bootstrapExecSQL();
    if (result && result.client) {
      usePG = true;
      pgClient = result.client;
      pgPool = result.pool;
      console.log('  Using direct pg connection\n');
    } else if (result === true) {
      // Retry exec_sql
      testResult = await tryExecSQL('SELECT 1');
      if (!testResult.success) {
        console.log('❌ Cannot establish SQL execution channel');
        process.exit(1);
      }
    } else {
      console.log('❌ Cannot establish SQL execution channel');
      process.exit(1);
    }
  }
  
  let success = 0, failed = 0;
  
  for (const file of files) {
    const sql = readFileSync(`${migrationDir}/${file}`, 'utf-8');
    console.log(`\n═══ ${file} ═══`);
    
    try {
      if (usePG) {
        await pgClient.query(sql);
        console.log('  ✅ SUCCESS');
        success++;
      } else {
        const result = await tryExecSQL(sql);
        if (result.success) {
          console.log('  ✅ SUCCESS');
          success++;
        } else {
          console.log(`  ❌ ${result.error}`);
          failed++;
        }
      }
    } catch (err) {
      // Check if it's a "already exists" type error — count as success
      if (err.message && (err.message.includes('already exists') || err.message.includes('duplicate'))) {
        console.log(`  ✅ ALREADY APPLIED (${err.message.substring(0, 80)})`);
        success++;
      } else {
        console.log(`  ❌ ${err.message || err}`);
        failed++;
      }
    }
  }
  
  if (pgClient) pgClient.release();
  if (pgPool) await pgPool.end();
  
  console.log(`\n═══════════════════════════════════`);
  console.log(`Results: ${success} succeeded, ${failed} failed`);
  console.log(`═══════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
