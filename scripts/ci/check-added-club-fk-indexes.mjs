#!/usr/bin/env node
/**
 * CI GATE - a foreign key into clubs is not merged without its index.
 *
 * Deleting a club makes PostgreSQL check every foreign key that points at
 * public.clubs, and a key with no usable index is a sequential scan of the
 * child table. scripts/ci/check-club-fk-indexes.mjs asks production that
 * question, but only AFTER deploy: pull-request CI holds no production
 * credentials. So 20260926140858 merged with two unindexed club_id keys
 * (accounting_legacy_rakeback_certificates, accounting_legacy_settlement_legs),
 * and every post-deploy certificate failed from 09:41Z on 2026-10-02 until
 * 20261002150335 added the indexes.
 *
 * This gate asks the same question of the migration files a branch ADDS,
 * before merge: every single-column foreign key into public.clubs they create
 * needs a full (non-partial) index that LEADS on the referencing column,
 * created in those added files or in a migration already in the repository.
 * A partial index cannot answer the key check, because the check must find
 * the rows the predicate hides; an index that only contains the column later
 * cannot either.
 *
 * Deliberately the half that cannot fail falsely. Production has foreign keys
 * that no file in this repository creates, so a DROP INDEX, a rename or a
 * dropped column cannot be judged from here; those stay with the post-deploy
 * check. Dynamic SQL (EXECUTE '...') and function bodies are not read.
 *
 * Usage:
 *   node scripts/ci/check-added-club-fk-indexes.mjs [baseRef]
 * Exit: 0 clean, 1 an added key has no index, 2 could not read the diff.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIR = 'supabase/migrations';
const PARENT = 'public.clubs';
const TAG = '[added-club-fk-indexes]';

// ── SQL text: comments out, string contents blanked, function bodies blanked,
//    DO-block bodies kept, because a DO block runs when the migration runs.
export function executableText(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '"') {
      const s = i++;
      while (i < sql.length) {
        if (sql[i++] !== '"') continue;
        if (sql[i] === '"') i++;
        else break;
      }
      out += sql.slice(s, i);
    } else if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (sql.startsWith('/*', i)) depth++;
        else if (sql.startsWith('*/', i)) depth--;
        else {
          i++;
          continue;
        }
        i += 2;
      } while (depth > 0 && i < sql.length);
      out += ' ';
    } else if (c === "'") {
      const escaped = /[eE]/.test(sql[i - 1] ?? '') && !/[a-z0-9_$]/i.test(sql[i - 2] ?? '');
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') i += 2;
        else if (sql[i++] === "'") {
          if (sql[i] === "'") i++;
          else break;
        }
      }
      out += "''";
    } else if (
      c === '$' &&
      !/[a-z0-9_$]/i.test(sql[i - 1] ?? '') &&
      /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i, i + 64))
    ) {
      const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i, i + 64))[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error(`unterminated ${tag} quote`);
      const body = sql.slice(i + tag.length, end);
      out += /\bdo\s*(?:language\s+\w+\s*)?$/i.test(out) ? ` ${executableText(body)} ` : ' $body$ ';
      i = end + tag.length;
    } else out += sql[i++];
  }
  return out;
}

// ── identifiers and parentheses ─────────────────────────────────────────────
const ID = '(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)';
const QN = `(${ID}(?:\\s*\\.\\s*${ID})?)`;
const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase());
const qualify = (q) => {
  const parts = q.match(new RegExp(ID, 'gi')).map(unquote);
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
};
const schemaOf = (table) => table.split('.')[0];
const bare = (table) => table.split('.')[1];
const pgName = (s) => s.slice(0, 63);

function closing(s, open) {
  let depth = 0;
  let quoted = false;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '"') quoted = !quoted;
    else if (!quoted && s[j] === '(') depth++;
    else if (!quoted && s[j] === ')' && --depth === 0) return j;
  }
  return s.length;
}
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '(') depth++;
    if (!quoted && c === ')') depth--;
    if (!quoted && depth === 0 && c === ',') {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  return cur.trim() ? [...parts, cur] : parts;
}
/** The column an index element list leads on, or null when it leads on an expression. */
function leadingColumn(elements) {
  const first = splitTop(elements)[0]?.trim() ?? '';
  const m = new RegExp(`^(?:(${ID})(?=\\s|$)|\\(\\s*(${ID})\\s*\\)(?=\\s|$))`, 'i').exec(first);
  return m ? unquote(m[1] ?? m[2]) : null;
}

