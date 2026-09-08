/**
 * NO RESULT WITHOUT A DURABLE WINNER.
 *
 * The old stuck-COMPLETING recovery tried to infer a podium from chip stacks
 * and hand history. Seven events received fabricated finishing orders through
 * that inference. Recovery now has no ranking authority: it may only replay a
 * finish whose single champion is already durable at position 1, while the
 * database derives and proves every payout place under one lock.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'tournamentRecovery.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
const recovery = source.slice(
  source.indexOf('export async function recoverStuckCompletingTournaments')
);
const receiptVerifier = readFileSync(join(__dirname, 'completionSettlementReceipt.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

describe('recovery has no authority to invent a result', () => {
  it('does not rank by chips or infer a result from hand history', () => {
    expect(recovery).not.toMatch(/chipsCannotRank|noHandWasEverDealt|hand_history/);
    expect(recovery).not.toMatch(/\.sort\(\(a, b\) => Number\(b\.chips/);
    expect(recovery).not.toMatch(/computePlacePrize|resolvePayoutStructure/);
  });

  it('requires exactly one durable winner at position 1', () => {
    expect(recovery).toMatch(/player\.status === 'winner' && Number\(player\.position\) === 1/);
    expect(recovery).toMatch(/durableChampions\.length !== 1 \|\| otherFirstPlaces\.length > 0/);
    expect(recovery).toMatch(/recoverStuckCompleting_durable_winner_absent/);
  });

  it('cannot stamp or reorder player finishes itself', () => {
    expect(recovery).not.toMatch(/\.from\('tournament_players'\)[\s\S]{0,240}?\.update\(/);
    expect(recovery).not.toMatch(/status:\s*place === 1 \? 'winner'/);
    expect(recovery).not.toMatch(/position:\s*place/);
  });
});

describe('recovery only replays an authoritative settlement receipt', () => {
  it('classifies every satellite marker before selecting a cash door', () => {
    expect(recovery).toMatch(/variant[^\n]*satellite/);
    expect(recovery).toMatch(/tournament_type[\s\S]{0,120}?SATELLITE/);
    expect(recovery).toMatch(
      /Boolean\([\s\S]{0,180}?satellite_target_id[\s\S]{0,180}?satellite_target/
    );
  });

  it('selects place or final-deal mode on the one terminal database door', () => {
    expect(recovery).toMatch(/fn_complete_tournament_terminal/);
    expect(recovery).toMatch(/isFinalTableDeal \? 'final_table_deal' : 'places'/);
    expect(recovery).not.toMatch(/settleTournamentObligation/);
  });

  it('requires complete, unique payout evidence containing the durable winner', () => {
    expect(recovery).toMatch(/verifyTournamentCompletionReceipt\(/);
    expect(receiptVerifier).toMatch(/receipt\.ok !== true/);
    expect(receiptVerifier).toMatch(/receipt\.fully_settled !== true/);
    expect(receiptVerifier).toMatch(/users\.has\(userId\)/);
    expect(receiptVerifier).toMatch(/places\.has\(place\)/);
    expect(receiptVerifier).toMatch(/payout\.place === 1 && payout\.userId === winnerId/);
  });
});
