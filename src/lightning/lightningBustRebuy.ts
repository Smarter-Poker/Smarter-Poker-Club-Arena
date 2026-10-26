/**
 * LIGHTNING TRANSITION PHASE 2: A PLAYER WHO BUSTS IS OFFERED A WAY BACK.
 *
 * A Lightning player whose stack reaches zero is never dealt again: formation
 * refuses a pool session with no chips (fn_lightning_player_legality,
 * 'NO_STACK'). The cash table's bust prompt stands down in a Lightning room,
 * and the only automatic path is the opt-in auto top-up, which every live
 * Cluster has off. So a busted player sat on an idle felt with nothing to
 * press. Production, 2026-10-26: every human session the disconnect reaper
 * ended had busted to 0.00 first, one of them after almost three hours.
 *
 * This module decides when that player is asked. The table page shows the
 * same rebuy sheet the cash table uses (BuyInModal, rebuy mode), funded
 * through the Lightning top-up the room already has (handleAddChips with the
 * Lightning scope, one held idempotency key per bust), with a Leave option
 * that runs the room's own leave and opens the session summary. Nothing here
 * moves the player anywhere (CLAUDE.md 10.6) and nothing here charges anyone.
 *
 * WHEN: after the hand's presentation finishes (the final roster may still
 * be on the felt), the room not closed, the player not sitting out, and a zero stack
 * shown. The zero the client sees is a CANDIDATE, never the verdict: an
 * all-in hero reads 0 behind until the pot is paid. The verdict is the
 * database's own answer (readLightningTopUp: not in a hand, the pool session
 * active, the anchor seat theirs, live, not leaving and not sitting out),
 * which is also where the allowed maximum comes from.
 *
 * ONCE PER BUST: the prompt fires once, and is armed again only after a
 * positive stack has been seen (a rebuy landed, or a hand was dealt).
 *
 * Horses never see a screen; there is no horse branch here (CLAUDE.md 10.5).
 */
import { useEffect, useRef, useState } from 'react';
import { reportError } from '../utils/errorReporter';
import { readLightningTopUp } from './useLightningAutoTopUp';

/** What the felt shows of the hero's stack right now. */
export type LightningBustCandidate = 'bust' | 'funded' | 'unknown';

export function lightningBustCandidate(input: {
  /** This view is a Lightning pool-session room. */
  room: boolean;
  /** The roster carries the hero (a hand is dealt to them). */
  heroInRoster: boolean;
  /** The hero's roster stack, when the roster carries them. */
  rosterStack: number | null | undefined;
  /** The waiting chair's stack between hands (lightningWaitingHero). */
  waitingStack: number | null | undefined;
  /** A hand is playing or its result presentation has not finished yet. */
  handLive: boolean;
  /** The room is gone (MUST MOVE reversion or session ended). */
  roomClosed: boolean;
  /** The player asked to sit out. */
  sittingOut: boolean;
}): LightningBustCandidate {
  if (!input.room) return 'unknown';
  const shown = input.heroInRoster ? input.rosterStack : input.waitingStack;
  if (typeof shown === 'number' && Number.isFinite(shown) && shown > 0) return 'funded';
  if (input.handLive || input.roomClosed || input.sittingOut) return 'unknown';
  return shown === 0 ? 'bust' : 'unknown';
}

/** The database's answer, as the prompt reads it: open only on a real zero. */
export function lightningBustVerdict(
  read: { stack: number; maximum: number } | null | undefined
): { kind: 'prompt'; maximum: number } | { kind: 'funded' } | { kind: 'unknown' } {
  if (!read) return { kind: 'unknown' };
  if (read.stack > 0) return { kind: 'funded' };
  if (!(read.maximum > 0)) return { kind: 'unknown' };
  return { kind: 'prompt', maximum: read.maximum };
}

/** How long the opt-in auto top-up is given to land before the player is asked. */
export const LIGHTNING_BUST_AUTO_TOP_UP_GRACE_MS = 2500;
/** A read that could not answer (a hand still settling, a failed read) is asked again. */
export const LIGHTNING_BUST_RECHECK_MS = 1500;
export const LIGHTNING_BUST_MAX_READS = 6;

export function useLightningBustRebuy(input: {
  room: { poolSessionId: string; clusterId: string } | null;
  userId: string | null | undefined;
  candidate: LightningBustCandidate;
  /** The opt-in auto top-up is on: give it its moment first. */
  autoTopUpEnabled: boolean;
  /** Another money sheet (or this prompt) is already open: do not stack one. */
  blocked: boolean;
  /** Open the prompt. Called once per bust, with the allowed maximum. */
  onPrompt: (maximum: number) => void;
  read?: typeof readLightningTopUp;
}): void {
  const { room, userId, candidate, autoTopUpEnabled, blocked } = input;
  const read = input.read ?? readLightningTopUp;
  const key =
    room && userId && userId !== 'guest'
      ? `${room.poolSessionId}/${room.clusterId}/${userId}`
      : null;
  const firedRef = useRef({ key, fired: false, reads: 0 });
  if (firedRef.current.key !== key) firedRef.current = { key, fired: false, reads: 0 };
  const [tick, setTick] = useState(0);
  const onPromptRef = useRef(input.onPrompt);
  onPromptRef.current = input.onPrompt;

  // A positive stack re-arms the prompt for the next bust.
  useEffect(() => {
    if (candidate === 'funded') firedRef.current.fired = false;
    if (candidate !== 'bust') firedRef.current.reads = 0;
  }, [candidate]);

  useEffect(() => {
    if (!key || !room || !userId || candidate !== 'bust' || blocked) return;
    if (firedRef.current.fired || firedRef.current.reads >= LIGHTNING_BUST_MAX_READS) return;
    const owner = firedRef.current;
    let cancelled = false;
    const first = owner.reads === 0;
    const wait = first
      ? autoTopUpEnabled
        ? LIGHTNING_BUST_AUTO_TOP_UP_GRACE_MS
        : 0
      : LIGHTNING_BUST_RECHECK_MS;
    const timer = setTimeout(() => {
      owner.reads += 1;
      void read(room.clusterId, room.poolSessionId, userId)
        .then((answer) => {
          if (cancelled || firedRef.current !== owner || owner.fired) return;
          const verdict = lightningBustVerdict(answer);
          if (verdict.kind === 'prompt') {
            owner.fired = true;
            onPromptRef.current(verdict.maximum);
            return;
          }
          // Funded: the zero on the felt was stale; the next positive stack
          // re-arms nothing because nothing fired. Unknown: ask again.
          if (verdict.kind === 'unknown') setTick((n) => n + 1);
        })
        .catch((error) => {
          if (cancelled) return;
          reportError(error, 'lightning.bust_rebuy_read_failed', { clusterId: room.clusterId });
          setTick((n) => n + 1);
        });
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    key,
    room?.poolSessionId,
    room?.clusterId,
    userId,
    candidate,
    blocked,
    autoTopUpEnabled,
    read,
    tick,
  ]);
}
