import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const root = path.resolve(import.meta.dirname, '../../..');
const read = name => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, name), 'utf8'));
const q = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export function fixtureSql() {
  const enums = read('terminal-enums.json');
  const schema = [...new Map([...read('terminal-schema.json'),...read('terminal-schema-extra.json'),...read('terminal-schema-refunds.json'),...read('terminal-schema-cashier.json')].map(t => [t.schema+'.'+t.name,t])).values()];
  const sources = ['catalog','second','third','fourth','fifth','sixth','seventh','eighth'].flatMap(suffix => read(`terminal-dependency-${suffix}.json`));
  const constraints = read('terminal-constraints.json');
  const generated = read('terminal-generated.json');
  let sql = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; SET check_function_bodies=off;\n`;
  sql += enums.map(e => `CREATE TYPE public.${q(e.name)} AS ENUM (${e.labels.map(literal).join(',')});`).join('\n') + '\n';
  // Catalog column shapes are synthetic opening state. Preserve owner types,
  // defaults and keys; external unrelated triggers/FKs are not silently mocked.
  for (const table of schema) {
    sql += `CREATE TABLE ${q(table.schema)}.${q(table.name)} (`;
    sql += table.columns.map(column => {
      const serial = column.default?.startsWith('nextval(');
      const type = serial ? (column.type === 'bigint' ? 'bigserial' : 'serial') : column.type.startsWith('auth.') ? 'text' : column.type;
      const isGenerated = generated.some(c => c.table_name === table.name && c.column_name === column.name);
      const defaultValue = column.default?.replaceAll('uuid_generate_v4()', 'gen_random_uuid()');
      const value = isGenerated ? ` GENERATED ALWAYS AS (${column.default}) STORED` : defaultValue && !serial && !/(public|smarter_private)\.|\bfn_/.test(defaultValue) ? ` DEFAULT ${defaultValue}` : '';
      return `${q(column.name)} ${type}${value}`;
    }).join(',') + ');\n';
    sql += constraints.filter(c => c.schema === table.schema && c.table_name === table.name && ['p','u'].includes(c.type)).map(c => `ALTER TABLE ${q(table.schema)}.${q(table.name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`).join('\n') + '\n';
  }
  sql += sources.map(s => `${s.definition};`).join('\n') + '\n';
  sql += read('terminal-refund-extra-functions.json').map(s=>s.definition+';').join('\n')+'\n';
  sql += read('terminal-cashier-owners.json').map(s=>s.definition+';').join('\n')+'\n';
  sql += read('terminal-funded-owners.json').map(s=>s.definition+';').join('\n')+'\n';
  sql += read('terminal-refund-owners.json').map(s=>s.definition+';').join('\n')+'\n';
  sql += read('terminal-fundowners.json').filter(s => ['fn_ca_fund_club','fn_bank_standalone_week_rake'].includes(s.proname)).map(s => s.definition+';').join('\n')+'\n';
  sql += 'CREATE TABLE ca_financial_epochs(id integer PRIMARY KEY,is_current boolean); INSERT INTO ca_financial_epochs VALUES(1,true); CREATE SEQUENCE chip_ledger_chain_seq;\n';
  sql += 'CREATE TABLE merchandise_order_events(id uuid DEFAULT gen_random_uuid(),order_id uuid,actor_id uuid,action text,from_status text,to_status text,details jsonb);\n';
  sql += 'CREATE UNIQUE INDEX qualification_agent_user_club ON agents(user_id,club_id);\n';
  sql += 'CREATE UNIQUE INDEX qualification_counter_year ON accounting_invoice_counters(year);\n';
  sql += 'CREATE UNIQUE INDEX qualification_notice_key ON ca_commerce_notices(dedupe_key);\n';
  sql += read('terminal-indexes.json').map(index => index.definition+';').join('\n')+'\n';
  sql += constraints.filter(c => c.type === 'c' && schema.some(t => t.schema === c.schema && t.name === c.table_name)).map(c => `ALTER TABLE ${q(c.schema)}.${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`).join('\n') + '\n';
  sql += `CREATE FUNCTION qualification_assert(condition boolean,message text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',message; END IF; END $$;\n`;
  return sql;
}
export function refundTriggersSql() {
  const selected = ['trg_club_members_audit_chip_movement','trg_ca_chip_ledger_enrich','zz_chip_ledger_key_is_claimed_once','zz_ca_escrow_wallet_tx','trg_ca_money_path_log','tournament_cancellation_receipts_append_only','trg_ca_diamond_register_follows_journal'];
  const triggers = read('terminal-triggers.json').filter(t => selected.includes(t.name));
  if (triggers.length !== selected.length) throw Error('exact refund trigger source is incomplete');
  triggers.push(...read('terminal-club-trigger.json'),...read('terminal-cashier-triggers.json')); 
  return [...new Map(triggers.map(t => [t.function_name,t.function_definition])).values()].map(s => s+';').join('\n')+'\n'+triggers.map(t => t.definition+';').join('\n');
}
export function migrationSql() {
  return ['20261010035655_stable_admin_emergency_stops.sql','20261010035918_stable_admin_cancel_uses_receipted_authority.sql'].map(file => fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8')).join('\n');
}
export function sourceHashes() {
  const paths = fs.readdirSync(import.meta.dirname).filter(f => /\.(json|sql|mjs)$/.test(f));
  const hashes = Object.fromEntries(paths.map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(import.meta.dirname,file))).digest('hex')]));
  for (const file of ['supabase/migrations/20261010035655_stable_admin_emergency_stops.sql','supabase/migrations/20261010035918_stable_admin_cancel_uses_receipted_authority.sql','scripts/qualify-stable-admin-cancel-stops-pg17.mjs']) hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  return hashes;
}
