/**
 * Split a migration into its CREATE INDEX CONCURRENTLY preamble and its one
 * transaction.
 *
 * WHY (2026-09-26)
 *
 * The production DDL policy (CLAUDE.md section 2 rule 1) makes one migration
 * one transaction, and apply-recorded-migration.mjs sends a file as a single
 * simple query for exactly that reason. It has one considered exception,
 * recorded by 20260920185803 and 20260925205938: an index on a ledger that is
 * written every hand is built CONCURRENTLY, because a plain CREATE INDEX holds
 * SHARE on the table for the whole build and stalls live play (rule 7).
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a
 * multi-statement simple query IS one (an implicit block), so the door refused
 * such a file by construction and the only way left to install it was to retype
 * it into a tool call - the very thing the door exists to prevent.
 *
 * So the door now accepts exactly that shape and nothing wider:
 *
 *   -- comments
 *   CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON public.<table> ...;
 *   ... (only more of the same, and comments)
 *   BEGIN;
 *   ... the migration, ONE transaction ...
 *   COMMIT;
 *
 * Every statement before the first line that is exactly `BEGIN;` must be a
 * CREATE INDEX CONCURRENTLY IF NOT EXISTS on a public table. Anything else
 * there - a COMMENT, an ALTER, a DROP, a DO block, a plain CREATE INDEX -
 * is refused, because it would autocommit outside the transaction and reload
 * PostgREST on its own. IF NOT EXISTS is required so a re-dispatch after a
 * partial run skips what is already built; the migration's own assertions are
 * expected to refuse an INVALID leftover by name.
 */

const INDEX_STATEMENT =
  /^CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s+ON\s+public\.([a-z_][a-z0-9_]*)\s*(?:USING\s+\w+\s*)?\([\s\S]+$/i;

/**
 * @param {string} sql the whole migration file
 * @returns {{ ok: true, indexes: {name: string, table: string, statement: string}[], body: string }
 *   | { ok: false, reason: string }}
 */
export function splitConcurrentPreamble(sql) {
  const begin = /^BEGIN\s*;[ \t]*$/m.exec(sql);
  if (!begin) return { ok: false, reason: 'no line that is exactly BEGIN; opens the migration transaction' };
  const preamble = sql.slice(0, begin.index);
  const body = sql.slice(begin.index);
  if (!/COMMIT\s*;\s*$/i.test(body.trim())) {
    return { ok: false, reason: 'the migration does not end with COMMIT; (nothing may follow the transaction)' };
  }
  const scanned = statementsOutsideComments(preamble);
  if (!scanned.ok) return scanned;
  const statements = scanned.statements;
  const indexes = [];
  for (const statement of statements) {
    const m = INDEX_STATEMENT.exec(statement.replace(/\s+/g, ' '));
    if (!m) {
      return {
        ok: false,
        reason: `only CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON public.<table> (...) may precede BEGIN; found: ${statement.replace(/\s+/g, ' ').slice(0, 120)}`,
      };
    }
    indexes.push({ name: m[1].toLowerCase(), table: m[2].toLowerCase(), statement: statement + ';' });
  }
  const names = new Set(indexes.map((i) => i.name));
  if (names.size !== indexes.length) return { ok: false, reason: 'the preamble names the same index twice' };
  return { ok: true, indexes, body };
}

/**
 * The statements of `text` with -- and (nested) block comments removed, split
 * on semicolons that are not inside a comment or a quoted string. Dollar
 * quoting is refused outright: nothing that may precede BEGIN; uses it.
 */
function statementsOutsideComments(text) {
  const statements = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const t = text.slice(i, i + 2);
        if (t === '/*') { depth++; i += 2; } else if (t === '*/') { depth--; i += 2; } else i++;
      }
      if (depth > 0) return { ok: false, reason: 'an unterminated block comment precedes BEGIN;' };
      current += ' ';
      continue;
    }
    const ch = text[i];
    if (ch === '$') return { ok: false, reason: 'dollar quoting before BEGIN; is not an index statement' };
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      if (j >= text.length) return { ok: false, reason: 'an unterminated string precedes BEGIN;' };
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) return { ok: false, reason: `a statement before BEGIN; is not terminated: ${current.trim().slice(0, 80)}` };
  return { ok: true, statements };
}

/**
 * Minutes left before the hourly break window opens at :50 UTC, or 0 inside it
 * (:50-:03). A concurrent build that is still running when the window opens is
 * refused by ca_break_window_refuses_ddl at ddl_command_end, which leaves an
 * INVALID index behind, so a build must not START without room to finish.
 */
export function minutesBeforeBreakWindow(date) {
  const minute = date.getUTCMinutes() + date.getUTCSeconds() / 60;
  if (minute >= 50 || minute < 3) return 0;
  return 50 - minute;
}
