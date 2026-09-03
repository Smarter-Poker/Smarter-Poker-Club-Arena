import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE PANEL NAMES A PERSON ONE WAY (binding)
 *
 * The rake snapshot shows two lists that can hold the same human being. The
 * club breakdown read profiles.username directly while the downline list
 * beside it resolved the arena name, so one agent was cyruswhitlock in the
 * club list and ValueSniper in their own downline. Measured on production
 * before the fix: ALL 32 agents in the test club were named differently by the
 * two lists, and 1,013 profiles across the estate carry an alias.
 *
 * Phase 6 made it worse before it made it visible. Name became a SEARCH target
 * and a SORT key, so the club list was searchable by real name - and opening an
 * agent from it carried that real name into a breadcrumb sitting above a list
 * of aliases.
 *
 * Measured after: 32 of 32 agree, and no aliased profile's real username
 * appears anywhere in the club payload.
 *
 * The estate's own law - the arena is always the alias - covers client source
 * and fn_search_players. It did not reach this function, which is exactly why
 * the drift was invisible: nothing was failing.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

function latestDefining(fnName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found = '';
  for (const f of files) {
    const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    if (sql.includes(`FUNCTION public.${fnName}(`)) found = sql;
  }
  return found;
}

function body(fnName: string): string {
  const sql = latestDefining(fnName);
  const start = sql.indexOf(`FUNCTION public.${fnName}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return sql
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

describe('one panel names a person one way', () => {
  it('the club breakdown resolves the arena name', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'no migration defines the agent breakdown').not.toBe('');
    expect(
      sql,
      'the club list reads the raw username while the list beside it shows an alias'
    ).toMatch(/fn_arena_name\(/);
    // The raw column may still be the LAST fallback, but never the answer.
    expect(sql).not.toMatch(/COALESCE\(pr\.username,\s*'Agent'\)\s+AS name/);
  });

  it('it resolves the name from the whole chain, in the canonical order', () => {
    // This SHOULD compare against the downline walker, so the two lists are
    // provably asking one resolver the same question. It cannot: the newest
    // migration that declares fn_agent_downline_rake predates the arena name
    // entirely, so the file says username where production says alias. The
    // repo cannot answer what that function currently looks like - the same
    // staleness that let this drift go unnoticed in the first place.
    //
    // So the chain is pinned literally instead. Six columns in the order
    // fn_arena_name expects: a subset would silently fall through to a real
    // name for anyone whose alias is unset but whose display name is not.
    const sql = body('fn_ca_rake_by_agent');
    const call = /fn_arena_name\(([\s\S]*?)\)/.exec(sql);
    expect(call, 'the agent list never calls the resolver').not.toBeNull();
    const args = (call ? call[1] : '')
      .replace(/\s+/g, ' ')
      .split(',')
      .map((a) => a.trim().replace(/^[a-z_]+\./, ''));
    expect(args).toEqual([
      'alias',
      'username',
      'display_name',
      'first_name',
      'last_name',
      'full_name',
    ]);

    // And the real username may only ever be the last resort behind it.
    expect(sql).toMatch(/fn_arena_name\([\s\S]*?\),\s*pr\.username,\s*'Agent'\)/);
  });


  it('the name the panel searches and sorts is the name it shows', () => {
    // Search filters and sort orders on this same column, so resolving the
    // name anywhere later than here would make the club list searchable by a
    // real name that is never displayed.
    const sql = body('fn_ca_rake_by_agent');
    const listed = sql.indexOf('AS name');
    const filtered = sql.indexOf('ILIKE');
    expect(listed, 'no name column').toBeGreaterThan(-1);
    expect(filtered, 'no filter').toBeGreaterThan(-1);
    expect(
      listed,
      'the filter runs before the name is resolved, so it matches the raw one'
    ).toBeLessThan(filtered);
    expect(sql).toMatch(/l\.name ILIKE/);
  });
});
