import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

type Cutover = {
  file: string;
  gateTag: string;
  expiryTag: string;
  firstBarrier: string;
  liveError: string;
};

const cutovers: Cutover[] = [
  {
    file: '20260909014457_four_full_pool_events_retire_only_their_stale_obligation_meta.sql',
    gateTag: 'require_live_obligation_retirement_freeze',
    expiryTag: 'verify_live_obligation_retirement_freeze_still_held',
    firstBarrier: 'CREATE TABLE IF NOT EXISTS public.tournament_obligation_retirements',
    liveError: 'obligation retirement live cutover requires the maintenance entry freeze',
  },
  {
    file: '20260909041438_retire_legacy_tournament_hold_refund_door.sql',
    gateTag: 'require_live_legacy_hold_retirement_freeze',
    expiryTag: 'verify_live_legacy_hold_retirement_freeze_still_held',
    firstBarrier: 'LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE',
    liveError:
      'legacy tournament hold retirement live cutover requires the maintenance entry freeze',
  },
  {
    file: '20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql',
    gateTag: 'require_live_seat_exit_cutover_freeze',
    expiryTag: 'verify_live_seat_exit_cutover_freeze_still_held',
    firstBarrier: "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))",
    liveError: 'tournament seat-exit live cutover requires the maintenance entry freeze',
  },
  {
    file: '20260909043000_tournament_terminal_roots_are_db_first_hardened.sql',
    gateTag: 'require_live_terminal_acl_cutover_freeze',
    expiryTag: 'verify_live_terminal_acl_cutover_freeze_still_held',
    firstBarrier: 'DO $terminal_acl_prerequisites$',
    liveError: 'terminal ACL hardening live cutover requires the maintenance entry freeze',
  },
];

const pristineRelations = [
  'auth.users',
  'public.clubs',
  'public.tournaments',
  'public.tables',
  'public.chip_ledger',
  'public.tournament_tickets',
] as const;

function sqlFor(file: string): string {
  return readFileSync(resolve(root, 'supabase/migrations', file), 'utf8');
}

function taggedBody(sql: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const opening = sql.indexOf(delimiter);
  const closing = sql.indexOf(delimiter, opening + delimiter.length);
  expect(opening, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(closing, `closing ${delimiter}`).toBeGreaterThan(opening);
  return sql.slice(opening + delimiter.length, closing);
}

describe('stage-one tournament cutovers require the live maintenance entry freeze', () => {
  it.each(cutovers)('$file takes roots and proves the gate before its first barrier', (cutover) => {
    const sql = sqlFor(cutover.file);
    const terminalRoot = sql.indexOf("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    const maintenanceRoot = sql.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const gate = sql.indexOf(`DO $${cutover.gateTag}$`);
    const barrier = sql.indexOf(cutover.firstBarrier);

    expect(terminalRoot).toBeGreaterThan(-1);
    expect(maintenanceRoot).toBeGreaterThan(terminalRoot);
    expect(gate).toBeGreaterThan(maintenanceRoot);
    expect(barrier).toBeGreaterThan(gate);
  });

  it.each(cutovers)('$file exempts only the exact pristine database', (cutover) => {
    const body = taggedBody(sqlFor(cutover.file), cutover.gateTag);

    expect(body).toContain("to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL");
    expect(body).toContain('v_database_is_pristine boolean');
    expect(body).toContain('SELECT NOT (');
    for (const relation of pristineRelations) {
      expect(body).toContain(`EXISTS (SELECT 1 FROM ${relation})`);
    }
    expect(body.match(/EXISTS \(SELECT 1 FROM /g)).toHaveLength(pristineRelations.length);
    expect(body).toMatch(
      /IF NOT v_database_is_pristine\s+AND NOT public\.fn_entry_purchases_frozen\(\) THEN/
    );
    expect(body).toContain(cutover.liveError);
    expect(body).toContain("USING ERRCODE = '55006'");
  });

  it.each(cutovers)('$file rechecks a live freeze at the commit boundary', (cutover) => {
    const sql = sqlFor(cutover.file);
    const expiry = sql.indexOf(`DO $${cutover.expiryTag}$`);
    const commit = sql.lastIndexOf('\nCOMMIT;');
    const body = taggedBody(sql, cutover.expiryTag);

    expect(expiry).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(expiry);
    for (const relation of pristineRelations) {
      expect(body).toContain(`EXISTS (SELECT 1 FROM ${relation})`);
    }
    expect(body.match(/EXISTS \(SELECT 1 FROM /g)).toHaveLength(pristineRelations.length);
    expect(body).toMatch(/\) AND NOT public\.fn_entry_purchases_frozen\(\) THEN/);
    expect(body).toContain("USING ERRCODE = '55006'");
  });

  it('gates both metadata-only retirements despite their intentionally non-money behavior', () => {
    const obligationRetirement = sqlFor(cutovers[0].file);
    const holdRetirement = sqlFor(cutovers[1].file);

    expect(obligationRetirement).toContain('Retirement is metadata-only');
    expect(holdRetirement).toContain('This migration moves no money');
    expect(
      obligationRetirement.indexOf('DO $require_live_obligation_retirement_freeze$')
    ).toBeLessThan(
      obligationRetirement.indexOf(
        'CREATE TABLE IF NOT EXISTS public.tournament_obligation_retirements'
      )
    );
    expect(holdRetirement.indexOf('DO $require_live_legacy_hold_retirement_freeze$')).toBeLessThan(
      holdRetirement.indexOf('LOCK TABLE public.chip_escrow_holds')
    );
  });

  it('converges a historical obligation from either its original debt or its already-paid shape', () => {
    const sql = sqlFor(cutovers[0].file);
    const acceptedShape = sql.slice(
      sql.indexOf('IF v_obligation.tournament_id IS DISTINCT FROM'),
      sql.indexOf('INSERT INTO public.tournament_obligation_retirements')
    );
    const convergenceUpdate = sql.slice(
      sql.indexOf('UPDATE public.tournament_obligations o'),
      sql.indexOf(
        'SELECT count(*) INTO v_rows',
        sql.indexOf('UPDATE public.tournament_obligations o')
      )
    );

    expect(acceptedShape).toMatch(
      /v_obligation\.amount_owed NOT IN \(\s*v_expected\.amount_owed, v_expected\.amount_paid\)/
    );
    expect(convergenceUpdate).toMatch(
      /o\.amount_owed IN \(\s*v_expected\.amount_owed, v_expected\.amount_paid\)/
    );
    expect(convergenceUpdate).toContain('SET amount_owed = v_expected.amount_paid');
    expect(convergenceUpdate).toContain('AND o.amount_paid = v_expected.amount_paid');
  });
});
