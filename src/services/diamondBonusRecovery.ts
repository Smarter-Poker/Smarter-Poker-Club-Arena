import type { BonusGame, BonusStart } from './DiamondBonusService';
import { validBonusBudget, bonusTotal } from '../utils/bonusGameBudget';
import { reportError } from '../utils/errorReporter';
const key = (user: string, club: string, game: BonusGame) =>
  `diamond-spins-pending:${user}:${club}:${game}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** The saved wager for this player, club and game, or null.
 *
 * A saved wager that cannot be replayed (unreadable, or not the shape this
 * client sends) is discarded, not thrown: the server keeps every round it
 * opened and the page reads it back from there, while a thrown save left the
 * page saying "could not be loaded" on every visit for the life of the tab. */
export function pendingBonus(user: string, club: string, game: BonusGame): BonusStart | null {
  const raw = sessionStorage.getItem(key(user, club, game));
  if (!raw) return null;
  let v: BonusStart;
  try {
    v = JSON.parse(raw) as BonusStart;
  } catch (error) {
    reportError(error, 'diamondBonusRecovery.unreadable');
    sessionStorage.removeItem(key(user, club, game));
    return null;
  }
  if (
    !v ||
    v.clubId !== club ||
    v.game !== game ||
    !uuid.test(v.commitId) ||
    (v.serverSeedHash !== undefined &&
      (typeof v.serverSeedHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.serverSeedHash))) ||
    typeof v.seed !== 'string' ||
    !v.seed.length ||
    v.seed.length > 64 ||
    !v.budget ||
    !validBonusBudget(v.budget) ||
    typeof v.budget.doubled !== 'boolean' ||
    // A saved request keeps the drop value it was sent with, so a completed game
    // from before ten drops became the one setting still replays its receipt.
    !Number.isSafeInteger(v.budget.denomination) ||
    v.budget.denomination < 1 ||
    bonusTotal(v.budget) % v.budget.denomination !== 0
  ) {
    reportError(new Error('The Saved Bonus Could Not Be Replayed'), 'diamondBonusRecovery.shape');
    sessionStorage.removeItem(key(user, club, game));
    return null;
  }
  return v;
}
/** A different wager is already saved for this player, club and game (another
 * tab, or a press that outran its own replay). It carries that wager so the
 * page can settle it first, by itself. */
export class PriorBonusPending extends Error {
  constructor(readonly prior: BonusStart) {
    super('Settling Your Previous Bonus First');
  }
}
export function rememberBonus(user: string, input: BonusStart) {
  const prior = pendingBonus(user, input.clubId, input.game);
  if (prior && JSON.stringify(prior) !== JSON.stringify(input)) throw new PriorBonusPending(prior);
  // Never invent a commitment for an older saved wager. Replay its exact request,
  // but require the displayed commitment before accepting any fresh wager.
  if (!prior && !/^[a-f0-9]{64}$/.test(input.serverSeedHash ?? ''))
    throw new Error('Prepare A Sealed Game Ticket Before Starting');
  // If the request cannot be retained, stop before sending any money request.
  sessionStorage.setItem(key(user, input.clubId, input.game), JSON.stringify(input));
}
export function clearPendingBonus(user: string, input: BonusStart) {
  const prior = pendingBonus(user, input.clubId, input.game);
  if (prior?.commitId === input.commitId)
    sessionStorage.removeItem(key(user, input.clubId, input.game));
}
