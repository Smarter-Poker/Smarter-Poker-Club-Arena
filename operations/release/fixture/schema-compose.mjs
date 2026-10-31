import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const schemaHash = (value) => createHash('sha256').update(value).digest('hex');
export const MANAGED_SCHEMAS = Object.freeze(['auth', 'realtime', '_realtime', 'cron', 'extensions']);
const refused = () => { throw new Error('SCHEMA_COMPOSITION_PREIMAGE_REQUIRED'); };
const managedObject = (item) => MANAGED_SCHEMAS.includes(item.schema) ||
  (item.type === 'SCHEMA' && [...MANAGED_SCHEMAS, 'public'].includes(item.name)) ||
  (item.type === 'ACL' && [...MANAGED_SCHEMAS, 'public'].some((name) => item.name === `SCHEMA ${name}`)) ||
  item.type === 'EXTENSION' || (item.type === 'COMMENT' && item.name.startsWith('EXTENSION '));

// pg_dump object headers are recognized ONLY outside SQL strings, dollar
// bodies and block comments. A function body cannot invent an object boundary.
export function dumpObjects(sql) {
  assert.equal(typeof sql, 'string');
  assert.ok(Buffer.byteLength(sql) > 0 && Buffer.byteLength(sql) <= 128 * 1024 * 1024);
  const starts = [];
  let quote = null, quoteEscapes = false, dollar = null, block = 0, line = false, footerAt = sql.length;
  for (let i = 0; i < sql.length; i++) {
    if (line) { if (sql[i] === '\n') line = false; continue; }
    if (block) {
      if (sql.startsWith('/*', i)) { block++; i++; }
      else if (sql.startsWith('*/', i)) { block--; i++; }
      continue;
    }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; } continue; }
    if (quote) {
      if (sql[i] === quote) { if (sql[i + 1] === quote) i++; else quote = null; }
      else if (quoteEscapes && sql[i] === '\\') i++;
      continue;
    }
    if ((i === 0 || sql[i - 1] === '\n') && sql.startsWith('-- Name: ', i)) starts.push(i);
    if ((i === 0 || sql[i - 1] === '\n') && sql.startsWith('-- PostgreSQL database dump complete', i)) footerAt = Math.min(footerAt, i);
    if (sql.startsWith('--', i)) { line = true; i++; }
    else if (sql.startsWith('/*', i)) { block = 1; i++; }
    else if (sql[i] === "'" || sql[i] === '"') {
      quote = sql[i];
      quoteEscapes = quote === "'" && i > 0 && /[eE]/.test(sql[i - 1]) &&
        (i === 1 || !/[A-Za-z_0-9$]/.test(sql[i - 2]));
    }
    else if (sql[i] === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (match) { dollar = match[0]; i += dollar.length - 1; }
    }
  }
  if (quote || dollar || block || starts.length === 0) refused();
  const objects = starts.map((start, index) => {
    const end = starts[index + 1] ?? footerAt;
    const text = sql.slice(start, end);
    const header = /^-- Name: ([^\n]+); Type: ([A-Z ]+); Schema: ([a-z_][a-z_0-9]*|-); Owner: ([a-z_][a-z_0-9]*|-)\r?\n/.exec(text);
    if (!header) refused();
    const [, name, type, schema, owner] = header;
    // Names containing header delimiters cannot be given an ambiguous identity.
    if (name.includes('; Type:') || name.length > 4096) refused();
    // Default privileges belong to their creator role. pg_dump uses the same
    // display name for different creators in one schema; they are not one ACL.
    const key = JSON.stringify(type === 'DEFAULT ACL' ? [type, schema, name, owner] : [type, schema, name]);
    return { key, type, schema, name, owner, start, end, text, sha256: schemaHash(text) };
  });
  if (new Set(objects.map((item) => item.key)).size !== objects.length) refused();
  return { prefix: sql.slice(0, starts[0]), footer: sql.slice(footerAt), objects };
}

export function assertSchemaOnly(sql) {
  // No raw refusal contents are reported. Credential-bearing metadata is not
  // a safe schema artifact, even when it happens to be inside a SQL body.
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:postgres(?:ql)?|https?):\/\/[^\s'"/]+:[^\s'"@]+@|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(sql)) refused();
  const parsed = dumpObjects(sql);
  const deniedTypes = new Set(['TABLE DATA', 'SEQUENCE SET', 'BLOB', 'BLOBS', 'LARGE OBJECT', 'FOREIGN SERVER', 'SERVER', 'USER MAPPING', 'SUBSCRIPTION']);
  for (const item of parsed.objects) if (deniedTypes.has(item.type)) refused();
  return parsed;
}

// The caller obtains serviceDump from a separate genuine native bootstrap,
// before application restoration. No caller-supplied whitelist, replacement
// definition, schema exclusion, role promotion or readiness flag is accepted.
export function composeSchema(capture, serviceDump) {
  const original = assertSchemaOnly(capture);
  const service = assertSchemaOnly(serviceDump);
  const native = new Map(service.objects.map((item) => [item.key, item]));
  const source = new Map(original.objects.map((item) => [item.key, item]));
  // Extra native managed objects are drift too. They must not silently remain
  // in the restored application while only one direction was compared.
  for (const item of service.objects) {
    const expected = source.get(item.key);
    if (!expected || expected.owner !== item.owner || expected.sha256 !== item.sha256) refused();
  }
  const removed = [], retained = [];
  let sql = original.prefix;
  for (const item of original.objects) {
    const managed = managedObject(item) || native.has(item.key);
    if (managed) {
      const expected = native.get(item.key);
      if (!expected || expected.owner !== item.owner || expected.sha256 !== item.sha256) refused();
      removed.push({ key: item.key, sha256: item.sha256 });
    } else {
      sql += item.text;
      retained.push({ key: item.key, sha256: item.sha256 });
    }
  }
  // A whole managed namespace may never disappear because of an empty or
  // unrelated bootstrap. Exact Auth helper and cron contracts must be present.
  for (const name of ['email()', 'jwt()', 'role()', 'uid()'])
    if (!original.objects.some((item) => item.schema === 'auth' && item.type === 'FUNCTION' && item.name === name)) refused();
  if (original.objects.filter((item) => item.schema === 'cron' && item.type === 'FUNCTION').length < 3 || removed.length < 7) refused();
  return {
    sql: sql + original.footer,
    manifest: { version: 1, scope: 'exact-native-service-schema-composition',
      original_sha256: schemaHash(capture), native_preimage_sha256: schemaHash(serviceDump),
      composed_sha256: schemaHash(sql + original.footer), removed, retained,
      current_database_contract_ready: false, reason: 'native-restore-and-catalogue-parity-not-yet-observed' },
  };
}
