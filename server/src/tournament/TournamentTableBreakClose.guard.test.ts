import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const migrationsDir = join(process.cwd(), '..', 'supabase', 'migrations');
const closeMigrationNames = readdirSync(migrationsDir).filter((name) =>
  name.endsWith('_tournament_table_break_close_is_atomic.sql')
);
expect(closeMigrationNames).toHaveLength(1);
const migration = readFileSync(join(migrationsDir, closeMigrationNames[0]), 'utf8');
const manager = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManager.ts'),
  'utf8'
);

describe('a tournament table break closes durably before releasing process ownership', () => {
  it('ships one atomic, service-only exact-generation close transaction', () => {
    expect(migration.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(migration).toContain('public.fn_close_empty_tournament_table(');
    expect(migration).toContain('l.protocol_version = 2');
    expect(migration).toContain('l.lease_generation = p_lease_generation');
    expect(migration).toContain("l.heartbeat_at >= clock_timestamp() - interval '30 seconds'");
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.fn_close_empty_tournament_table');
    expect(migration).toContain('TO service_role;');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated;');
  });

  it('serializes both seat-first and close-first commit orders on the table row', () => {
    const parentAt = migration.indexOf(
      'FROM public.tournaments t',
      migration.indexOf('fn_close_empty_tournament_table')
    );
    const tableAt = migration.indexOf('FROM public.tables t', parentAt);
    const seatsAt = migration.indexOf('FROM public.table_seats s', tableAt);
    expect(parentAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(parentAt);
    expect(seatsAt).toBeGreaterThan(tableAt);
    expect(migration.slice(parentAt, tableAt)).toContain('FOR UPDATE');
    expect(migration.slice(tableAt, seatsAt)).toContain('FOR UPDATE');
    expect(migration.slice(seatsAt)).toContain('FOR UPDATE');

    // A rolling old engine still issues direct tables.status='closed'. Its
    // BEFORE trigger runs while that UPDATE owns the table row and rechecks
    // live seats. A concurrent seat takes the same table row FOR SHARE and
    // rechecks terminal status after waiting. Whichever commits first makes
    // the other side refuse; neither relies on a later sweep.
    expect(migration).toContain('CREATE TRIGGER ab_tournament_table_close_requires_empty');
    expect(migration).toContain('BEFORE UPDATE OF status, is_deleted ON public.tables');
    expect(migration).toContain("v_parent_status IN ('REGISTERING', 'RUNNING')");
    expect(migration).toContain('TOURNAMENT_TABLE_CLOSE_NOT_EMPTY');
    expect(migration).toContain('CREATE TRIGGER ab_refuse_live_seat_on_closed_tournament_table');
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF table_id, user_id, left_at ON public.table_seats'
    );
    expect(migration).toContain('FROM public.tables t');
    expect(migration).toContain('FOR SHARE;');
    expect(migration).toContain('TOURNAMENT_TABLE_CLOSED');
  });

  it('keeps the stopped generation registered until the durable close receipt and global CAS', () => {
    const close = sliceMethod(manager, 'protected async closeBrokenTableAndReleaseEngine(');
    const stopAt = close.indexOf('await engine.stop()');
    const rpcAt = close.indexOf("supabase.rpc('fn_close_empty_tournament_table'");
    const receiptAt = close.indexOf('const closed =');
    const unregisterAt = close.indexOf(
      'this.gameServer.unregisterTournamentTableEngine(tableId, engine)'
    );
    const localDeleteAt = close.indexOf('this.tableEngines.delete(tableId)');
    const hfhAt = close.indexOf('this.retireManagedTableFromHandForHand(tableId)');
    expect(stopAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(stopAt);
    expect(receiptAt).toBeGreaterThan(rpcAt);
    expect(unregisterAt).toBeGreaterThan(receiptAt);
    expect(localDeleteAt).toBeGreaterThan(unregisterAt);
    expect(hfhAt).toBeGreaterThan(localDeleteAt);
    expect(close.slice(rpcAt, unregisterAt)).toContain('if (!closed)');
  });

  it('retries a response-lost close from the retained empty table without direct writes', () => {
    const balance = sliceMethod(manager, 'protected async checkTableBalance()');
    expect(balance).toContain('if (bt.playerCount > 0 && breakMoves.length !== bt.playerCount)');
    expect(balance).toContain(
      'await this.visitTournamentBreakPage((state) => this.recoverTournamentBreak(state))'
    );
    const recover = sliceMethod(manager, 'protected async recoverTournamentBreak(');
    expect(recover).toContain('await this.reconcileTournamentBreak(state)');
    expect(recover).toContain('await this.retireTournamentBreak(current)');
    expect(balance).not.toContain(
      'await this.closeBrokenTableAndReleaseEngine(bt.tableId, engine)'
    );
    expect(balance).toContain('this.requestUrgentEliminationSweepAfter(');
    expect(balance).not.toContain(".update({ status: 'closed'");
  });
});
