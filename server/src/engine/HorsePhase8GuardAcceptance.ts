import type { HorseDecision } from '../types.js';
import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
import { liveHorsePhase8GuardAuthority } from './HorseTournamentCatastropheGuardAuthority.js';
import {
  withdrawHorsePhase8GuardSelection,
  recordHorsePhase8GuardVerdict,
} from './HorseExecutionWitness.js';
/** Same-turn genuine authority check before the authoritative action door. */
export function recheckHorsePhase8GuardBeforeAcceptance(
  decision: HorseDecision,
  snapshot: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>
): HorseDecision {
  const ledger = decision.tournamentCatastropheGuard;
  if (!ledger?.applied) return decision;
  const gs = snapshot.gameState;
  const inDomain =
    gs.gameMode === 'tournament' &&
    gs.gameVariant === 'nlh' &&
    ['flop', 'turn', 'river'].includes(gs.stage) &&
    (gs.boardCount ?? 1) === 1 &&
    !gs.communityCards2?.length &&
    !gs.communityCards3?.length;
  const verdict = inDomain ? liveHorsePhase8GuardAuthority.check(ledger.authority) : 'mismatched';
  ledger.authorityVerdict = verdict;
  if (verdict === 'usable') {
    recordHorsePhase8GuardVerdict(decision.executionWitness, verdict);
    return decision;
  }
  withdrawHorsePhase8GuardSelection(decision.executionWitness, snapshot, verdict);
  ledger.applied = false;
  ledger.selection = 'withdrawn_before_acceptance';
  return { ...decision, action: ledger.baselineAction, amount: ledger.baselineAmount ?? undefined };
}
