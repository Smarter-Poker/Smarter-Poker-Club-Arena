/**
 * A LATE TICKET ENTRY EXPECTS THE RUNNING COUNT (2026-10-12).
 *
 * Root cause of the 2026-10-11 17:50 to 18:53 UTC connection exhaustion.
 * 20260922141704 stopped the roster trigger counting an INSERT into a
 * RUNNING field; the ticket door kept expecting it to, so every late ticket
 * entry was refused ("ticket admission tournament cache changed"), with a
 * SQLSTATE PostgREST 14.5 re-runs without end. 0 of 1,413 ticket admissions
 * were ever late. This pins the door to the same status-dependent expectation
 * the wallet doors hold, and refuses any later migration that raises a custom
 * 40001, the code that turned one refusal into a pool-wide storm.
 * docs/changelog/2026-10-12-a-late-ticket-entry-expects-the-running-count.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = 'supabase/migrations';
const FILE = '20261012031813_a_late_ticket_entry_expects_the_running_count.sql';
const migration = readFileSync(`${DIR}/${FILE}`, 'utf8');
const trigger = readFileSync(
  `${DIR}/20260922141704_a_running_field_is_counted_by_the_bust_that_shrinks_it.sql`,
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('a late ticket entry expects the running count', () => {
  it('is recorded byte-exact as applied', () => {
    expect(md5(migration)).toBe('dc3da7d73f7223b1fc30c2e4e6e81293');
  });

  it('expects the trigger count before the start and the unchanged count once RUNNING', () => {
    const expectation = migration.slice(migration.indexOf('v_new constant text'));
    expect(expectation).toMatch(
      /AND current_players IS NOT DISTINCT FROM CASE\s+WHEN v_t\.status IN \('ANNOUNCED','REGISTERING'\) THEN v_players_before\+1\s+ELSE v_players_before\s+END/
    );
    // The anchor it replaces is the pre-start-only expectation, exactly once.
    expect(migration).toContain(
      'v_anchor constant text := $a$     -- The canonical roster trigger has already counted the row inserted'
    );
    expect(migration).toContain(
      "(length(d) - length(replace(d, v_anchor, ''))) / length(v_anchor) <> 1"
    );
  });

  it('rests on the trigger rule it corrects for: a RUNNING INSERT is counted by its door', () => {
    expect(trigger).toMatch(
      /An admission \(INSERT\) or a removal\s+\(DELETE\) into a RUNNING field is counted by the door that performs it/
    );
    expect(trigger).toMatch(/WHERE id = v_tid\s+AND status IN \('ANNOUNCED', 'REGISTERING'\)/);
  });

  it('pins the preimage and postimage and changes nothing else', () => {
    expect(migration).toContain("v_pre constant text := 'b335c4664d2b029e920e998edd18666f'");
    expect(migration).toContain("v_post constant text := '5f8d1cd44ebfa063291401da00597e8a'");
    expect(migration).toContain(
      "@live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = '5f8d1cd44ebfa063291401da00597e8a'"
    );
    expect(migration).toMatch(/BEGIN;\nSET LOCAL lock_timeout = '5s';[\s\S]*COMMIT;\n$/);
    expect(migration).toContain('proacl IS NOT DISTINCT FROM acl_before');
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|UPDATE public\.)\b/);
  });

  it('no later migration raises a custom serialization failure (40001)', () => {
    // PostgREST 14.5 re-runs a request whose transaction ends in 40001, without
    // limit, holding a pool connection the whole time. A refusal that is the
    // same on every run (a compare-and-set that cannot match) then never ends.
    // 20261011185301 moved the F06 lane and ticket raises to 55P03 / 55000.
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql') && f > '20261011185301')
      .sort();
    const offenders = later.filter((f) =>
      /USING\s+ERRCODE\s*=\s*'(?:40001|serialization_failure)'/i.test(
        readFileSync(`${DIR}/${f}`, 'utf8')
      )
    );
    expect(later).toContain(FILE);
    expect(offenders).toEqual([]);
  });
});
