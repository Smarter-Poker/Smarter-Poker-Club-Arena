import { catalogSQLUnits } from './migrationSQLUnits';
import { lex, isWord, isPunct } from './sql-reader.mjs';

const header = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_ca_guard_watchlist\s*\(/i;

/** Catalog pre-images do not redefine the watchlist. Refuse ambiguous dynamic DDL. */
export function watchlistDefinitions(sql: string): string[][] {
  if (!header.test(sql)) return [];
  const outer = sql;
  const { tokens, problems } = lex(outer);
  if (problems.length) throw new Error('Unreadable watchlist migration SQL');
  const definitions: string[][] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (isWord(token, 'do')) {
      const body = tokens[i + 1];
      if (body?.type === 'dollar') {
        const text = outer.slice(body.contentStart, body.contentEnd);
        if (
          header.test(text) &&
          lex(text).tokens.some((t) => isWord(t, 'execute')) &&
          catalogSQLUnits(text).some((unit) => header.test(unit.sql))
        )
          throw new Error('Dynamic watchlist DDL requires an explicit source reader');
      }
    }
    if (!isWord(token, 'create')) continue;
    let j = i + 1;
    if (isWord(tokens[j], 'or') && isWord(tokens[j + 1], 'replace')) j += 2;
    if (
      !isWord(tokens[j++], 'function') ||
      !isWord(tokens[j++], 'public') ||
      !isPunct(tokens[j++], '.') ||
      !isWord(tokens[j++], 'fn_ca_guard_watchlist') ||
      !isPunct(tokens[j], '(')
    )
      continue;
    while (j < tokens.length && !isWord(tokens[j], 'as') && !isPunct(tokens[j], ';')) j += 1;
    const body = tokens[j + 1];
    if (!isWord(tokens[j], 'as') || body?.type !== 'dollar')
      throw new Error('Unreadable watchlist function body');
    const text = outer.slice(body.contentStart, body.contentEnd);
    const parsed = lex(text);
    if (parsed.problems.length) throw new Error('Unreadable watchlist function contents');
    definitions.push([
      ...new Set(
        parsed.tokens
          .filter((t) => t.type === 'string')
          .map((t) => text.slice(t.start + 1, t.end - 1))
          .filter((name) => /^fn_[a-z0-9_]+$/.test(name))
      ),
    ]);
    i = j + 1;
  }
  return definitions;
}
