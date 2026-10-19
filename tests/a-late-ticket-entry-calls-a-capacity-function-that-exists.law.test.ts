/**
 * LAW: a late ticket entry calls a capacity function that exists.
 * ===========================================================================
 * public.fn_create_late_registration_capacity(uuid) was dropped on purpose on
 * 2026-09-08 (20260908042200) and replaced by
 * public.fn_ensure_late_registration_capacity(uuid, integer). The 2026-10-17
 * rewrite of fn_ca_register_for_tournament_with_ticket_for
 * (20261017004440_satellites_seat_bounty_targets) copied an older body and
 * brought the dropped name back in both late-seating retries. PL/pgSQL only
 * resolves a call when it runs, so nothing failed at install; the first late
 * ticket entry that needed the retry would have raised 42883 and rolled the
 * whole registration back, for humans and horses alike.
 *
 * Fixed in 20261019093516_ticket_late_registration_calls_the_canonical_capacity_functi.
 *
 * What this pins:
 *   1. No function's CURRENT declaration (the last migration that declares it,
 *      which is what Postgres runs) calls the dropped name. Corpus-wide, so a
 *      future rewrite that copies an old body anywhere fails here.
 *   2. The ticket path calls the replacement with reserved entries 0, twice,
 *      AFTER it has inserted the entrant as 'registered'. The entrant is
 *      already demand when the retry runs, so 1 would count them twice and,
 *      for the entrant who fills the field, read the window as closed and
 *      open nothing (the reason fn_seat_late_registrant passes 0 too).
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const DROPPED = 'fn_create_late_registration_capacity';
const DECLARATION = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi;

function currentDeclarations(): Map<string, { file: string; body: string }> {
  const current = new Map<string, { file: string; body: string }>();
  for (const file of migrationFiles()) {
    const sql = readMigration(file);
    if (!sql.includes('FUNCTION public.')) continue;
    for (const match of sql.matchAll(DECLARATION)) {
      const rest = sql.slice(match.index);
      const quote = /\bAS\s+(\$\w*\$)/i.exec(rest);
      if (!quote) continue;
      const start = quote.index + quote[0].length;
      const end = rest.indexOf(quote[1], start);
      if (end < 0) continue;
      current.set(match[1], { file, body: rest.slice(start, end) });
    }
  }
  return current;
}

describe('a late ticket entry calls a capacity function that exists', () => {
  it('no current function declaration calls the dropped capacity function', () => {
    const offenders = [...currentDeclarations()]
      .filter(([name, { body }]) => name !== DROPPED && body.includes(`${DROPPED}(`))
      .map(([name, { file }]) => `${name} (${file})`);
    expect(offenders).toEqual([]);
  }, 60_000);

  it('the ticket path reserves no second entry for the entrant it already inserted', () => {
    const { name, sql } = latestDeclaring('fn_ca_register_for_tournament_with_ticket_for');
    expect(name).toMatch(/^\d{14}_/);
    const body = functionBody(sql, 'fn_ca_register_for_tournament_with_ticket_for');
    expect(body).not.toContain(DROPPED);
    const calls = [...body.matchAll(/fn_ensure_late_registration_capacity\(([^)]*)\)/g)];
    expect(calls.map((c) => c[1].replace(/\s+/g, ''))).toEqual([
      'p_tournament_id,0',
      'p_tournament_id,0',
    ]);
    const inserted = body.indexOf("p_tournament_id,v_uid,v_username,v_start_chips,'registered'");
    expect(inserted).toBeGreaterThan(-1);
    expect(calls[0].index).toBeGreaterThan(inserted);
  });
});
