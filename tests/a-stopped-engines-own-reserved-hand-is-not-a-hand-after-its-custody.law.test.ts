/**
 * A STOPPED ENGINE'S OWN RESERVED HAND IS NOT A HAND AFTER ITS CUSTODY (2026-09-27)
 *
 * fn_park_stopped_time_bank_custody refused hand_after_custody for any permit
 * above the custody's hand that was not never_started, including the
 * 'reserved' permit a table takes for its next hand just before it deals.
 * Six managers that lost their lease in that instant (2026-09-26 15:07Z) were
 * refused their own custody for 24 hours; the restart certificate never
 * opened and no engine release shipped. Migration 20260927142925 exempts
 * exactly a reserved permit of the caller's own generation. These laws pin
 * that the change is that one clause and nothing else.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const FILE = read('20260927142925_a_stopped_engines_own_reserved_hand_is_not_a_hand_after_its_.sql');
const PRIOR = read('20260926145903_a_busy_custody_lock_is_waited_for_briefly.sql');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_park_stopped_time_bank_custody(');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
}
const FN = body(FILE);
const WAS = body(PRIOR);
const permitClause = (fn: string) => {
  const at = fn.indexOf('FROM smarter_private.f06_hand_permits h');
  return fn.slice(at, fn.indexOf(') THEN', at));
};

describe("a stopped engine's own reserved hand is not a hand after its custody", () => {
  it('guards the preimage it was written against, in one transaction', () => {
    expect(createHash('md5').update(WAS, 'utf8').digest('hex')).toBe(
      '3515641cabc3fbfa5c39b9b377285750'
    );
    expect(FILE).toContain("md5(p.prosrc) IS DISTINCT FROM '3515641cabc3fbfa5c39b9b377285750'");
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toContain('TO service_role;');
    expect(FILE).toContain('FROM PUBLIC, anon, authenticated;');
  });

  it('exempts only a reserved permit of the caller generation', () => {
    const clause = permitClause(FN);
    expect(clause).toContain("AND h.state <> 'never_started'");
    expect(clause).toMatch(
      /AND NOT \(h\.state = 'reserved'\s+AND p_generation IS NOT NULL\s+AND h\.generation = p_generation\)/
    );
  });

  it('changes nothing else in the function', () => {
    const strip = (fn: string) =>
      fn
        .replace(permitClause(fn), '<PERMITS>')
        .replace(/\/\* A STOPPED ENGINE'S OWN RESERVED HAND[\s\S]*?\*\/\n\s*/, '');
    expect(strip(FN)).toBe(strip(WAS));
  });

  it('still refuses every durable later hand', () => {
    for (const evidence of ["'hand_history'", "'hand_atomic_commits'", "'hand_state_snapshots'", "'f06_hand_permits'"])
      expect(FN).toContain(`'evidence', ${evidence}`);
    expect(FN.indexOf("'hand_state_snapshots'")).toBeLessThan(FN.indexOf('FROM smarter_private.f06_hand_permits h'));
  });
});