// ── the schema as far as the repository can see it ──────────────────────────
class Schema {
  tables = new Set();
  indexes = new Map(); // schema.name -> { table, lead, partial }
  keys = []; // foreign keys into PARENT that the added files create
  added = null; // the file being applied, when it is an added one

  index(table, name, lead, partial) {
    this.indexes.set(name.includes('.') ? name : `${schemaOf(table)}.${name}`, {
      table,
      lead,
      partial,
    });
  }
  key(table, column, name) {
    if (this.added)
      this.keys.push({
        table,
        column,
        name: name ?? pgName(`${bare(table)}_${column}_fkey`),
        file: this.added,
      });
  }
  covered({ table, column }) {
    for (const ix of this.indexes.values())
      if (ix.table === table && ix.lead === column && !ix.partial) return true;
    return false;
  }

  column(table, def) {
    const m = new RegExp(`^\\s*(${ID})\\s+`, 'i').exec(def);
    if (!m || /^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(m[1])) return;
    const column = unquote(m[1]);
    const rest = def.slice(m[0].length);
    const named = (kind) => new RegExp(`\\bconstraint\\s+(${ID})\\s+${kind}`, 'i').exec(rest)?.[1];
    const ref = new RegExp(`\\breferences\\s+${QN}`, 'i').exec(rest);
    if (ref && qualify(ref[1]) === PARENT)
      this.key(table, column, named('references') && unquote(named('references')));
    if (/\bprimary\s+key\b/i.test(rest))
      this.index(
        table,
        named('primary') ? unquote(named('primary')) : pgName(`${bare(table)}_pkey`),
        column,
        false
      );
    if (/\bunique\b/i.test(rest))
      this.index(
        table,
        named('unique') ? unquote(named('unique')) : pgName(`${bare(table)}_${column}_key`),
        column,
        false
      );
  }
  constraint(table, def) {
    const m = new RegExp(
      `^\\s*(?:constraint\\s+(${ID})\\s+)?(primary\\s+key|unique|foreign\\s+key|exclude|check)\\b`,
      'i'
    ).exec(def);
    if (!m) return false;
    const name = m[1] && unquote(m[1]);
    const kind = m[2].toLowerCase().split(/\s/)[0];
    const rest = def.slice(m[0].length);
    const usingIndex = new RegExp(`^\\s*using\\s+index\\s+(${ID})`, 'i').exec(rest);
    if (usingIndex) {
      const old = `${schemaOf(table)}.${unquote(usingIndex[1])}`;
      const ix = this.indexes.get(old);
      if (ix && name) {
        this.indexes.delete(old);
        this.index(table, name, ix.lead, ix.partial);
      }
      return true;
    }
    const open = rest.indexOf('(');
    if (kind === 'check' || open < 0) return true;
    const cols = rest.slice(open + 1, closing(rest, open));
    const tail = rest.slice(closing(rest, open) + 1);
    if (kind === 'foreign') {
      const ref = new RegExp(`\\breferences\\s+${QN}`, 'i').exec(tail);
      if (ref && qualify(ref[1]) === PARENT && splitTop(cols).length === 1)
        this.key(table, leadingColumn(cols), name);
    } else {
      const suffix = kind === 'primary' ? 'pkey' : kind === 'unique' ? 'key' : 'excl';
      const fallback =
        kind === 'primary'
          ? `${bare(table)}_pkey`
          : `${bare(table)}_${splitTop(cols).map(leadingColumn).join('_')}_${suffix}`;
      this.index(table, name ?? pgName(fallback), leadingColumn(cols), /\bwhere\s*\(/i.test(tail));
    }
    return true;
  }

  statement(text) {
    // A DO block reaches DDL after BEGIN, THEN, ELSE or LOOP; plain SQL starts with it.
    const start = /(?:^|\b(?:then|else|begin|loop)\b)\s*(?=(?:create|alter|drop)\b)/i.exec(text);
    if (!start) return;
    const s = text.slice(start.index + start[0].length);
    let m;
    if (
      (m = new RegExp(
        `^create\\s+(?:(?:global|local)\\s+)?(temp\\s+|temporary\\s+|unlogged\\s+)?table\\s+(if\\s+not\\s+exists\\s+)?${QN}\\s*\\(`,
        'i'
      ).exec(s))
    ) {
      const table = qualify(m[3]);
      if (/^t/i.test(m[1] ?? '') || table.startsWith('pg_temp.')) return;
      if (m[2] && this.tables.has(table)) return; // IF NOT EXISTS on a table that exists does nothing
      this.tables.add(table);
      const open = m[0].length - 1;
      for (const def of splitTop(s.slice(open + 1, closing(s, open))))
        if (!this.constraint(table, def)) this.column(table, def);
    } else if (
      (m = new RegExp(
        `^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(if\\s+not\\s+exists\\s+)?(?:(${ID})\\s+)?on\\s+(?:only\\s+)?${QN}\\s*(?:using\\s+\\w+\\s*)?\\(`,
        'i'
      ).exec(s))
    ) {
      const table = qualify(m[3]);
      const name = m[2]
        ? `${schemaOf(table)}.${unquote(m[2])}`
        : `${table}#unnamed${this.indexes.size}`;
      if (m[1] && this.indexes.has(name)) return;
      const open = m[0].length - 1;
      const close = closing(s, open);
      this.index(
        table,
        name,
        leadingColumn(s.slice(open + 1, close)),
        /\bwhere\b/i.test(s.slice(close + 1))
      );
    } else if ((m = /^drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(.*)$/is.exec(s))) {
      for (const n of splitTop(m[1].replace(/\b(cascade|restrict)\b/gi, '')))
        if (n.trim()) this.indexes.delete(qualify(n.trim()));
    } else if (
      (m = new RegExp(
        `^alter\\s+index\\s+(?:if\\s+exists\\s+)?${QN}\\s+rename\\s+to\\s+(${ID})`,
        'i'
      ).exec(s))
    ) {
      const old = qualify(m[1]);
      const ix = this.indexes.get(old);
      if (ix) {
        this.indexes.delete(old);
        this.indexes.set(`${schemaOf(old)}.${unquote(m[2])}`, ix);
      }
    } else if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?(.*)$/is.exec(s))) {
      for (const n of splitTop(m[1].replace(/\b(cascade|restrict)\b/gi, '')))
        if (n.trim()) this.dropTable(qualify(n.trim()));
    } else if (
      (m = new RegExp(
        `^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QN}\\s*\\*?\\s*`,
        'i'
      ).exec(s))
    ) {
      this.alterTable(qualify(m[1]), s.slice(m[0].length));
    }
  }
  alterTable(table, rest) {
    let m;
    if ((m = new RegExp(`^rename\\s+to\\s+(${ID})`, 'i').exec(rest)))
      return this.renameTable(table, `${schemaOf(table)}.${unquote(m[1])}`);
    if (/^rename\s+constraint\b/i.test(rest)) return;
    if ((m = new RegExp(`^rename\\s+(?:column\\s+)?(${ID})\\s+to\\s+(${ID})`, 'i').exec(rest))) {
      const [from, to] = [unquote(m[1]), unquote(m[2])];
      for (const ix of this.indexes.values())
        if (ix.table === table && ix.lead === from) ix.lead = to;
      for (const k of this.keys) if (k.table === table && k.column === from) k.column = to;
      return;
    }
    for (const action of splitTop(rest).map((a) => a.trim())) {
      if (
        (m = new RegExp(`^drop\\s+constraint\\s+(?:if\\s+exists\\s+)?(${ID})`, 'i').exec(action))
      ) {
        const name = unquote(m[1]);
        this.indexes.delete(`${schemaOf(table)}.${name}`);
        this.keys = this.keys.filter((k) => !(k.table === table && k.name === name));
      } else if (
        (m = new RegExp(`^drop\\s+(?:column\\s+)?(?:if\\s+exists\\s+)?(${ID})`, 'i').exec(action))
      ) {
        const column = unquote(m[1]);
        for (const [n, ix] of this.indexes)
          if (ix.table === table && ix.lead === column) this.indexes.delete(n);
        this.keys = this.keys.filter((k) => !(k.table === table && k.column === column));
      } else if (
        (m = /^add\s+(?=constraint\b|primary\b|unique\b|foreign\b|exclude\b|check\b)/i.exec(action))
      ) {
        this.constraint(table, action.slice(m[0].length));
      } else if ((m = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i.exec(action))) {
        this.column(table, action.slice(m[0].length));
      }
    }
  }
  dropTable(table) {
    this.tables.delete(table);
    for (const [n, ix] of this.indexes) if (ix.table === table) this.indexes.delete(n);
    this.keys = this.keys.filter((k) => k.table !== table);
  }
  renameTable(from, to) {
    if (this.tables.delete(from)) this.tables.add(to);
    for (const ix of this.indexes.values()) if (ix.table === from) ix.table = to;
    for (const k of this.keys) if (k.table === from) k.table = to;
  }
  apply(sql, addedFile = null) {
    this.added = addedFile;
    for (const statement of executableText(sql).split(';')) this.statement(statement);
    this.added = null;
  }
}

