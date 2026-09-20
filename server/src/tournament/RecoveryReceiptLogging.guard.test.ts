/** Recovery may report success only from an exact immutable receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const recovery = fs.readFileSync(
  path.join(process.cwd(), 'src/tournament/tournamentRecovery.ts'),
  'utf8'
);
const recover = sliceMethod(recovery, 'export async function recoverStuckCompletingTournaments(');
const receiptRpc = fs.readFileSync(
  path.join(process.cwd(), 'src/tournament/terminalSettlementRpc.ts'),
  'utf8'
);

describe('stuck-tournament recovery logs only receipt-backed settlement counts', () => {
  it('resolves a lost response behind the same terminal lock and validates its receipt', () => {
    expect(receiptRpc).toContain("rpc('fn_complete_tournament_terminal'");
    expect(receiptRpc).toContain("rpc('fn_resolve_tournament_terminal_outcome'");
    // The original request, resolver and stored-parameter replay remain
    // verified. External completion adoption adds its own fourth verification.
    expect(receiptRpc.match(/verifyTournamentCompletionReceipt\(/g)).toHaveLength(4);
    const adoption = sliceMethod(
      receiptRpc,
      'export async function readCommittedTournamentTerminalReceipt('
    );
    expect(adoption).toContain('verifyTournamentCompletionReceipt(');
    expect(adoption).toContain("rpc('fn_resolve_tournament_terminal_outcome'");
    expect(adoption).not.toContain("rpc('fn_complete_tournament_terminal'");
    expect(receiptRpc).toContain('terminal_committed === true');
    expect(receiptRpc).toContain('definitively_not_committed === true');
  });

  it('logs exact counts only after the verified receipt helper returns', () => {
    const terminalAttempt = sliceEnclosingBlock(
      recover,
      'const receipt = await requestTournamentTerminalReceipt('
    );
    const request = terminalAttempt.indexOf(
      'const receipt = await requestTournamentTerminalReceipt('
    );
    const log = terminalAttempt.indexOf('receipt.cashPayoutTotal', request);
    expect(request).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(request);
    expect(terminalAttempt).toMatch(/receipt\.bountyPayoutTotal/);
    expect(terminalAttempt).toMatch(/receipt\.tableClosure\.closedTableCount/);
  });

  it('never converts a failed receipt request into a status-only success', () => {
    expect(recover).toMatch(/error instanceof TerminalSettlementRefusedError/);
    expect(recover).toMatch(
      /reportUnknownRecoveryOutcome\(tournament, winnerId, reason, 'tournament', error\)/
    );
    expect(recover).not.toMatch(
      /durableCompletionAcceptedAfterLostReceipt|place\/payment counts unavailable/
    );
    expect(receiptRpc).not.toMatch(/\.from\(['"]tournaments['"]\)/);
  });
});
