/**
 * A TABLE THAT CANNOT START SAYS WHY, AND PAGES (2026-10-15)
 *
 * Freeroll a38b88a9 sat RUNNING with 58 seated players and no hand for 35
 * hours. All 8 tables were refused `retained_hand_submission_pending:
 * successor_financial_claim_spent` every 15 s and the sentence reached only
 * the engine console. The manager now keeps each failing table's last
 * refusal, /health names it, and a table failing for ten minutes raises one
 * critical alert carrying it (deduplicated on the table, refreshed at most
 * every thirty minutes).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as alerts from './services/financialAlerts.js';
import { supabase } from './services/supabase.js';
import { TournamentManagerBase } from './tournament/TournamentManagerBase.js';

afterEach(() => vi.restoreAllMocks());

type Probe = {
  tournamentId: string;
  tableAdmissionFailingSince: Map<string, number>;
  tableAdmissionLastRefusal: Map<string, string>;
  tableAdmissionPagedAt: Map<string, number>;
  tableEngineRecoveryAttempts: Map<string, number>;
  tableEngineRecoveryTimers: Map<string, unknown>;
  tableEngineRecoveryExpected: Map<string, unknown>;
  clearLifecycleTimeout: (timer: unknown) => void;
};

function probe(): Probe {
  return {
    tournamentId: 'a38b88a9-5480-4e34-b04f-d669ff8fc8a8',
    tableAdmissionFailingSince: new Map(),
    tableAdmissionLastRefusal: new Map(),
    tableAdmissionPagedAt: new Map(),
    tableEngineRecoveryAttempts: new Map(),
    tableEngineRecoveryTimers: new Map(),
    tableEngineRecoveryExpected: new Map(),
    clearLifecycleTimeout: () => {},
  };
}

const proto = TournamentManagerBase.prototype as unknown as {
  noteTableAdmissionRefusal(this: Probe, tableId: string, error: unknown): void;
  getTableAdmissionRefusals(this: Probe): Array<{ tableId: string; refusal: string | null }>;
  pageTableAdmissionFailingIfDue(this: Probe, tableId: string, now?: number): void;
  clearManagedTableEngineRecovery(this: Probe, tableId: string, reset?: boolean): void;
  forgetAdmissionFailureUnlessRetrying(this: Probe, tableId: string): void;
};

const REFUSAL = 'retained_hand_submission_pending: successor_financial_claim_spent';
const MIN = 60_000;

describe('a failing table keeps its last refusal', () => {
  it('records the thrown message, bounded and single-line', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set('t1', 0);
    proto.noteTableAdmissionRefusal.call(m, 't1', new Error(`${REFUSAL}\n   at x`));
    expect(proto.getTableAdmissionRefusals.call(m)).toEqual([
      { tableId: 't1', refusal: `${REFUSAL} at x` },
    ]);
    proto.noteTableAdmissionRefusal.call(m, 't1', new Error('x'.repeat(2000)));
    expect(m.tableAdmissionLastRefusal.get('t1')!.length).toBe(400);
  });

  it('is forgotten with the failure, not before', () => {
    const m = probe();
    m.tableAdmissionFailingSince.set('t1', 0);
    m.tableAdmissionLastRefusal.set('t1', REFUSAL);
    proto.clearManagedTableEngineRecovery.call(m, 't1', false);
    expect(m.tableAdmissionLastRefusal.has('t1')).toBe(true);
    proto.clearManagedTableEngineRecovery.call(m, 't1');
    expect(m.tableAdmissionLastRefusal.has('t1')).toBe(false);
    m.tableAdmissionFailingSince.set('t2', 0);
    m.tableAdmissionLastRefusal.set('t2', REFUSAL);
    proto.forgetAdmissionFailureUnlessRetrying.call(m, 't2');
    expect(m.tableAdmissionLastRefusal.has('t2')).toBe(false);
  });
});

describe('a table failing for ten minutes pages once per half hour with its reason', () => {
  it('stays quiet before ten minutes, pages at ten, refreshes only after thirty', async () => {
    const raise = vi
      .spyOn(alerts, 'raiseFinancialAlert')
      .mockResolvedValue({ persisted: true, alertId: 'a' });
    // A refresh rewrites the open row (aStalledTablePagesItsRealRefusal).
    const chain = { update: () => chain, eq: () => chain, then: (f: any) => f({ error: null }) };
    vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
    const m = probe();
    m.tableAdmissionFailingSince.set('t1', 0);
    m.tableAdmissionLastRefusal.set('t1', REFUSAL);
    proto.pageTableAdmissionFailingIfDue.call(m, 't1', 9 * MIN);
    expect(raise).not.toHaveBeenCalled();
    proto.pageTableAdmissionFailingIfDue.call(m, 't1', 10 * MIN);
    expect(raise).toHaveBeenCalledTimes(1);
    const [severity, source, message, context, key, entity] = raise.mock.calls[0];
    expect(severity).toBe('critical');
    expect(source).toBe('Tournament.table_admission_failing');
    expect(message).toContain(REFUSAL);
    expect(context).toMatchObject({ table_id: 't1', failing_minutes: 10, last_refusal: REFUSAL });
    expect(key).toBe('table-admission-failing:t1');
    expect(entity).toBe(m.tournamentId);
    proto.pageTableAdmissionFailingIfDue.call(m, 't1', 39 * MIN);
    expect(raise).toHaveBeenCalledTimes(1);
    proto.pageTableAdmissionFailingIfDue.call(m, 't1', 40 * MIN);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('never pages a table that is not failing', () => {
    const raise = vi
      .spyOn(alerts, 'raiseFinancialAlert')
      .mockResolvedValue({ persisted: true, alertId: 'a' });
    proto.pageTableAdmissionFailingIfDue.call(probe(), 't1', 600 * MIN);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe('wiring', () => {
  const BASE = readFileSync(
    resolve(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
    'utf8'
  );
  const SERVER = readFileSync(resolve(process.cwd(), 'src/GameServer.ts'), 'utf8');
  it('every failed start and causal retry records its refusal, and every retry asks to page', () => {
    expect(BASE).toMatch(
      /reportError\(error, errorContext, metadata\);\n\s*if \(tableId\) this\.noteTableAdmissionRefusal\(tableId, error\);/
    );
    expect(BASE).toMatch(
      /this\.noteTableAdmissionRefusal\(tableId, error\);\n\s*reportError\(error, 'Tournament\.table_engine_causal_retry_failed'/
    );
    expect(BASE).toMatch(
      /if \(this\.tableEngineRecoveryTimers\.has\(tableId\)\) return;\n(\s*\/\/[^\n]*\n)*\s*this\.pageTableAdmissionFailingIfDue\(tableId\);/
    );
  });
  it('/health names the refusal beside each table failing admission', () => {
    expect(SERVER).toContain("admission: 'failing' as const,\n          refusal: t.refusal,");
    expect(SERVER).toContain('manager.getTableAdmissionRefusals?.()');
  });
});
