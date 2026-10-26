/** Original-state helpers shared by review, reference and live correction code.
 * Kept free of journal storage so the decision path never loads node:sqlite. */
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
import type { CorrectiveAction } from './contract.js';
import { evidenceDigest } from './authority.js';
import { chipCents } from './eligibility.js';

export function correctiveUtilityContextDigest(snapshot: FastHorseDecisionRequest): string {
  return evidenceDigest({
    gameMode: snapshot.gameState.gameMode ?? null,
    format: snapshot.gameState.format ?? null,
    tournament: snapshot.gameState.tournament ?? null,
    rakeConfig: snapshot.gameState.rakeConfig ?? null,
    bigBlind: snapshot.gameState.bigBlind,
  });
}

/** Uses the original controller-supplied legal menu/price/bounds. It never
 * substitutes current reads or converts a raise-to amount into an increment. */
export function correctiveActionIsLegal(
  snapshot: FastHorseDecisionRequest,
  choice: CorrectiveAction
): boolean {
  if (
    !choice ||
    typeof choice !== 'object' ||
    Object.keys(choice).sort().join(',') !== 'action,amount'
  )
    return false;
  const s = snapshot.gameState,
    p = snapshot.player;
  const amount = chipCents(choice?.amount),
    stack = chipCents(p?.stack),
    bet = chipCents(p?.bet),
    call = chipCents(s?.toCall);
  if (
    s?.stateSchemaVersion !== 1 ||
    !Array.isArray(s.legalActions) ||
    !s.legalActions.includes(choice?.action) ||
    amount === null ||
    stack === null ||
    bet === null ||
    call === null
  )
    return false;
  if (choice.action === 'fold') return amount === 0;
  if (choice.action === 'check') return amount === 0 && call === 0;
  if (choice.action === 'call') return call > 0 && amount === Math.min(call, stack);
  const maximum = chipCents(s.maxRaiseTo),
    minimum = chipCents(s.minRaiseTo);
  if (choice.action === 'all_in')
    return amount === stack + bet && (maximum === null || amount <= maximum);
  return (
    (choice.action === 'bet' || choice.action === 'raise') &&
    minimum !== null &&
    maximum !== null &&
    amount >= minimum &&
    amount <= maximum &&
    amount <= stack + bet
  );
}
