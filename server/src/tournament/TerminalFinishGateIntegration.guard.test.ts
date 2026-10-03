/**
 * Pins the call site of the fix in terminalFinishGate.ts: the ordinary cash
 * finish must go through the in-process gate, and only that one call site -
 * never the disagreement/adoption path (which reads an existing receipt
 * rather than opening the finish lane), never the satellite path (a different
 * RPC family), and never the recovery tail (tournamentRecovery.ts already has
 * its own, separate, one-request-at-a-time shape and is out of this fix's
 * scope).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const ELIM = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const GATE = readFileSync(join(__dirname, 'terminalFinishGate.ts'), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the ordinary cash finish opens the terminal lane through the gate', () => {
  it('imports the gate and wraps exactly the places-settlement call with it', () => {
    expect(ELIM).toContain(
      "import { runInTerminalFinishGate } from './terminalFinishGate.js';"
    );
    const finish = code(sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>'));
    expect(finish).toMatch(
      /receipt = await runInTerminalFinishGate\(\(\) =>\s*requestTournamentTerminalReceipt\(this\.tournamentId, 'places', winnerId\)\s*\)/
    );
    // Exactly once: the gate protects the one call that opens the exclusive
    // finish lane, not every read of a receipt.
    expect(finish.match(/runInTerminalFinishGate\(/g)).toHaveLength(1);
  });

  it('never wraps the adopted-receipt replay, which reads a receipt rather than opening the lane', () => {
    // adoptStoredTerminalReceipt lives entirely in terminalSettlementRpc.ts and
    // is reached only from INSIDE requestTournamentTerminalReceipt (which the
    // gate already wraps as a whole) or from the disagreement catch branch,
    // neither of which opens a second, separate finish-lane call of its own.
    expect(GATE).not.toContain('adoptStoredTerminalReceipt');
    const RPC = readFileSync(join(__dirname, 'terminalSettlementRpc.ts'), 'utf8');
    expect(RPC).not.toContain('runInTerminalFinishGate');
  });

  it('never wraps the satellite settlement path', () => {
    const finish = code(sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>'));
    const satellite = finish.indexOf('if (isSatelliteFinish)');
    // The boundary of the satellite window is where the ordinary cash path's
    // OWN declaration begins - not inside its wrapped call, which itself
    // legitimately contains "runInTerminalFinishGate" a few lines later.
    const cashPathBegins = finish.indexOf(
      'let receipt: VerifiedTournamentCompletionReceipt',
      satellite
    );
    expect(cashPathBegins).toBeGreaterThan(satellite);
    expect(finish.slice(satellite, cashPathBegins)).not.toContain('runInTerminalFinishGate');
  });
});

describe('a gate timeout is a proven, transient refusal - never an unknown outcome', () => {
  it('TerminalFinishGateTimeoutError extends TerminalSettlementRefusedError', () => {
    expect(GATE).toContain(
      'class TerminalFinishGateTimeoutError extends TerminalSettlementRefusedError'
    );
  });

  it('carries the exact word classifyFinishRefusal and the database both use for a lock/statement timeout', () => {
    expect(GATE.toLowerCase()).toContain('canceling statement due to statement timeout');
  });

  it('the gate wait budget is well inside the scheduler stall-warning threshold', () => {
    // If the budget ever grew past the elimination scheduler's own stalled-
    // slot warning window, a contended gate would itself start reporting as a
    // stuck scheduler slot instead of failing fast and cheaply in Node.
    const match = GATE.match(/TERMINAL_FINISH_GATE_WAIT_MS = ([\d_]+)/);
    expect(match).not.toBeNull();
    const waitMs = Number((match as RegExpMatchArray)[1].replace(/_/g, ''));
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThan(60_000); // ELIMINATION_SWEEP_STUCK_MS (eliminationLock.ts)
    // And well inside the RPC's own 45s statement_timeout, so a gate timeout
    // fires before Postgres would have cancelled the statement anyway.
    expect(waitMs).toBeLessThan(45_000);
  });
});
