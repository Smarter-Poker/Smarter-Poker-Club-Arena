import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

const migrations = [
  {
    name: 'cancellation',
    file: '20260909215539_tournament_cancellation_commits_one_stored_receipt.sql',
    broadLock: 'LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE',
    liveError: 'atomic cancellation live cutover requires the maintenance entry freeze',
    expiryTag: 'verify_live_cancellation_freeze_still_held',
  },
  {
    name: 'payout source hardening',
    file: '20260909215636_every_tournament_payout_names_its_source.sql',
    broadLock: 'LOCK TABLE public.tournament_payouts IN ACCESS EXCLUSIVE MODE',
    liveError:
      'tournament payout source hardening live cutover requires the maintenance entry freeze',
    expiryTag: 'verify_live_payout_source_freeze_still_held',
  },
  {
    name: 'terminal settlement',
    file: '20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql',
    broadLock: 'LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE',
    liveError: 'terminal settlement live cutover requires the maintenance entry freeze',
    expiryTag: 'verify_live_terminal_settlement_freeze_still_held',
  },
].map((migration) => ({
  ...migration,
  sql: readFileSync(resolve(root, 'supabase', 'migrations', migration.file), 'utf8'),
}));

const pristineRelations = [
  'auth.users',
  'public.clubs',
  'public.tournaments',
  'public.tables',
  'public.chip_ledger',
  'public.tournament_tickets',
] as const;

describe('every broad stage-one terminal cutover requires the live entry freeze', () => {
  for (const migration of migrations) {
    it(`${migration.name} takes canonical roots and proves the freeze before its broad lock`, () => {
      const budget = migration.sql.indexOf("SET LOCAL statement_timeout = '120s';");
      const terminalRoot = migration.sql.indexOf(
        "hashtextextended('ca:tournament-terminal-settlement:v1',0)",
        budget
      );
      const maintenanceRoot = migration.sql.indexOf(
        'pg_advisory_xact_lock_shared(530090,1)',
        terminalRoot
      );
      const predicateRequirement = migration.sql.indexOf(
        "to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL",
        maintenanceRoot
      );
      const liveFreezeGate = migration.sql.indexOf(
        'AND NOT public.fn_entry_purchases_frozen() THEN',
        predicateRequirement
      );
      const broadLock = migration.sql.indexOf(migration.broadLock);

      expect(budget).toBeGreaterThan(-1);
      expect(terminalRoot).toBeGreaterThan(budget);
      expect(maintenanceRoot).toBeGreaterThan(terminalRoot);
      expect(predicateRequirement).toBeGreaterThan(maintenanceRoot);
      expect(liveFreezeGate).toBeGreaterThan(predicateRequirement);
      expect(broadLock).toBeGreaterThan(liveFreezeGate);
      expect(migration.sql).toContain(migration.liveError);
      expect(migration.sql.slice(liveFreezeGate, broadLock)).toContain("ERRCODE = '55006'");
    });

    it(`${migration.name} permits only the exact pristine database without a freeze`, () => {
      const gateStart = migration.sql.indexOf('v_database_is_pristine boolean;');
      const gateEnd = migration.sql.indexOf('AND NOT public.fn_entry_purchases_frozen() THEN');
      const gate = migration.sql.slice(gateStart, gateEnd);

      expect(gateStart).toBeGreaterThan(-1);
      expect(gateEnd).toBeGreaterThan(gateStart);
      expect(gate).toContain('SELECT NOT (');
      for (const relation of pristineRelations) {
        expect(gate, `${migration.name} checks ${relation}`).toContain(
          `EXISTS (SELECT 1 FROM ${relation})`
        );
      }
      expect((gate.match(/EXISTS \(SELECT 1 FROM /g) ?? []).length).toBe(pristineRelations.length);
      expect(gate).toContain(') INTO v_database_is_pristine;');
      expect(migration.sql).toContain('IF NOT v_database_is_pristine');
    });

    it(`${migration.name} rechecks the live freeze at the commit boundary`, () => {
      const expiry = migration.sql.indexOf(`DO $${migration.expiryTag}$`);
      const commit = migration.sql.lastIndexOf('\nCOMMIT;');
      const expiryEnd = migration.sql.indexOf(`$${migration.expiryTag}$;`, expiry + 4);
      const body = migration.sql.slice(expiry, expiryEnd);

      expect(expiry).toBeGreaterThan(-1);
      expect(expiryEnd).toBeGreaterThan(expiry);
      expect(commit).toBeGreaterThan(expiryEnd);
      for (const relation of pristineRelations) {
        expect(body, `${migration.name} rechecks ${relation}`).toContain(
          `EXISTS (SELECT 1 FROM ${relation})`
        );
      }
      expect(body).toContain('AND NOT public.fn_entry_purchases_frozen() THEN');
      expect(body).toContain("ERRCODE = '55006'");
    });
  }
});
