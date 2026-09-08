/**
 * A FINISH THAT DEADLOCKS IS RETRIED, AND A MANAGER THAT NEVER CAME BACK DOES
 * NOT HIDE THE ROW (2026-09-06).
 *
 * 15:01, 15:06, 15:07 UTC: three events paid their winners, settled rake, and
 * deadlocked on COMPLETING -> COMPLETED. finishTournament logged "left for
 * recoverStuckCompletingTournaments" and never returned; the manager stayed
 * registered; the watchdog skipped the row every pass because a manager
 * existed. Fifty minutes, two pager alerts on rows that were paid, one
 * operator with psql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPLETING_DWELL_MS,
  COMPLETING_MANAGED_GRACE_MS,
  managerHasOverstayed,
} from './completingDwell.js';

const here = dirname(fileURLToPath(import.meta.url));
const ELIM = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');
const TERMINAL = readFileSync(
  join(
    here,
    '../../../supabase/migrations/20260908065324_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

describe('the completion flip is part of the money transaction', () => {
  it('runtime has no independent completion write or retry helper', () => {
    const finish = ELIM.slice(ELIM.indexOf('protected async finishTournament'));
    expect(finish).toContain('requestTournamentTerminalReceipt(');
    expect(finish).not.toContain("status: 'COMPLETED'");
    expect(finish).not.toContain('COMPLETED_FLIP_ATTEMPTS');
    expect(finish).not.toContain('isTransientFlipError');
  });

  it('the database claims COMPLETING and completes exactly one row before storing the receipt', () => {
    const update = TERMINAL.indexOf("SET status = 'COMPLETED'");
    const count = TERMINAL.indexOf('IF v_rows <> 1 THEN', update);
    const receipt = TERMINAL.indexOf('INSERT INTO public.tournament_terminal_settlements', update);
    expect(update).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(update);
    expect(receipt).toBeGreaterThan(count);
    expect(TERMINAL.slice(update, count)).toMatch(/status::text,''\)\) = 'COMPLETING'/);
  });

  it('replay validates the stored receipt before any payer call', () => {
    const body = TERMINAL.slice(TERMINAL.indexOf('AS $complete_terminal$'));
    const replay = body.indexOf('tournament_terminal_settlements h');
    const firstPayer = body.indexOf('public.fn_settle_tournament_places(');
    expect(replay).toBeGreaterThan(-1);
    expect(firstPayer).toBeGreaterThan(replay);
    expect(body.slice(replay, firstPayer)).toContain(
      'RETURN public.fn_ca_tournament_terminal_receipt('
    );
  });
});

describe('a manager past the grace is the thing that is stuck', () => {
  it('the grace is two dwells - ten minutes', () => {
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(2 * COMPLETING_DWELL_MS);
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(10 * 60 * 1000);
  });

  it("a row first seen under ten minutes ago is still the manager's", () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS + 1, now)).toBe(false);
    expect(managerHasOverstayed(now, now)).toBe(false);
    expect(managerHasOverstayed(undefined, now)).toBe(false);
  });

  it('at ten minutes it is not', () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS, now)).toBe(true);
    expect(managerHasOverstayed(now - 50 * 60_000, now)).toBe(true);
  });

  it('the watchdog stops and drops the overstayed manager, then recovers through the same door', () => {
    /* The window is the loop body the guard lives in, not a byte count:
       tests/helpers/sourceWindow, and the publish outage its header records. */
    const loop = sliceEnclosingBlock(
      SERVER,
      'managerHasOverstayed(dwell.seenAt.get(String(stuck.id)), Date.now())'
    );
    expect(loop).toContain('lingering.stop();');
    expect(loop).toContain('this.tournamentEngines.delete(String(stuck.id));');
    expect(loop).toContain(
      "await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);"
    );
    // The drop happens BEFORE the has() test that gates recovery, so the
    // recovery that follows is the ordinary one.
    expect(loop.indexOf('this.tournamentEngines.delete(String(stuck.id));')).toBeLessThan(
      loop.indexOf('if (!this.tournamentEngines.has(stuck.id))')
    );
  });
});
