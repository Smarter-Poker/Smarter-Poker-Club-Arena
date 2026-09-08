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
    '../../../supabase/migrations/20260908065210_tournament_cash_settlement_has_one_atomic_authority.sql'
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
    expect(failure).toContain(
      'const outcomeUnknown = settlementErr instanceof TerminalSettlementOutcomeUnknownError'
    );
    expect(failure).toContain('if (!outcomeUnknown) releaseFinishGuard()');
    expect(failure).toContain('if (outcomeUnknown) await this.stopAndWait()');
  });

  it('a failed bubble announcement cannot bypass mandatory postcommit shutdown', () => {
    const finish = code(sliceMethod(SOURCE, 'protected async finishTournament'));
    const bubble = finish.indexOf("await this.broadcast('bubble_protection_paid'");
    const contained = finish.indexOf(
      "reportError(broadcastErr, 'Tournament.bubble_protection_broadcast_failed')",
      bubble
    );
    const shutdown = finish.indexOf('for (const [tableId, engine] of this.tableEngines)', bubble);
    expect(bubble).toBeGreaterThan(-1);
    expect(contained).toBeGreaterThan(bubble);
    expect(shutdown).toBeGreaterThan(contained);
  });
});

describe('running-state bookkeeping cannot pay a place', () => {
  it('elimination stamps the prize preview but does not settle a place', () => {
    const eliminate = code(sliceMethod(SOURCE, 'protected async eliminatePlayer'));
    expect(eliminate).toMatch(/status:\s*'eliminated',[\s\S]*position,[\s\S]*prize,/);
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
    expect(deal).toMatch(/\[\.\.\.receipt\.dealShares\]\.sort\(\(a, b\) => a\.place - b\.place\)/);
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

  it('the immediate bubble door stays shut until the field and pool are final', () => {
    const eliminate = code(sliceMethod(SOURCE, 'protected async eliminatePlayer'));
    const bubbleCall = eliminate.indexOf("'fn_settle_tournament_bubble_protection'");
    expect(bubbleCall).toBeGreaterThan(-1);
    expect(eliminate.slice(0, bubbleCall)).toMatch(/this\.prizePoolFinalized/);
    expect(eliminate.slice(0, bubbleCall)).toMatch(
      /bubbleField !== undefined && bubbleField >= position[\s\S]*?\? resolvePayoutStructure\(tournament as any, bubbleField\)[\s\S]*?: null/
    );

    const start = SETTLEMENT.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_bubble_protection('
    );
    const end = SETTLEMENT.indexOf(
      'REVOKE ALL ON FUNCTION public.fn_settle_tournament_bubble_protection',
      start
    );
    const settleBubble = SETTLEMENT.slice(start, end).replace(/--.*$/gm, '');
    expect(settleBubble).toMatch(/t\.prize_pool_finalized/);
    expect(settleBubble).toMatch(
      /COALESCE\(v_t\.prize_pool_finalized, false\) IS NOT TRUE[\s\S]*?RAISE EXCEPTION/
    );
  });
});
