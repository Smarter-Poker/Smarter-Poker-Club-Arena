/**
 * A SHORT ALL-IN DOES NOT REOPEN THE BETTING (Dan 2026-10-22, binding).
 *
 * Dan, verbatim, with a screenshot of a PLO6 hand: "RAISING, WHEN YOU CAN'T
 * RAISE AND CAN 'ONLY CALL' SHOULD NEVER BE AN OPTION, IT SHOULD ONLY GIVE YOU
 * 'CALL OR FOLD'."
 *
 * The hand: the hero bet 53.50 on the turn, a short stack went all in for
 * 63.49 (a raise of 9.99, well under the 53.50 a full raise needed) and a
 * third player called. Action came back to the hero owing 9.99, and the bar
 * offered Raise and opened the sizing slider. The engine refuses that raise:
 * `HandController.canReopenBetting` (TDA 44 / 47) lets a player who has
 * already acted this street raise again only when the wager they now face is
 * at least one full raise above their own bet. The bar never asked.
 *
 * This is that same rule, read from what the client has:
 *   - `heroLastAction` is the hero's action on THIS street (the snapshot mapper
 *     clears it every street, and a posted blind carries none), so a player who
 *     has not acted yet - the big blind's option included - may always raise;
 *   - `raiseIncrement` is the engine's published minimum raise, which is the
 *     last FULL raise (a short all-in never changes it) or the big blind;
 *     it already includes the dealt hand's blind. Table metadata can announce
 *     the next level mid-hand and must not raise that hand's reopen threshold;
 *   - fixed limit reopens on half the street's bet, as the engine does.
 */
const ANSWERED_THIS_STREET = new Set(['check', 'call', 'bet', 'raise']);

export interface ReopenInput {
  heroLastAction: string | null | undefined;
  currentBet: number;
  heroBet: number;
  raiseIncrement: number;
  bigBlind: number;
  isFixedLimit: boolean;
  fixedBetSize?: number | null;
}

export function heroMayReopenBetting(input: ReopenInput): boolean {
  if (!input.heroLastAction || !ANSWERED_THIS_STREET.has(input.heroLastAction)) return true;
  const increment = input.isFixedLimit
    ? Math.max(0, Number(input.fixedBetSize) || input.bigBlind) / 2
    : Number.isFinite(input.raiseIncrement) && input.raiseIncrement > 0
      ? input.raiseIncrement
      : input.bigBlind;
  return input.currentBet - input.heroBet >= increment - 0.005;
}