/**
 * existing, added: [{ file, sql }]. Every file is applied in version order;
 * returns the foreign keys into public.clubs that an added file creates and
 * that no full index leading on the column answers once all are applied.
 */
export function unindexedAddedClubKeys({ existing, added }) {
  const schema = new Schema();
  const addedFiles = new Set(added.map((m) => m.file));
  const all = [...existing, ...added].sort((a, b) =>
    basename(a.file).localeCompare(basename(b.file))
  );
  for (const m of all) schema.apply(m.sql, addedFiles.has(m.file) ? m.file : null);
  return schema.keys.filter((k) => !schema.covered(k));
}
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

export function report(gaps) {
  const lines = [
    `${TAG} ${gaps.length} foreign key(s) into ${PARENT} that this branch adds have no index that can answer them.`,
    'Deleting a club checks every such key; without a full index LEADING on the column it is a',
    'sequential scan of the child table, and the post-deploy certificate cannot remove its fixture club.',
    'A partial index (WHERE ...) or an index where the column is not first does not count.',
    '',
  ];
  for (const g of gaps) {
    lines.push(`  ${g.table} (${g.column})  - foreign key ${g.name}, added by ${g.file}`);
    lines.push(
      `    CREATE INDEX IF NOT EXISTS ${pgName(`idx_${bare(g.table)}_${g.column}_fk`)} ON ${g.table} (${g.column});`
    );
  }
  lines.push('', 'Add those statements to a migration in this branch.');
  return lines.join('\n');
}

