import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const eliminations = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const terminalRpc = readFileSync(
  join(process.cwd(), 'src/tournament/terminalSettlementRpc.ts'),
  'utf8'
);
const checkDeal = sliceMethod(eliminations, 'checkFinalTableDeal(): Promise<boolean>');
const boundary = sliceMethod(
  eliminations,
  'completeFinalTableDealAtBoundary(\n    tableId: string,'
);
const dealTail = sliceMethod(
  eliminations,
  'settleFinalTableDeal(\n    receipt: VerifiedTournamentCompletionReceipt'
);

describe('a final-table deal completes only from the immutable terminal receipt', () => {
  it('parks and re-proves every mutable input before invoking the sole terminal writer', () => {
    const park = boundary.indexOf('parkForTerminalCloseout(');
    const roster = boundary.indexOf(".select('user_id, chips')", park);
    const votes = boundary.indexOf('this.readFinalTableDealConsensus(alive)', roster);
    const writer = boundary.indexOf('requestTournamentTerminalReceipt(', votes);
    const receiptProof = boundary.indexOf('receipt.dealShares.length === alive.length', writer);
    const tail = boundary.indexOf('return this.settleFinalTableDeal(receipt)', receiptProof);

    expect(park).toBeGreaterThanOrEqual(0);
    expect(roster).toBeGreaterThan(park);
    expect(votes).toBeGreaterThan(roster);
    expect(writer).toBeGreaterThan(votes);
    expect(receiptProof).toBeGreaterThan(writer);
    expect(tail).toBeGreaterThan(receiptProof);
    expect(boundary).toContain("'final_table_deal',");
    expect(boundary).toContain('throw new TerminalSettlementCommittedError');
  });

  it('serializes lost responses and validates the stored receipt before returning it', () => {
    expect(terminalRpc).toContain("rpc('fn_complete_tournament_terminal', request)");
    expect(terminalRpc).toContain("rpc('fn_resolve_tournament_terminal_outcome'");
    expect(terminalRpc).toContain('verifyTournamentCompletionReceipt(');
    expect(terminalRpc).toContain('throw new TerminalSettlementRefusedError(lastFailure)');
    expect(terminalRpc).toContain('throw new TerminalSettlementOutcomeUnknownError(');
  });

  it('services a committed cleanup retry before either in-memory completion latch', () => {
    const pending = checkDeal.indexOf('committedFinalTableDealCleanupPending');
    const cleanup = checkDeal.indexOf(
      'this.settleFinalTableDeal(this.committedFinalTableDealReceipt)',
      pending
    );
    const handled = checkDeal.indexOf('this.finalTableDealHandled || this.tournamentFinished');

    expect(pending).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(pending);
    expect(handled).toBeGreaterThan(cleanup);
  });

  it('keeps the post-commit tail free of payment, roster and table writes', () => {
    const code = blankNonCode(dealTail);

    expect(code).not.toMatch(
      /settleTournamentObligation|settleFinalTableDealAtomically|requestTournamentTerminalReceipt|\.rpc\(|\.insert\(|\.update\(|\.delete\(/
    );
    expect(code).not.toMatch(
      /\.from\('tournaments'\)|\.from\('tournament_players'\)|\.from\('table_seats'\)|\.from\('tables'\)/
    );
    expect(dealTail).toContain('receipt.dealShares');
    expect(dealTail).toContain('receipt.tableClosure.closedTableIds');
  });
});
