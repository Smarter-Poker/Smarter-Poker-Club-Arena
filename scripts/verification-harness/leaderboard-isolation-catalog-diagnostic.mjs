#!/usr/bin/env node
// Diagnostic only. Never replaces the owning exact-byte catalog comparison.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 64 * 1024 * 1024;
// [row width, leading identity fields]; all names come from the maintained SQL.
const SECTIONS = Object.freeze({
  database: [11, 1],
  database_settings: [2, 1],
  sql_settings: [2, 1],
  tablespaces: [4, 1],
  extensions: [4, 1],
  roles: [11, 1],
  memberships: [6, 3],
  schemas: [3, 1],
  relations: [10, 2],
  columns: [10, 3],
  routines: [9, 3],
  constraints: [6, 3],
  domain_constraints: [6, 3],
  indexes: [5, 3],
  triggers: [5, 3],
  event_triggers: [8, 1],
  publications: [8, 1],
  publication_relations: [5, 3],
  publication_schemas: [2, 2],
  policies: [8, 3],
  types: [9, 2],
  defaults: [4, 3],
});
const BOOLEAN_FIELDS = Object.freeze({
  roles: [1, 2, 3, 4, 5, 6, 7],
  memberships: [3, 4, 5],
  relations: [4, 5],
  columns: [5],
  routines: [5],
  constraints: [5],
  domain_constraints: [5],
  indexes: [3, 4],
  publications: [2, 3, 4, 5, 6, 7],
  types: [5],
});
const unknown = () => {
  throw new Error('CATALOG_DIAGNOSTIC_UNKNOWN');
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readPrivate(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) unknown();
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count !== stat.size) unknown();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch {
    unknown();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCatalog(text) {
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch {
    unknown();
  }
  if (!catalog || Array.isArray(catalog) || typeof catalog !== 'object') unknown();
  // JSON.parse overwrites duplicate keys. Read top-level key tokens separately,
  // skipping complete JSON strings so braces/colons inside secrets cannot fool it.
  let depth = 0;
  const keys = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      const start = i;
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next += 1;
      if (depth === 1 && text[next] === ':') keys.push(JSON.parse(text.slice(start, i + 1)));
    } else if (text[i] === '{' || text[i] === '[') depth += 1;
    else if (text[i] === '}' || text[i] === ']') depth -= 1;
  }
  if (
    keys.length !== Object.keys(SECTIONS).length ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !Object.hasOwn(SECTIONS, key))
  )
    unknown();
  return catalog;
}

function validField(value, depth = 0) {
  if (depth > 4) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.every((entry) => validField(entry, depth + 1));
}

function indexSection(name, value) {
  const [width, identityWidth] = SECTIONS[name];
  let kind;
  let rows;
  if (name === 'database') {
    if (!Array.isArray(value) || value.length !== width) unknown();
    kind = 'singleton';
    rows = [value];
  } else if (value === null) {
    kind = 'null';
    rows = [];
  } else if (Array.isArray(value)) {
    kind = 'rows';
    rows = value;
  } else unknown();
  const indexed = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width || !row.every((field) => validField(field)))
      unknown();
    if ((BOOLEAN_FIELDS[name] ?? []).some((index) => typeof row[index] !== 'boolean')) unknown();
    const identity = row.slice(0, identityWidth);
    // Only database-role settings and global default privileges have nullable
    // identity components. No scalar coercion or ambiguous duplicate pairing.
    if (
      identity.some(
        (key) =>
          typeof key !== 'string' &&
          !(key === null && (name === 'database_settings' || name === 'defaults'))
      )
    )
      unknown();
    const key = JSON.stringify(identity);
    if (indexed.has(key)) unknown();
    indexed.set(key, row);
  }
  return { kind, indexed };
}

export function diagnoseCatalog(sourceText, destinationText) {
  // Both documents validate completely before any diagnostic is returned.
  const source = parseCatalog(sourceText);
  const destination = parseCatalog(destinationText);
  const sections = [];
  for (const name of Object.keys(SECTIONS)) {
    const left = indexSection(name, source[name]);
    const right = indexSection(name, destination[name]);
    const fieldCounts = Array(SECTIONS[name][0]).fill(0);
    let matched = 0;
    let changedRows = 0;
    for (const [key, row] of left.indexed) {
      const other = right.indexed.get(key);
      if (!other) continue;
      matched += 1;
      let changed = false;
      for (let index = 0; index < row.length; index += 1) {
        if (JSON.stringify(row[index]) !== JSON.stringify(other[index])) {
          fieldCounts[index] += 1;
          changed = true;
        }
      }
      if (changed) changedRows += 1;
    }
    sections.push({
      section: name,
      source_kind: left.kind,
      destination_kind: right.kind,
      source_count: left.indexed.size,
      destination_count: right.indexed.size,
      source_hash: hash(source[name]),
      destination_hash: hash(destination[name]),
      matched_identities: matched,
      removed_identities: left.indexed.size - matched,
      added_identities: right.indexed.size - matched,
      changed_rows: changedRows,
      changed_field_indices: fieldCounts.flatMap((count, index) =>
        count ? [{ index, count }] : []
      ),
    });
  }
  return { diagnostic: 'catalog-section-difference', field_index_base: 0, sections };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) unknown();
    process.stdout.write(
      `${JSON.stringify(diagnoseCatalog(readPrivate(process.argv[2]), readPrivate(process.argv[3])))}\n`
    );
  } catch {
    process.stderr.write('CATALOG_DIAGNOSTIC_UNKNOWN\n');
    process.exitCode = 1;
  }
}
