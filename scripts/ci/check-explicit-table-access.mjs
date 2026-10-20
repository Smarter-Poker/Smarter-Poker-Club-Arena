#!/usr/bin/env node
// New public tables must declare their complete access boundary. Supabase stops
// supplying implicit table/sequence grants on October 30, 2026.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Keep identifiers and SQL syntax, masking comments, strings and function/DO
// bodies. Anonymous DO declarations are checked; uncalled stored functions
// cannot supply permissions for a top-level table.
export function sqlSyntax(sql) {
  let out = '', i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; out += ' ';
    } else if (rest.startsWith('/*')) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      out += ' ';
    } else if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i++] === "'") break;
      }
      out += ' ';
    } else if (sql[i] === '$' && /^\$(?:[a-z_][\w]*)?\$/i.test(rest)) {
      const tag = rest.match(/^\$(?:[a-z_][\w]*)?\$/i)[0];
      const end = sql.indexOf(tag, i + tag.length);
      const prefix = out.slice(out.lastIndexOf(';') + 1);
      const body = sql.slice(i + tag.length, end < 0 ? sql.length : end);
      out += /^\s*DO\b/i.test(prefix) ? ' ' + sqlSyntax(body) + ' ' : ' ';
      i = end < 0 ? sql.length : end + tag.length;
    } else { out += sql[i++]; }
  }
  return out;
}
const ident = '(?:"(?:[^"]|"")+"|[a-z_][\\w$]*)';
const relation = `${ident}(?:\\s*\\.\\s*${ident})?`;
function name(value) {
  const parts = value.match(/"(?:[^"]|"")+"|[a-z_][\w$]*/gi)
    .map(part => part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase());
  return parts.length === 1 ? ['public', parts[0]] : parts;
}
function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }

export function auditMigration(sql) {
  const syntax = sqlSyntax(sql), issues = [];
  const creates = [...syntax.matchAll(new RegExp(`\\bCREATE\\s+(?:(TEMP(?:ORARY)?|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${relation})`, 'gi'))]
    .filter(m => !/^temp/i.test(m[1] || ''))
    .map(m => name(m[2])).filter(parts => parts[0] === 'public');
  for (const table of creates) {
    const label = table.join('.');
    const revokes = [...syntax.matchAll(/\bREVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?([^;]+?)\s+FROM\s+([^;]+);/gi)];
    const revoked = new Set();
    for (const revoke of revokes) {
      if (revoke[1].split(',').some(item => same(name(item.trim()), table))) {
        for (const role of revoke[2].split(',')) revoked.add(role.trim().replaceAll('"', '').toLowerCase());
      }
    }
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      if (!revoked.has(role)) issues.push(`${label}: explicitly REVOKE ALL from ${role}, then grant only required operations`);
    }
    const enabled = [...syntax.matchAll(new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${relation})\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'gi'))]
      .some(m => same(name(m[1]), table));
    if (!enabled) issues.push(`${label}: enable row level security in the creation migration`);
  }
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] || process.env.TABLE_ACCESS_BASE || 'origin/main';
  const paths = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', 'supabase/migrations'], { encoding: 'utf8' })
    .trim().split('\n').filter(path => path.endsWith('.sql'));
  let failures = 0;
  for (const path of paths) {
    const issues = auditMigration(readFileSync(path, 'utf8'));
    for (const issue of issues) { console.error(`${path}: ${issue}`); failures++; }
  }
  console.log(`Explicit table access: ${paths.length} changed migration(s), ${failures} finding(s).`);
  process.exitCode = failures ? 1 : 0;
}
