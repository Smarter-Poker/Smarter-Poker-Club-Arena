/**
 * PLO4 / PLO5 / PLO6 PAIRED-BOARD FOLD (Dan 2026-10-25, BINDING).
 *
 * Dan, verbatim, on a PLO5 1/2 Madness hand where a horse held Q-Q-T-7-6 on
 * 6h 7c Jd, the Jack paired the board on the turn, a human shoved and the
 * horse called off 190 chips with two pair:
 *   "HE CALLED THE ALL IN ON THE TURN WHEN THE JACK PAIRED THE BOARD..."
 *   "ITS A FOLD 100% OF THE TIME"
 * earlier the same day, for PLO6:
 *   "IN PLO6 IF ITS NOT THE NUTS, ITS PROBABLY NOT GOOD"
 * and that evening, widening it:
 *   "ADD PLO4 AND PLO5 AND THE FLOP TO THE PAIRED BOARD FOLD RULE"
 *
 * Why the brain called: every equity cap for this class (V40 'board2p', a
 * pocket pair over the board's pair) prices it at about 30-34% on the turn,
 * and the shove only asked for 25%. A cap is a number the next tweak moves.
 * This is a rule: on a paired flop, turn or river in PLO4/PLO5/PLO6, a horse
 * that does not hold a full house or better never puts a committing amount of
 * chips into a bet. It folds.
 *
 * "Committing" is any of: the bettor is all in, the call is at least a
 * quarter of the horse's stack, or the call would leave the horse all in.
 * A token call getting better than 5.7:1 (required equity under 15%) is left
 * to the brain, so a horse with three chips behind never folds a flush to a
 * shove for two of them. Hi-lo and multi-board pots are out of scope: half a
 * pot or one board of three is a different question.
 */
import type { Card, SeatPlayer } from '../types.js';
import { scoreOmahaHiPartial } from './HorseEval.js';

export const PLO_PAIRED_BOARD_VARIANTS: ReadonlySet<string> = new Set(['plo4', 'plo5', 'plo6']);
const FULL_HOUSE = 7;
const COMMIT_STACK_SHARE = 0.25;
const TOKEN_CALL_REQUIRED_EQUITY = 0.15;

export interface PairedBoardFoldInput {
  gameVariant: string | undefined;
  hiLo: boolean;
  multiBoard: boolean;
  board: Card[];
  hero: Pick<SeatPlayer, 'cards' | 'stack' | 'bet' | 'user_id'>;
  players: Array<Pick<SeatPlayer, 'user_id' | 'is_folded' | 'is_all_in' | 'stack' | 'bet'>>;
  currentBet: number;
  toCall?: number;
  pot: number;
}

export function boardIsPaired(board: Card[]): boolean {
  return new Set(board.map((c) => c.rank)).size < board.length;
}

/** True when the horse must fold rather than call or raise this bet. */
export function ploPairedBoardMustFold(i: PairedBoardFoldInput): boolean {
  const variant = String(i.gameVariant ?? '').toLowerCase();
  if (!PLO_PAIRED_BOARD_VARIANTS.has(variant)) return false;
  if (i.hiLo || i.multiBoard) return false;
  if (!Array.isArray(i.board) || i.board.length < 3) return false; // flop, turn and river
  if (!boardIsPaired(i.board)) return false;
  const hole = i.hero.cards;
  if (!Array.isArray(hole) || hole.length < 4) return false;

  const stack = Number.isFinite(i.hero.stack) ? Math.max(0, i.hero.stack) : 0;
  const toCall = Number.isFinite(i.toCall)
    ? Math.max(0, i.toCall as number)
    : Math.max(0, (i.currentBet || 0) - (i.hero.bet || 0));
  if (toCall <= 0.005 || stack <= 0) return false;

  let category: number;
  try {
    category = Math.floor(scoreOmahaHiPartial(hole, i.board) / 0x100000);
  } catch {
    return false;
  }
  if (!(category > 0) || category >= FULL_HOUSE) return false;

  const pot = Number.isFinite(i.pot) ? Math.max(0, i.pot) : 0;
  const requiredEquity = toCall / (pot + toCall || 1);
  if (requiredEquity < TOKEN_CALL_REQUIRED_EQUITY) return false;

  const bettorAllIn = i.players.some(
    (p) =>
      p.user_id !== i.hero.user_id &&
      !p.is_folded &&
      p.is_all_in &&
      (p.bet || 0) > (i.hero.bet || 0)
  );
  return bettorAllIn || toCall >= stack * COMMIT_STACK_SHARE || toCall >= stack - 0.005;
}
