import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';

// Fixed catalog observation only. No caller-supplied SQL and no production writes.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true, ca: await (await import('node:fs/promises')).readFile('scripts/ci/certificates/supabase-prod-ca-2021.crt', 'utf8') } });
try {
  if (!process.env.DATABASE_URL) throw new Error('Configured DATABASE_URL is required');
  await client.connect();
  await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout='8s'");
  const functions = await client.query(`SELECT n.nspname AS schema, p.proname AS name,
    p.oid::regprocedure::text AS signature, md5(pg_get_functiondef(p.oid)) AS md5,
    pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','smarter_private') AND p.prokind='f' AND
    (p.proname IN ('fn_agent_wallet_send_core_20260830','transfer_chips_agent_to_player',
     'fn_generate_credit_invoice','fn_generate_all_credit_invoices','fn_generate_scope_credit_invoices',
     'fn_process_weekly_accounting','fn_union_settlement_cascade','fn_run_weekly_settlement',
     'fn_apply_credit_payment','fn_process_credit_invoice_payment','fn_pay_credit_invoice_from_wallet')
     OR p.proname LIKE '%weekly%rakeback%' OR p.proname LIKE '%weekly%commission%')
    ORDER BY n.nspname,p.proname,p.oid`);
  const migrations = await client.query(`SELECT version,name FROM supabase_migrations.schema_migrations
    WHERE name ILIKE '%credit%' OR name ILIKE '%weekly%' ORDER BY version`);
  await client.query('ROLLBACK');
  await mkdir('artifacts/credit-tracking', {recursive:true});
  await writeFile('artifacts/credit-tracking/catalog.json', JSON.stringify({observedAt:new Date().toISOString(),functions:functions.rows,migrations:migrations.rows},null,2));
  console.log(`Read ${functions.rows.length} function definitions; no production writes`);
} finally { await client.end(); }
