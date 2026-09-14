/**
 * A FINISH IS A DATABASE CERTIFICATE, AND A MANAGER THAT NEVER CAME BACK DOES
 * NOT HIDE THE ROW (2026-09-07).
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
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPLETING_DWELL_MS,
  COMPLETING_MANAGED_GRACE_MS,
  managerHasOverstayed,
} from './completingDwell.js';

const here = dirname(fileURLToPath(import.meta.url));
const ELIM = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const RECOVERY = readFileSync(join(here, 'tournamentRecovery.ts'), 'utf8');
const TERMINAL_RPC = readFileSync(join(here, 'terminalSettlementRpc.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

describe('the finish boundary is owned by one database contract', () => {
  it('submits one observed winner and runs only receipt-backed cleanup', () => {
    const finish = sliceMethod(ELIM, 'protected async finishTournament(winnerId: string)');
    const settle = finish.indexOf(
      "requestTournamentTerminalReceipt(this.tournamentId, 'places', winnerId)"
    );
    const remember = finish.indexOf('this.committedFinishReceipt = receipt', settle);
    const cleanup = finish.indexOf('await this.cleanupCommittedTournament(receipt)', remember);

    expect(settle).toBeGreaterThanOrEqual(0);
    expect(remember).toBeGreaterThan(settle);
    expect(cleanup).toBeGreaterThan(remember);
    expect(finish).not.toMatch(
      /claimTournamentFinish|settleTournamentPlacesAtomically|settleTournamentRake|applyPrizeGuarantee/
    );
    expect(finish).not.toMatch(/\.from\('tournaments'\)[\s\S]*?status:\s*'COMPLETED'/);
  });

  it('the deal and every recovery tail use that same receipt contract', () => {
    const dealCheck = sliceMethod(ELIM, 'protected async checkFinalTableDeal()');
    const dealBoundary = sliceMethod(ELIM, 'private async completeFinalTableDealAtBoundary(');
    const dealTail = sliceMethod(ELIM, 'private async settleFinalTableDeal(');
    expect(dealCheck).toContain('completeFinalTableDealAtBoundary(');
    expect(dealBoundary).toContain(
      "requestTournamentTerminalReceipt(\n      this.tournamentId,\n      'final_table_deal',\n      null"
    );
    expect(dealBoundary.indexOf('requestTournamentTerminalReceipt(')).toBeLessThan(
      dealBoundary.indexOf('return this.settleFinalTableDeal(receipt)')
    );
    expect(dealTail).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
    expect(RECOVERY.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(RECOVERY.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(RECOVERY).not.toMatch(
      /claimTournamentFinish|settleTournamentPlacesAtomically|settleTournamentObligation/
    );
    expect(RECOVERY).not.toMatch(/\.update\(\{\s*status:\s*'COMPLETED'/);
  });

  it('replays one request after transport loss, then resolves behind the same lock', () => {
    const request = TERMINAL_RPC.indexOf('const request = {');
    const attempts = TERMINAL_RPC.indexOf('for (let attempt = 1;', request);
    const settle = TERMINAL_RPC.indexOf(
      "supabase.rpc('fn_complete_tournament_terminal', request)",
      attempts
    );
    const resolve = TERMINAL_RPC.indexOf(
      "supabase.rpc('fn_resolve_tournament_terminal_outcome'",
      settle
    );
    const committed = TERMINAL_RPC.indexOf('outcome.terminal_committed === true', resolve);
    const provenMiss = TERMINAL_RPC.indexOf(
      'outcome.definitively_not_committed === true',
      committed
    );
    const unknown = TERMINAL_RPC.indexOf('new TerminalSettlementOutcomeUnknownError(', provenMiss);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(attempts).toBeGreaterThan(request);
    expect(settle).toBeGreaterThan(attempts);
    expect(resolve).toBeGreaterThan(settle);
    expect(committed).toBeGreaterThan(resolve);
    expect(provenMiss).toBeGreaterThan(committed);
    expect(unknown).toBeGreaterThan(provenMiss);
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
    expect(loop).toContain('this.retireTournamentManagerInDiscovery(');
    expect(loop).toContain("'GameServer.completing_manager_stop_failed'");
    expect(loop).toContain(
      "await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);"
    );
    // Schedule the exact identity-CAS teardown while retaining ownership.
    // Recovery only enters on a pass that observes its completed release.
    expect(loop.indexOf('this.retireTournamentManagerInDiscovery(')).toBeLessThan(
      loop.indexOf('if (!this.tournamentEngines.has(stuck.id))')
    );
  });
});