// ── runner ──────────────────────────────────────────────────────────────────
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function addedMigrations(base) {
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const changed = git(['diff', '--name-only', '--diff-filter=A', mergeBase, '--', DIR]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', DIR]).split('\n');
  return [...new Set([...changed, ...untracked])].filter((f) => f.endsWith('.sql'));
}
function resolveBase() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const branch = process.env.GITHUB_BASE_REF;
  for (const ref of branch ? [`origin/${branch}`, branch] : ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', ref]);
      return ref;
    } catch {
      // try the next locally available base
    }
  }
  return 'HEAD^';
}

function main() {
  const base = resolveBase();
  let added;
  try {
    added = new Set(addedMigrations(base));
  } catch (err) {
    console.error(
      `${TAG} COULD NOT TELL: cannot diff against ${base} (${err.message.split('\n')[0]}). Give the job fetch-depth: 0.`
    );
    return 2;
  }
  if (added.size === 0) {
    console.log(`${TAG} OK - no migration added against ${base}.`);
    return 0;
  }
  const read = (file) => ({ file, sql: readFileSync(file, 'utf8') });
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => `${DIR}/${f}`);
  const gaps = unindexedAddedClubKeys({
    existing: files.filter((f) => !added.has(f)).map(read),
    added: [...added].map(read),
  });
  if (gaps.length) {
    console.error(report(gaps));
    return 1;
  }
  console.log(
    `${TAG} OK - ${added.size} added migration(s); every foreign key they add into ${PARENT} has a full index leading on its column.`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
