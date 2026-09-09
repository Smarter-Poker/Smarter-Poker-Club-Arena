/**
 * A FOUR-TABLE LIMIT IS NEVER SATELLITE CASH.
 *
 * The rolling legacy delivery helper must remain callable while old engines
 * drain, but it is not allowed to convert a capacity refusal into wallet
 * chips. The replacement atomic satellite authority owns the durable noncash
 * ticket path. This law pins the explicit forward correction after the
 * immutable incident migration.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

function migration(fragment: string): { file: string; sql: string } {
  const file = readdirSync(MIGRATIONS).find((candidate) => candidate.includes(fragment));
  expect(file, `no migration matching ${fragment}`).toBeTruthy();
  return {
    file: file as string,
    sql: readFileSync(resolve(MIGRATIONS, file as string), 'utf8'),
  };
}

function deliveryDefinition(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact(');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + '$function$;'.length);
}

const canonical = migration('non_satellite_terminal_settlement_commits_one_stored_receipt');
const incident = migration('a_seat_the_winner_cannot_take_is_paid_as_cash');
const correction = migration('the_four_table_limit_is_never_satellite_cash');

describe('a four-table limit is never satellite cash', () => {
  it('is an explicit forward correction after the immutable incident', () => {
    expect(correction.file.localeCompare(incident.file)).toBeGreaterThan(0);
    expect(correction.sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact('
    );
    expect(correction.sql).not.toContain('EXECUTE replace(');
    expect(correction.sql).not.toContain('ca_guard_def_history');
  });

  it('restores the complete canonical helper rather than another patch', () => {
    expect(deliveryDefinition(correction.sql)).toBe(deliveryDefinition(canonical.sql));
  });

  it('accepts only audited predecessor bodies inside the serialized maintenance freeze', () => {
    const terminalRoot = correction.sql.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)"
    );
    const maintenanceRoot = correction.sql.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const freezeGate = correction.sql.indexOf('DO $require_live_cap_correction_freeze$');
    const replacement = correction.sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact('
    );
    expect(terminalRoot).toBeGreaterThan(-1);
    expect(maintenanceRoot).toBeGreaterThan(terminalRoot);
    expect(freezeGate).toBeGreaterThan(maintenanceRoot);
    expect(replacement).toBeGreaterThan(freezeGate);
    expect(correction.sql).toContain("to_regprocedure('public.fn_entry_purchases_frozen()')");
    expect(correction.sql).toContain('AND NOT public.fn_entry_purchases_frozen()');
    expect(correction.sql).toContain("USING ERRCODE = '55006'");
    expect(correction.sql).toContain('DO $cap_correction_freeze_remains$');
    for (const sourceMd5 of [
      '64742412685d5773553c4d234a3b1d41',
      '16216c0bc04a962e32010ad140ef123e',
      '9c764ebc72a6d331a26c812b58d613de',
    ]) {
      expect(correction.sql).toContain(sourceMd5);
    }
    expect(correction.sql).toContain(
      'legacy satellite delivery source drifted before cap correction'
    );
  });

  it('leaves the cap exception uncaught while preserving prior cash cases', () => {
    const fixed = deliveryDefinition(correction.sql);
    expect(incident.sql).toContain('winner_at_concurrent_game_cap');
    expect(fixed).not.toContain('winner_at_concurrent_game_cap');
    expect(fixed).not.toContain('EXCEPTION WHEN check_violation');
    expect(fixed).not.toContain('SQLERRM');
    expect(fixed).toContain('v_result:=public.fn_award_satellite_seat(');
    for (const reason of [
      'target_missing',
      'target_not_open',
      'target_economics_changed',
      'seat_already_held_elsewhere',
    ]) {
      expect(fixed).toContain(reason);
    }
  });

  it('proves owner, fixed search path and exact owner-only execution', () => {
    expect(correction.sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_deliver_satellite_ticket_exact\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(correction.sql).toContain("p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]");
    expect(correction.sql).toContain('p.proowner = v_expected_owner');
    expect(correction.sql).toContain('ca_legacy_satellite_delivery_install_guard');
    expect(correction.sql).toContain("has_function_privilege('anon', v_proc, 'EXECUTE')");
    expect(correction.sql).toContain("has_function_privilege('authenticated', v_proc, 'EXECUTE')");
    expect(correction.sql).toContain("has_function_privilege('service_role', v_proc, 'EXECUTE')");
  });

  it('installs a catalog postcondition against the forbidden catch', () => {
    expect(correction.sql).toContain("position('winner_at_concurrent_game_cap' IN v_source) > 0");
    expect(correction.sql).toContain("position('EXCEPTION WHEN check_violation' IN v_source) > 0");
    expect(correction.sql).toContain(
      "position('SQLERRM LIKE ''%FOUR TABLE LIMIT%''' IN v_source) > 0"
    );
  });
});
