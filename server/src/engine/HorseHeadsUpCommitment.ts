import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';

/** The existing low-SPR policy may risk only money its sole opponent can match.
 * This qualification is deliberately cash NLH only: tournament survival,
 * multiway side pots, capped PLO wagers and all-in-only fields retain their
 * existing policy. Missing canonical action rights never create a wager. */
export function headsUpCashCommitment(
  hero: SeatPlayer,
  gs: HorseGameStateV2
): { exposure: number; wager: HorseDecision } | null {
  if (
    gs.stateSchemaVersion !== 1 ||
    gs.gameMode !== 'cash' ||
    gs.gameVariant !== 'nlh' ||
    gs.bettingStructure !== 'no_limit' ||
    gs.bombPot === true ||
    (gs.boardCount ?? 1) !== 1 ||
    (gs.communityCards2?.length ?? 0) > 0 ||
    (gs.communityCards3?.length ?? 0) > 0 ||
    !gs.legalActions?.includes('call') ||
    !Number.isFinite(gs.toCall) ||
    gs.toCall! <= 0 ||
    !Number.isFinite(gs.currentBet) ||
    gs.currentBet <= hero.bet
  )
    return null;
  const opponents = gs.players.filter(
    (p) => p.seat !== hero.seat && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
  );
  if (opponents.length !== 1) return null;
  const opponent = opponents[0];
  if (opponent.is_all_in || opponent.is_sitting_out || !(opponent.stack > 0)) return null;
  if (
    ![hero.stack, hero.bet, opponent.stack, opponent.bet].every((n) => Number.isFinite(n) && n >= 0)
  )
    return null;
  const unit = gs.chipUnit ?? (gs.asset === 'diamonds' ? 1 : 0.01);
  if (unit !== 0.01 && unit !== 1) return null;
  const cap = Number.isFinite(gs.commitmentCapRemaining)
    ? Math.max(0, gs.commitmentCapRemaining!)
    : hero.stack;
  const exposure = Math.min(hero.stack, cap, Math.max(0, opponent.stack + opponent.bet - hero.bet));
  const call: HorseDecision = {
    action: 'call',
    amount: Math.min(gs.toCall!, hero.stack),
    thinkTime: 0,
  };
  if (exposure <= call.amount!) return { exposure, wager: call };
  if (exposure >= hero.stack && gs.legalActions.includes('all_in')) {
    return { exposure, wager: { action: 'all_in', thinkTime: 0 } };
  }
  if (
    !gs.legalActions.includes('raise') ||
    !Number.isFinite(gs.minRaiseTo) ||
    !Number.isFinite(gs.maxRaiseTo) ||
    gs.minRaiseTo! <= gs.currentBet ||
    gs.maxRaiseTo! < gs.minRaiseTo!
  )
    return { exposure, wager: call };
  // A covering player cannot submit the short opponent's under-minimum
  // all-in amount. In heads-up NLH the minimum full raise is legal and its
  // unmatched excess is returned by the controller; never shove the surplus.
  const target = Number(
    (
      Math.ceil((Math.max(hero.bet + exposure, gs.minRaiseTo!) - unit * 1e-8) / unit) * unit
    ).toFixed(2)
  );
  const max = Math.min(gs.maxRaiseTo!, hero.bet + hero.stack, hero.bet + cap);
  if (target > max + 1e-8 || target <= gs.currentBet) return { exposure, wager: call };
  return { exposure, wager: { action: 'raise', amount: target, thinkTime: 0 } };
}
