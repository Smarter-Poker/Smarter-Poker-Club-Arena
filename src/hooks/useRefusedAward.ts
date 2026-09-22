import { useCallback, useEffect, useRef, useState } from 'react';

/* NO GAME STARTS ITSELF (owner ruling 2026-09-21, R1 and R9). This file was
 * hooks/useAwardAutoStart.ts, a five-second countdown that pressed Start on a
 * won game. Dan's list replaces that ruling: "Games can NEVER auto start.
 * Remove the countdown clock that triggers an auto start", and "When a bonus
 * game is won, the won game must stay on screen until the user selects Play
 * Game". The countdown and the hook it was built on (useIdleSpinCountdown) are
 * gone; what remains is the half that was never about starting anything: a
 * game the server refused is let go, so the player is never trapped on it. */

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
