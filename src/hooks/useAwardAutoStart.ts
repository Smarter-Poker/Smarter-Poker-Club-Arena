import { useIdleSpinCountdown } from './useIdleSpinCountdown';

/** How long a won game waits before it starts itself. Long enough to read the
 * award and flip Double Down, short enough that nobody has to press Start. */
export const AWARD_AUTO_START_SECONDS = 5;

/** A won game starts itself.
 *
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY." Every Diamond Spins round
 * is a wheel award the player has already won, so Start decides nothing the
 * player has not decided: while an award is pending and the page could start
 * it, a short countdown runs and then presses Start for them. Pressing Start
 * sooner still works.
 *
 * `ready` is the page's own "Start would be accepted right now" (ticket dealt,
 * entry quoted, nothing in flight, nothing on screen that the start would
 * cover). A hidden tab pauses the countdown. Changing the entry (Double Down)
 * starts the window again. It fires once per award and entry: if that start is
 * refused, the page shows why and waits for the player, rather than retrying a
 * refusal on a timer.
 *
 * Returns the seconds left while counting, or null when it is not counting. */
export function useAwardAutoStart(
  awardId: string | null | undefined,
  ready: boolean,
  entryKey: string,
  start: () => void
): number | null {
  const armed = Boolean(awardId);
  const seconds = useIdleSpinCountdown(
    armed,
    ready,
    `${awardId ?? ''}:${entryKey}`,
    start,
    AWARD_AUTO_START_SECONDS * 1000
  );
  // Once the window has fired it stays spent for this award and entry, so the
  // page's Start label goes back to plain Start rather than "Starting In 0s".
  return armed && ready && seconds > 0 ? seconds : null;
}
