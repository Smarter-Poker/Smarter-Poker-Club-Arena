/**
 * LAW: a cash tournament has one payer and one terminal receipt.
 *
 * Places may be displayed while play continues, but no elimination, late-reg
 * refresh, or final-deal presentation loop may move place money. The database
 * derives and settles the complete ladder while it owns the durable finish
 * transition. A missing or partial receipt leaves the manager retryable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SOURCE = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const SETTLEMENT = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);
const RECEIPT_VERIFIER = readFileSync(join(__dirname, 'completionSettlementReceipt.ts'), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the live cash finish has one authoritative payer', () => {
  it('sends only terminal mode, tournament identity, and the observed winner', () => {
    const finish = code(sliceMethod(SOURCE, 'protected async finishTournament'));
    expect(finish).toMatch(
      /requestTournamentTerminalReceipt\(\s*this\.tournamentId,\s*'places',\s*winnerId\s*\)/
    );
    expect(finish).not.toMatch(/fn_settle_tournament_obligation/);
    expect(finish).not.toMatch(/kind:\s*'place'/);
  });

  it('requires a complete terminal receipt and uses its winner amount', () => {
    const finish = code(sliceMethod(SOURCE, 'protected async finishTournament'));
    expect(finish).toMatch(
      /receipt = await requestTournamentTerminalReceipt\(\s*this\.tournamentId,\s*'places',\s*winnerId/
    );
    expect(finish).toMatch(/winnerPrize = receipt\.winnerAmount/);
  });

  it('releases only a proven refusal and stops on an ambiguous commit result', () => {
    const finish = code(sliceMethod(SOURCE, 'protected async finishTournament'));
    const failure = finish.slice(finish.indexOf('catch (settlementErr)'));
    expect(failure).toMatch(
      /const provenRefusal = settlementErr instanceof TerminalSettlementRefusedError;[\s\S]*const outcomeUnknown =[\s\S]*settlementErr instanceof TerminalSettlementOutcomeUnknownError \|\| !provenRefusal;/
    );
    expect(failure).toContain('if (provenRefusal) releaseFinishGuard()');
    expect(failure).toContain('if (!provenRefusal) await this.stopAndWait()');
  });

  it('a failed bubble announcement cannot bypass receipt-driven shutdown', () => {
    const cleanup = code(sliceMethod(SOURCE, 'private async cleanupCommittedTournament'));
    const delivery = code(sliceMethod(SOURCE, 'private async broadcastCommittedOutcome'));
    const bubble = cleanup.indexOf('await this.announceCommittedBubble(receipt)');
    const shutdown = cleanup.indexOf('cleanupCommittedTablesAndManager(', bubble);
    expect(delivery).toContain('catch (error)');
    expect(delivery).toContain('return false');
    expect(bubble).toBeGreaterThan(-1);
    expect(shutdown).toBeGreaterThan(bubble);
  });
});

describe('running-state bookkeeping cannot pay a place', () => {
  it('elimination gives the atomic roster owner a prize preview but does not settle a place', () => {
    const eliminate = code(sliceMethod(SOURCE, 'protected async eliminatePlayer'));
    expect(eliminate).toContain("'fn_eliminate_tournament_player_atomic'");
    expect(eliminate).toMatch(/p_position:\s*position,[\s\S]*p_prize:\s*prize/);
    expect(eliminate).not.toMatch(/kind:\s*'place'/);
    expect(eliminate).not.toMatch(/kind:\s*'late_reg_adjustment'/);
  });

  it('late-reg recalculation updates only the displayed prize', () => {
    const recalc = code(sliceMethod(SOURCE, 'protected async recalculateEliminatedPrizes'));
    expect(recalc).toMatch(/update\(\{ prize:\s*correctPrize \}\)/);
    expect(recalc).not.toMatch(/settleTournamentObligation/);
    expect(recalc).not.toMatch(/\.rpc\(/);
  });

  it('final-deal closeout consumes payout evidence without paying it again', () => {
    const deal = code(sliceMethod(SOURCE, 'private async settleFinalTableDeal'));
    expect(deal).toMatch(/receipt:\s*VerifiedTournamentCompletionReceipt/);
    expect(deal).toMatch(
      /\[\.\.\.receipt\.dealShares\]\s*\.sort\(\(a, b\) => a\.place - b\.place\)/
    );
    expect(deal).not.toMatch(/Number\(b\.chips\)/);
    expect(deal).not.toMatch(/\.from\('tournament_players'\)[\s\S]{0,240}?\.update\(/);
    expect(deal).not.toMatch(/settleTournamentObligation/);
    expect(deal).not.toMatch(/fn_credit_and_log/);
    expect(deal).not.toMatch(/fn_settle_tournament_obligation/);
  });
});

describe('terminal means complete, not merely ok', () => {
  it('accepts only a fully settled COMPLETED receipt with empty escrow and attributed rake', () => {
    const terminal = code(RECEIPT_VERIFIER);
    expect(terminal).toMatch(/receipt\.ok !== true/);
    expect(terminal).toMatch(/receipt\.fully_settled !== true/);
    expect(terminal).toMatch(/receipt\.status !== 'COMPLETED'/);
    expect(terminal).toMatch(/prizeBalance !== 0/);
    expect(terminal).toMatch(/bountyBalance !== 0/);
    expect(terminal).toMatch(/feeBalance !== 0/);
    expect(terminal).toMatch(/rake\.attributed !== true/);
    expect(terminal).toMatch(/receipt\.deal_shares/);
    expect(terminal).toMatch(/receipt\.table_closure/);
  });

  it('a malformed or partial final-deal receipt releases both local guards', () => {
    const poll = code(sliceMethod(SOURCE, 'protected async checkFinalTableDeal'));
    const boundary = code(sliceMethod(SOURCE, 'private async completeFinalTableDealAtBoundary'));
    expect(boundary).toContain('if (!payoutShapeIsExact)');
    expect(poll).toContain('engine.releaseTerminalCloseoutPause()');
    expect(poll).toMatch(
      /catch \(err\) \{[\s\S]*this\.finalTableDealHandled = false;[\s\S]*this\.tournamentFinished = false;/
    );
    expect(poll).toContain('err instanceof TerminalSettlementOutcomeUnknownError');
    expect(poll).toContain('err instanceof TerminalSettlementCommittedError');
  });

  it('the deal poll rejects every satellite marker before the cash RPC', () => {
    const poll = code(sliceMethod(SOURCE, 'protected async checkFinalTableDeal'));
    const launch = poll.indexOf('completeFinalTableDealAtBoundary');
    expect(launch).toBeGreaterThan(0);
    expect(poll.slice(0, launch)).toMatch(/variant[\s\S]*=== 'satellite'/);
    expect(poll.slice(0, launch)).toMatch(/tournament_type[\s\S]*=== 'SATELLITE'/);
    expect(poll.slice(0, launch)).toMatch(
      /Boolean\(t\.satellite_target_id \|\| t\.satellite_target\)/
    );
    expect(poll.slice(0, launch)).toMatch(/if \(isSatelliteDeal\) return/);
    expect(code(sliceMethod(SOURCE, 'private async completeFinalTableDealAtBoundary'))).toMatch(
      /requestTournamentTerminalReceipt\(\s*this\.tournamentId,\s*'final_table_deal',\s*null\s*\)/
    );
  });
});

describe('a terminal cash receipt proves every presentation cache', () => {
  it('rejects a completed replay whose bubble prize cache is stale', () => {
    const start = SETTLEMENT.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places('
    );
    const end = SETTLEMENT.indexOf(
      'REVOKE ALL ON FUNCTION public.fn_settle_tournament_places',
      start
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const settle = SETTLEMENT.slice(start, end).replace(/--.*$/gm, '');

    expect(settle).toMatch(
      /v_status\s*=\s*'COMPLETED'[\s\S]*?tp\.prize IS NOT DISTINCT FROM v_bubble_amount/
    );
    expect(settle).toMatch(/post-settlement bubble prize-cache proof failed/);
  });

  it('the application has no immediate bubble payer before terminal settlement', () => {
    const eliminate = code(sliceMethod(SOURCE, 'protected async eliminatePlayer'));
    const finish = code(sliceMethod(SOURCE, 'protected async finishTournament'));
    expect(eliminate).not.toContain('fn_settle_tournament_bubble_protection');
    expect(eliminate).not.toContain('bubble_protection_paid');
    expect(finish).toContain('requestTournamentTerminalReceipt(');
    expect(code(sliceMethod(SOURCE, 'private async announceCommittedBubble'))).toContain(
      "broadcastCommittedOutcome('bubble_protection_paid'"
    );
  });
});
