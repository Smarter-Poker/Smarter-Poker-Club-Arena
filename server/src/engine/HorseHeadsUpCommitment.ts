import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';

/** The existing low-SPR policy may risk only money its sole opponent can match.
 * This qualification is cash NLH and high-only PLO4/5/6: tournament survival,
 * multiway side pots, binding commitment caps and all-in-only fields retain their
 * existing policy. Missing canonical action rights never create a wager. */
export function headsUpCashCommitment(
  hero: SeatPlayer,
  gs: HorseGameStateV2
): { exposure: number; wager: HorseDecision } | null {
  const potLimit = ['plo4', 'plo5', 'plo6'].includes(gs.gameVariant ?? '');
  if (
    gs.stateSchemaVersion !== 1 ||
    gs.gameMode !== 'cash' ||
    (!(gs.gameVariant === 'nlh' && gs.bettingStructure === 'no_limit') &&
      !(potLimit && gs.bettingStructure === 'pot_limit')) ||
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
  // Binding whole-hand caps need separate qualification. In particular a cap
  // below the call removes CALL in the producer; a contradictory supplied
  // tuple must not masquerade as a zero-risk commitment opportunity.
  if (
    gs.commitmentCapRemaining != null &&
    (!Number.isFinite(gs.commitmentCapRemaining) || gs.commitmentCapRemaining < hero.stack - 1e-8)
  )
    return null;
  const exposure = Math.min(hero.stack, Math.max(0, opponent.stack + opponent.bet - hero.bet));
  const effectiveCall = Math.min(gs.toCall!, hero.stack);
  if (
    exposure < effectiveCall - 1e-8 ||
    Math.abs(effectiveCall - Math.min(gs.currentBet - hero.bet, hero.stack)) > 1e-8
  )
    return null;
  const call: HorseDecision = {
    action: 'call',
    amount: effectiveCall,
    thinkTime: 0,
  };
  if (exposure <= call.amount!) return { exposure, wager: call };
  // A short under-minimum stack has no sized interval. Price its physical
  // all-in against the controller's raw pot ceiling, never contestablePot.
  const potCeiling = potLimit ? hero.bet + gs.pot + 2 * effectiveCall : Infinity;
  if (potLimit && (!Number.isFinite(gs.pot) || gs.pot < 0)) return null;
  if (
    exposure >= hero.stack &&
    gs.legalActions.includes('all_in') &&
    hero.bet + hero.stack <= Math.min(gs.maxRaiseTo ?? Infinity, potCeiling) + 1e-8
  ) {
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
  // all-in amount. In heads-up play the minimum full raise is legal and its
  // unmatched excess is returned by the controller; never shove the surplus.
  const wanted = Number(
    (
      Math.ceil((Math.max(hero.bet + exposure, gs.minRaiseTo!) - unit * 1e-8) / unit) * unit
    ).toFixed(2)
  );
  const max = Number(
    (
      Math.floor(
        (Math.min(gs.maxRaiseTo!, hero.bet + hero.stack, potCeiling) + unit * 1e-8) / unit
      ) * unit
    ).toFixed(2)
  );
  // PLO may reach only the canonical pot ceiling on this action. A bounded
  // raise expresses that intent directly rather than relying on all-in clamp.
  const target = potLimit ? Math.min(wanted, max) : wanted;
  if (target < gs.minRaiseTo! - 1e-8 || target > max + 1e-8 || target <= gs.currentBet)
    return { exposure, wager: call };
  return { exposure, wager: { action: 'raise', amount: target, thinkTime: 0 } };
}
