import { useCallback, useEffect, useRef, useState } from 'react';
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

/** A won game the server just refused is let go until the server's reasons change.
 *
 * Owner ruling, 2026-09-21: a player is never trapped on a game that cannot
 * start. A refusal that is not about the ticket (the hourly break began during
 * the countdown, the award was used on another device, the day's limit was
 * reached) used to leave the page holding the player on an award the server
 * had just said no to, with its countdown spent. The page now reads the award
 * again after such a refusal, and this hook remembers which award was refused
 * so the exit guard lets go of it.
 *
 * `serverBlocked` is the page's own "the server's state says this cannot
 * start" - never a transient flag such as a quote in flight or a start in
 * progress. The moment it goes from blocked to clear (the break ended), the
 * refusal is forgotten and `opening` changes, which gives the countdown a fresh
 * key: a refusal the state explains still ends in the game starting itself,
 * while a refusal the server repeats with nothing changed is never retried on a
 * timer. */
export function useRefusedAward(awardId: string | null | undefined, serverBlocked: boolean) {
  const [refused, setRefused] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const wasBlocked = useRef(serverBlocked);
  useEffect(() => {
    if (serverBlocked) {
      wasBlocked.current = true;
      return;
    }
    if (!wasBlocked.current) return;
    wasBlocked.current = false;
    setRefused(null);
    setOpening((count) => count + 1);
  }, [serverBlocked]);
  const refuse = useCallback((id: string | null | undefined) => {
    if (id) setRefused(id);
  }, []);
  return {
    /** The award on screen is the one the server just refused. */
    refused: Boolean(awardId) && refused === awardId,
    /** Changes each time the server's blockers clear; part of the countdown key. */
    opening,
    refuse,
  };
}
