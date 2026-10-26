/**
 * A STALLED TABLE PAGES ITS REAL REFUSAL, AND A REPEATED REFUSAL READS AS
 * STUCK (2026-10-25)
 *
 * Union PKO Afternoon 12135e5b, Table 13 (3e3d1587) dealt nothing from 19:53
 * to 23:40 UTC with five players seated. Every park re-admission was refused
 * F06_MOVEMENT_WHOLE_ROSTER_REQUIRED, yet its one page read "Last refusal: F06
 * manager authority unavailable" (a fenced retry that overwrote the code), and
 * its half-hourly refreshes changed nothing because the dedupe door returns the
 * open row untouched. Over the seven days before, 30 of 53 such pages read
 * "Last refusal: unknown": the table had been killed and rebuilt and the kill
 * reason was never named.
 *
 * The manager now keeps the coded refusal as the table's streak (a refusal with
 * no code never replaces it), counts identical refusals, names the recovery
 * reason when nothing was refused, says STUCK in the page, refreshes at once
 * when the refusal changes, and rewrites the one open alert on each refresh.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as alerts from './services/financialAlerts.js';
import { supabase } from './services/supabase.js';
import { TournamentManagerBase } from './tournament/TournamentManagerBase.js';

afterEach(() => vi.restoreAllMocks());

type Streak = { code: string; coded: boolean; count: number; firstAt: number; lastAt: number };
type Probe = {
  tournamentId: string;
  tableAdmissionFailingSince: Map<string, number>;
  tableAdmissionLastRefusal: Map<string, string>;
  tableAdmissionPagedAt: Map<string, number>;
  tableAdmissionRefusalStreak: Map<string, Streak>;
  tableAdmissionRecoveryReason: Map<string, string>;
  tableAdmissionPagedCode: Map<string, string | null>;
  tableEngineRecoveryAttempts: Map<string, number>;
  tableEngineRecoveryTimers: Map<string, unknown>;
  tableEngineRecoveryExpected: Map<string, unknown>;
  clearLifecycleTimeout: (timer: unknown) => void;
};

const proto = TournamentManagerBase.prototype as unknown as {
  noteTableAdmissionRefusal(this: Probe, tableId: string, error: unknown, now?: number): void;
  getTableAdmissionRefusalStreak(
    this: Probe,
    tableId: string
  ): { code: string; count: number; firstAt: number; lastAt: number } | null;
  pageTableAdmissionFailingIfDue(this: Probe, tableId: string, now?: number): void;
  clearManagedTableEngineRecovery(this: Probe, tableId: string, reset?: boolean): void;
  forgetAdmissionFailureUnlessRetrying(this: Probe, tableId: string): void;
};

function probe(): Probe {
  return {
    tournamentId: '12135e5b-a0d0-4760-b19f-76bb9f57e9e4',
    tableAdmissionFailingSince: new Map(),
    tableAdmissionLastRefusal: new Map(),
    tableAdmissionPagedAt: new Map(),
    tableAdmissionRefusalStreak: new Map(),
    tableAdmissionRecoveryReason: new Map(),
    tableAdmissionPagedCode: new Map(),
    tableEngineRecoveryAttempts: new Map(),
    tableEngineRecoveryTimers: new Map(),
    tableEngineRecoveryExpected: new Map(),
    clearLifecycleTimeout: () => {},
  };
}

const T = '3e3d1587-a451-46c3-a70a-0d4fd7b577b5';
const ROSTER = 'f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED';
const FENCED = 'F06 manager authority unavailable';
const MIN = 60_000;

function mockAlertRow() {
  const update = vi.fn();
  const chain = {
    update: (row: unknown) => {
      update(row);
      return chain;
    },
    eq: () => chain,
    then: (resolveFn: (v: { error: null }) => unknown) => resolveFn({ error: null }),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
  return update;
}

describe('the refusal a table is stuck on', () => {
  it('reads the database code out of a refusal', () => {
    expect(TournamentManagerBase.tableAdmissionRefusalCode(ROSTER)).toBe(
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'
    );
    expect(
      TournamentManagerBase.tableAdmissionRefusalCode(
        'f06_movement_admission_unproven [55000]: F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'
      )
    ).toBe('F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN');
    expect(TournamentManagerBase.tableAdmissionRefusalCode(FENCED)).toBeNull();
  });

  it('counts identical refusals, and a fenced retry never replaces the coded one', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set(T, 0);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 1 * MIN);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 2 * MIN);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(FENCED), 3 * MIN);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 4 * MIN);
    expect(proto.getTableAdmissionRefusalStreak.call(m, T)).toEqual({
      code: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
      count: 3,
      firstAt: 1 * MIN,
      lastAt: 4 * MIN,
    });
    // The raw last refusal is still the last one met.
    expect(m.tableAdmissionLastRefusal.get(T)).toBe(ROSTER);
  });

  it('a different code starts a new streak', () => {
    const m = probe();
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 1 * MIN);
    proto.noteTableAdmissionRefusal.call(
      m,
      T,
      new Error('F06_MOVEMENT_ELIMINATION_UNPROVEN'),
      2 * MIN
    );
    expect(proto.getTableAdmissionRefusalStreak.call(m, T)).toMatchObject({
      code: 'F06_MOVEMENT_ELIMINATION_UNPROVEN',
      count: 1,
    });
  });

  it('is forgotten with the failure', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set(T, 0);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 1 * MIN);
    m.tableAdmissionRecoveryReason.set(T, 'engine_start_failed');
    proto.clearManagedTableEngineRecovery.call(m, T, false);
    expect(proto.getTableAdmissionRefusalStreak.call(m, T)).not.toBeNull();
    proto.clearManagedTableEngineRecovery.call(m, T);
    expect(proto.getTableAdmissionRefusalStreak.call(m, T)).toBeNull();
    expect(m.tableAdmissionRecoveryReason.has(T)).toBe(false);
  });
});

describe('the page', () => {
  it('names the coded refusal as STUCK with its count, not the fenced retry', () => {
    const raise = vi
      .spyOn(alerts, 'raiseFinancialAlert')
      .mockResolvedValue({ persisted: true, alertId: 'a' });
    const m = probe();
    m.tableAdmissionFailingSince.set(T, 0);
    for (let i = 1; i <= 27; i++)
      proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), i * 20_000);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(FENCED), 9.5 * MIN);
    proto.pageTableAdmissionFailingIfDue.call(m, T, 10 * MIN);
    expect(raise).toHaveBeenCalledTimes(1);
    const [, source, message, context, key] = raise.mock.calls[0];
    expect(source).toBe('Tournament.table_admission_failing');
    expect(message).toContain('STUCK: refused F06_MOVEMENT_WHOLE_ROSTER_REQUIRED 27 times since');
    expect(context).toMatchObject({
      table_id: T,
      refusal_code: 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
      identical_refusals: 27,
      stuck: true,
      last_refusal: FENCED,
    });
    expect(key).toBe(`table-admission-failing:${T}`);
  });

  it('names the recovery reason when no refusal was ever met', () => {
    const raise = vi
      .spyOn(alerts, 'raiseFinancialAlert')
      .mockResolvedValue({ persisted: true, alertId: 'a' });
    const m = probe();
    m.tableAdmissionFailingSince.set(T, 0);
    m.tableAdmissionRecoveryReason.set(
      T,
      'tournament_table_zombie:settlement_post_commit_obligations:permit=none'
    );
    proto.pageTableAdmissionFailingIfDue.call(m, T, 10 * MIN);
    const [, , message, context] = raise.mock.calls[0];
    expect(message).toContain(
      'Last refusal: none recorded (recovery reason: tournament_table_zombie:settlement_post_commit_obligations:permit=none)'
    );
    expect(message).not.toContain('unknown');
    expect(context).toMatchObject({ recovery_reason: expect.stringContaining('zombie') });
  });

  it('refreshes at once when the refusal changes, and rewrites the one open row', async () => {
    const raise = vi
      .spyOn(alerts, 'raiseFinancialAlert')
      .mockResolvedValue({ persisted: true, alertId: 'row-1' });
    const update = mockAlertRow();
    const m = probe();
    m.tableAdmissionFailingSince.set(T, 0);
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 1 * MIN);
    proto.pageTableAdmissionFailingIfDue.call(m, T, 10 * MIN);
    // Same code, inside the half hour: no refresh.
    proto.noteTableAdmissionRefusal.call(m, T, new Error(ROSTER), 11 * MIN);
    proto.pageTableAdmissionFailingIfDue.call(m, T, 12 * MIN);
    expect(raise).toHaveBeenCalledTimes(1);
    // A new code refreshes now.
    proto.noteTableAdmissionRefusal.call(
      m,
      T,
      new Error('F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'),
      13 * MIN
    );
    proto.pageTableAdmissionFailingIfDue.call(m, T, 13 * MIN);
    expect(raise).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    // The first page inserts; the refresh rewrites that row, keeping its keys.
    expect(update).toHaveBeenCalledTimes(1);
    const row = update.mock.calls[0][0] as { message: string; context: Record<string, unknown> };
    expect(row.message).toContain('F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN');
    expect(row.context).toMatchObject({
      dedupe_key: `table-admission-failing:${T}`,
      channel: 'server_rpc',
      entity_id: m.tournamentId,
      refusal_code: 'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN',
    });
  });
});

describe('wiring', () => {
  const BASE = readFileSync(
    resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
    'utf8'
  );
  const SERVER = readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');
  it('every recovery keeps the reason that started it', () => {
    expect(BASE).toMatch(
      /if \(!this\.tableAdmissionRecoveryReason\?\.has\(tableId\)\)\n\s*this\.tableAdmissionRecoveryReason\?\.set\(tableId, String\(reason\)/
    );
  });
  it('/health names the refusal a failing table is stuck on', () => {
    expect(SERVER).toContain('manager.getTableAdmissionRefusalStreak?.(table.tableId)');
    expect(SERVER).toContain('refusal: t.refusal,\n          stuckOn: t.stuckOn,');
  });
});
