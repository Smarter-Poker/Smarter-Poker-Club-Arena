/**
 * A terminal replay that disagrees with the stored receipt is not retried.
 *
 * Measured in the postgres logs on 2026-09-10 (05:40-06:23 UTC):
 * fn_complete_tournament_terminal raised 40001 'terminal replay parameters
 * disagree with stored receipt' 2,236 times for b6e2333f (NLH Heads-Up 100),
 * 1,621 times for 744bac40 and 1,718 times for 7264e9bf (both spins), at up to
 * 100 calls a second, each burst starting 11-14 s after the receipt had
 * committed and ending only when the manager was fenced. The database compares
 * exactly two things against the receipt (settlement_mode and winner_id); the
 * engine's later request carried a different winner because, once the champion
 * is 'winner' rather than 'playing', the zero-live-players branch elected the
 * last eliminated player. Then the RPC helper replayed that refusal as if the
 * response had been lost.
 *
 * Behaviour is pinned in terminalSettlementRpc.test.ts. These guards pin the
 * call sites: adoption over argument, one alert, stand down, no re-arm.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
/** Strip comments only; string literals stay so a guard can pin an alert name. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const ELIM = read('TournamentManagerEliminations.ts');
const RPC = read('terminalSettlementRpc.ts');
const RECOVERY = read('tournamentRecovery.ts');
const finish = code(sliceMethod(ELIM, 'finishTournament(winnerId: string): Promise<void>'));

describe('the RPC helper adopts the receipt instead of replaying the refusal', () => {
  it('checks for the disagreement inside the attempt loop, before any wait or resolver', () => {
    const loop = RPC.indexOf('for (let attempt = 1; attempt <= attempts; attempt++)');
    const check = RPC.indexOf('if (isTerminalReplayDisagreement(error))', loop);
    const adopt = RPC.indexOf('return adoptStoredTerminalReceipt(', check);
    const wait = RPC.indexOf('if (attempt < attempts) await wait(', check);
    const resolver = RPC.indexOf("supabase.rpc('fn_resolve_tournament_terminal_outcome'", loop);
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(loop);
    expect(adopt).toBeGreaterThan(check);
    expect(adopt).toBeLessThan(wait);
    expect(adopt).toBeLessThan(resolver);
  });

  it('reads the stored receipt and replays with ITS mode and winner, bounded', () => {
    const adopt = sliceMethod(RPC, 'async function adoptStoredTerminalReceipt(');
    expect(adopt).toContain("from('tournament_terminal_settlements')");
    expect(adopt).toContain("select('settlement_mode, winner_id')");
    expect(adopt).toMatch(
      /p_observed_winner_id: stored\.winnerId,\s*p_settlement_mode: stored\.settlementMode/
    );
    expect(adopt).toContain('for (let attempt = 1; attempt <= attempts; attempt++)');
    expect(adopt).toContain('throw new TerminalSettlementDisagreementError(');
    // The bound is a constant of the helper, never something a caller can
    // raise into a loop.
    expect(RPC).toMatch(/Math\.min\(5, Math\.trunc\(options\.receiptReadAttempts \?\? 3\)\)/);
  });

  it('recognises exactly the two database texts and nothing broader', () => {
    expect(RPC).toContain('/terminal (?:replay|outcome) parameters disagree with stored receipt/i');
  });
});

describe('the live finish records one disagreement and stands down', () => {
  it('handles the disagreement before the refusal/unknown split and never re-arms', () => {
    const failure = finish.slice(finish.indexOf('catch (settlementErr)'));
    const disagreement = failure.indexOf(
      'settlementErr instanceof TerminalSettlementDisagreementError'
    );
    const split = failure.indexOf('const provenRefusal =');
    expect(disagreement).toBeGreaterThanOrEqual(0);
    expect(disagreement).toBeLessThan(split);

    const branch = failure.slice(disagreement, split);
    expect(branch).toContain('await this.reportTerminalReceiptDisagreement(settlementErr)');
    expect(branch).toContain(
      "this.fenceUnknownTerminalOutcome('Tournament.atomic_finish_disagreement_stop_failed')"
    );
    expect(branch).toMatch(/return;/);
    expect(branch).not.toContain('releaseFinishGuard');
    expect(branch).not.toContain('requestUrgentEliminationSweepAfter');
  });

  it('raises one critical alert that names the tournament and both parameter sets', () => {
    const report = code(sliceMethod(ELIM, 'private async reportTerminalReceiptDisagreement('));
    expect(report).toContain("'Tournament.atomic_finish_receipt_disagreement'");
    expect(report.match(/raiseFinancialAlert\(/g)).toHaveLength(1);
    expect(report).toContain("'critical'");
    expect(report).toContain('tournament_id: this.tournamentId');
    expect(report).toContain('observed_winner_id: error.observed.winnerId');
    expect(report).toContain('stored_winner_id: error.stored?.winnerId ?? null');
    expect(report).toContain('observed_settlement_mode: error.observed.settlementMode');
    expect(report).toContain('stored_settlement_mode: error.stored?.settlementMode ?? null');
    expect(report).not.toMatch(/\.rpc\(|\.update\(|\.insert\(/);
  });

  it('continues from an adopted receipt and says so once, without touching money', () => {
    const committed = finish.indexOf('this.committedFinishReceipt = receipt;');
    const compare = finish.indexOf('receipt.winnerId.toLowerCase() !== winnerId.toLowerCase()');
    const report = finish.indexOf('await this.reportAdoptedTerminalReceipt(winnerId, receipt)');
    const cleanup = finish.indexOf('await this.cleanupCommittedTournament(receipt)');
    expect(committed).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(committed);
    expect(report).toBeGreaterThan(compare);
    expect(cleanup).toBeGreaterThan(report);

    const adopted = code(sliceMethod(ELIM, 'private async reportAdoptedTerminalReceipt('));
    expect(adopted).toContain("'Tournament.atomic_finish_receipt_adopted'");
    expect(adopted).toContain("'warning'");
    expect(adopted).not.toMatch(/\.rpc\(|\.update\(|\.insert\(|requestTournamentTerminalReceipt/);
  });
});

describe('the sweep asks for the durable winner before electing the last bust', () => {
  it('queries status winner / position 1 before the eliminated_at fallback', () => {
    const sweep = code(sliceMethod(ELIM, 'private async runEliminationSweep('));
    const zeroLive = sweep.indexOf('(remainingCount || 0) === 0');
    const durable = sweep.indexOf(".eq('status', 'winner')", zeroLive);
    const position = sweep.indexOf(".eq('position', 1)", durable);
    const durableFinish = sweep.indexOf(
      'await this.finishTournament(durableWinner.user_id)',
      position
    );
    const lastBust = sweep.indexOf(".eq('status', 'eliminated')", durableFinish);
    const lastBustFinish = sweep.indexOf(
      'await this.finishTournament(lastEliminated.user_id)',
      lastBust
    );
    expect(zeroLive).toBeGreaterThanOrEqual(0);
    expect(durable).toBeGreaterThan(zeroLive);
    expect(position).toBeGreaterThan(durable);
    expect(durableFinish).toBeGreaterThan(position);
    expect(lastBust).toBeGreaterThan(durableFinish);
    expect(lastBustFinish).toBeGreaterThan(lastBust);
    // An unreadable durable-winner row is UNKNOWN: retry later, never fall
    // through to the last-bust election on the strength of a failed read.
    const unreadable = sweep.slice(durable, durableFinish);
    expect(unreadable).toContain("'Tournament.finish_durable_winner_unreadable'");
    expect(unreadable).toMatch(/requestUrgentEliminationSweepAfter\([\s\S]*?\);\s*return;/);
  });
});

describe('recovery records a disagreement as final, not as an unknown outcome', () => {
  it('routes the disagreement to its own single alert', () => {
    const recovery = code(RECOVERY);
    const refused = recovery.indexOf('error instanceof TerminalSettlementRefusedError');
    const disagreement = recovery.indexOf(
      'error instanceof TerminalSettlementDisagreementError',
      refused
    );
    const own = recovery.indexOf('await reportRecoveryReceiptDisagreement(', disagreement);
    const unknown = recovery.indexOf('await reportUnknownRecoveryOutcome(', disagreement);
    expect(refused).toBeGreaterThanOrEqual(0);
    expect(disagreement).toBeGreaterThan(refused);
    expect(own).toBeGreaterThan(disagreement);
    expect(unknown).toBeGreaterThan(own);

    const report = code(sliceMethod(RECOVERY, 'async function reportRecoveryReceiptDisagreement('));
    expect(report).toContain("'Tournament.recovery_terminal_receipt_disagreement'");
    expect(report.match(/raiseFinancialAlert\(/g)).toHaveLength(1);
    expect(report).not.toMatch(/\.rpc\(|\.update\(|\.insert\(|requestTournamentTerminalReceipt/);
  });
});
