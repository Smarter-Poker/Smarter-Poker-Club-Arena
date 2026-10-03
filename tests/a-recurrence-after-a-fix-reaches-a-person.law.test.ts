/**
 * LAW: A RECURRENCE AFTER A FIX REACHES A PERSON (2026-10-03).
 *
 * tests/one-page-per-finding.law.test.ts proved "resolved, then recurs -> 1
 * (a resolved finding re-arms)": a resolution wrote the notify ledger with
 * kind 'resolved', so the finding's next raise carried a new state and paged.
 * On 2026-09-06 "a fix is not a page" moved the resolved case in front of that
 * ledger write. The push was rightly withheld, and the re-arm went with it.
 *
 * From then on a finding that came back after its fix carried exactly the
 * state it was last paged with, and was filed as already reported. Over 14
 * days in production, 28 critical recurrences that passed every gate reached
 * nobody. They included the kill switch (-2,624.78), the unexplained chip
 * supply (-100,005.30), and tables that could not deal.
 *
 * The ledger update now also fires for a different incident when the incident
 * last paged is resolved, or gone. A second OPEN incident for the same
 * finding, a repeat for the same incident, a fix, a warning and a 0.00 still
 * never page.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003101407_a_recurrence_after_a_fix_reaches_a_person.sql'
  ),
  'utf8'
);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const between = (from: string, to: string) => {
  const a = MIG.indexOf(from);
  const b = MIG.indexOf(to, a + from.length);
  expect(a, from).toBeGreaterThanOrEqual(0);
  expect(b, to).toBeGreaterThan(a);
  return MIG.slice(a + from.length, b);
};
const OLD = between('c_old CONSTANT text := $o$', '$o$;');
const NEW = between('c_new CONSTANT text := $n$', '$n$;');

describe('a recurrence after a fix reaches a person', () => {
  it('is one pinned transaction with a live proof', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIG).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_ca_incident_notify\(uuid,text,text,boolean\)'::regprocedure\)\) = '0abfd723b4d2e129d5038e6b849c6288'\)$/m
    );
    for (const code of [
      'PREIMAGE_CHANGED',
      'AUTHORITY_CHANGED',
      'LEDGER_CHANGED',
      'RESULT_CHANGED',
    ])
      expect(MIG).toContain('RECURRENCE_PAGE_' + code);
    expect(MIG).toContain("'12db60ac332870e31d1c713c3fe4c099'");
  });

  it('declares the watched guard it redefines', () => {
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_notify', 'migration a_recurrence_after_a_fix_reaches_a_person');"
    );
  });

  it('changes only the ledger condition, and keeps the state-hash rule', () => {
    expect(OLD).toBe(
      '        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash\n      RETURNING true INTO v_fresh;'
    );
    expect(
      NEW.startsWith('        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash\n')
    ).toBe(true);
    expect(NEW.endsWith('\n      RETURNING true INTO v_fresh;')).toBe(true);
    const added = code(NEW).replace(/\s+/g, ' ').trim();
    expect(added).toBe(
      "WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash OR (l.last_incident_id IS DISTINCT FROM EXCLUDED.last_incident_id AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents p WHERE p.id = l.last_incident_id AND p.status IS DISTINCT FROM 'resolved')) RETURNING true INTO v_fresh;"
    );
  });

  it('re-arms on an episode, never on a clock', () => {
    // one-page-per-finding: no time window may be the dedupe in the sender.
    expect(code(NEW)).not.toMatch(/interval|now\s*\(|clock_timestamp|current_timestamp/i);
    expect(code(NEW)).not.toMatch(/FROM\s+public\.notifications/i);
  });

  it('records the rehearsal both ways', () => {
    expect(MIG).toContain(
      'first=1 same_again=0 second_open=0 the_fix=0 recurs_after_fix=0, the\n-- successor first=1 same_again=0 second_open=0 the_fix=0 recurs_after_fix=1'
    );
  });
});
