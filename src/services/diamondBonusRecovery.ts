import type { BonusGame, BonusStart } from './DiamondBonusService';
import { validSpinAmount, bonusTotal, PLINKO_DIAMONDS_PER_DROP } from '../utils/bonusGameBudget';
const key = (user: string, club: string, game: BonusGame) =>
  `diamond-spins-pending:${user}:${club}:${game}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function pendingBonus(user: string, club: string, game: BonusGame): BonusStart | null {
  const raw = sessionStorage.getItem(key(user, club, game));
  if (!raw) return null;
  const v = JSON.parse(raw) as BonusStart;
  if (
    !v ||
    v.clubId !== club ||
    v.game !== game ||
    !uuid.test(v.commitId) ||
    typeof v.seed !== 'string' ||
    !v.seed.length ||
    v.seed.length > 64 ||
    !v.budget ||
    !validSpinAmount(v.budget.base) ||
    typeof v.budget.doubled !== 'boolean' ||
    !PLINKO_DIAMONDS_PER_DROP.includes(v.budget.denomination as 1) ||
    bonusTotal(v.budget) % v.budget.denomination !== 0
  ) {
    throw new Error('The Saved Bonus Needs To Be Checked');
  }
  return v;
}
export function rememberBonus(user: string, input: BonusStart) {
  const prior = pendingBonus(user, input.clubId, input.game);
  if (prior && JSON.stringify(prior) !== JSON.stringify(input))
    throw new Error('Check Your Previous Bonus Before Starting Another');
  // If the request cannot be retained, stop before sending any money request.
  sessionStorage.setItem(key(user, input.clubId, input.game), JSON.stringify(input));
}
export function clearPendingBonus(user: string, input: BonusStart) {
  const prior = pendingBonus(user, input.clubId, input.game);
  if (prior?.commitId === input.commitId)
    sessionStorage.removeItem(key(user, input.clubId, input.game));
}
