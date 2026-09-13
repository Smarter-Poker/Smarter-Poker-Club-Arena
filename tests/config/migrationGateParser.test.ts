/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A QUOTED STRING IS NOT A TABLE DECLARATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * scripts/ci/check-migrations-applied.mjs asserts that every object a migration
 * DECLARES exists in the live schema. It finds those declarations with regexes
 * over the raw SQL, stripping comments first.
 *
 * It did not strip string literals, and on 2026-08-23 that turned a correct,
 * fully-applied migration into a permanently failing gate. The migration
 * installs an event trigger and therefore legitimately contains:
 *
 *   WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
 *
 * which the parser read as declaring a table named "as"; and a
 * COMMENT ON FUNCTION whose prose reads "CREATE TABLE here inherits ...",
 * which it read as a table named "here". Both are phantoms by construction -
 * the gate then demands they exist in the live schema, and no amount of
 * applying the migration can ever satisfy that.
 *
 * The fix strips single-quoted strings after comments. It cannot hide a real
 * declaration, because a real CREATE TABLE is never inside quotes.
 *
 * These cases run the gate's own cleaning and matching rules over hand-written
 * SQL, so they fail if the strip is removed or reordered.
 */

import { describe, it, expect } from 'vitest';
import { declaredObjects, executableSql } from '../../scripts/ci/check-migrations-applied.mjs';
const tables = (sql: string) => declaredObjects(sql).tables;

describe('the gate still finds what it must find', () => {
  it('sees a real CREATE TABLE', () => {
    expect(tables('CREATE TABLE public.real_thing (id int);')).toEqual(['real_thing']);
  });

  it('sees a real one that sits beside prose mentioning the words', () => {
    expect(
      tables(
        "CREATE TABLE public.keep_me (id int); COMMENT ON TABLE public.keep_me IS 'CREATE TABLE here';"
      )
    ).toEqual(['keep_me']);
  });

  it('is not confused by an apostrophe in a comment before a real one', () => {
    // This is why comments are stripped BEFORE strings: "else's" would
    // otherwise open a quote and swallow the statement that follows.
    expect(tables("-- someone else's change\nCREATE TABLE public.still_seen (id int);")).toEqual([
      'still_seen',
    ]);
  });

  it('is not confused by an apostrophe in a block comment before a real one', () => {
    expect(
      tables("/* the manager's canonical door */ CREATE TABLE public.still_seen (id int);")
    ).toEqual(['still_seen']);
  });
});

describe('the gate no longer invents tables out of quoted text', () => {
  it('ignores an event-trigger TAG list', () => {
    expect(tables("WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')")).toEqual([]);
  });

  it('ignores prose inside a COMMENT', () => {
    expect(tables("COMMENT ON FUNCTION f() IS 'CREATE TABLE here inherits grants';")).toEqual([]);
  });

  it('ignores a declaration quoted inside a block comment', () => {
    expect(tables('/* CREATE TABLE public.never_existed (id int); */')).toEqual([]);
  });
});

describe('the exported gate cleaner preserves lexical boundaries', () => {
  it('removes single-quoted prose', () => {
    expect(executableSql("COMMENT ON TABLE x IS 'CREATE TABLE phantom';")).not.toContain('phantom');
  });
  it('handles comments before strings without unbalancing quotes', () => {
    expect(
      tables(
        "/* somebody's note */ -- another's note\nCREATE TABLE public.real_one(id int); COMMENT ON TABLE real_one IS 'CREATE TABLE phantom';"
      )
    ).toEqual(['real_one']);
  });
});
