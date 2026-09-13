import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

type Cutover = {
  file: string;
  gateTag: string;
  expiryTag?: string;
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
  const directory = resolve(root, 'supabase/migrations');
  if (file.endsWith('.sql')) return readFileSync(resolve(directory, file), 'utf8');
  const matches = readdirSync(directory).filter(
    (candidate) => candidate.endsWith(`_${file}.sql`) || candidate.endsWith(`_${file}.sql.pending`)
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${file} migration, found ${matches.length}`);
  }
  return readFileSync(resolve(directory, matches[0]), 'utf8');
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
    if (!cutover.expiryTag) {
      expect(sql).toContain("SET LOCAL transaction_timeout = '180s';");
      expect(sql).toContain('pg_advisory_xact_lock_shared(530090,1)');
      return;
    }
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

  it('gates metadata-only retirement despite its intentionally non-money behavior', () => {
    const obligationRetirement = sqlFor(cutovers[0].file);

    expect(obligationRetirement).toContain('Retirement is metadata-only');
    expect(
      obligationRetirement.indexOf('DO $require_live_obligation_retirement_freeze$')
    ).toBeLessThan(
      obligationRetirement.indexOf(
        'CREATE TABLE IF NOT EXISTS public.tournament_obligation_retirements'
      )
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
