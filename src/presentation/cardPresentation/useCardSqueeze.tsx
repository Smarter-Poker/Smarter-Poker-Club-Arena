/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  useCardSqueeze — the squeeze for a surface that is not the live felt
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ROUND 2 2026-09-05. The hand replay reveals community cards too, and until
 * now it simply swapped `<CardImage>` elements in - a card appeared, with no
 * animation of any kind, on the one surface where a player is deliberately
 * studying the board. Spec 35 gives replay its own (cinematic) profile and
 * spec 123 says the whole card lifecycle should read as one product.
 *
 * The live board does NOT use this hook: its own effect already carries the
 * newly-dealt window, the rabbit-hunt slots, the multi-board lanes and the
 * sound cue, and rewriting that around a hook would be a large change to the
 * most-watched component in the app for no behaviour the player can see. This
 * is the small version for surfaces that only need "reveal card N of a list".
 *
 * The rules are the engine's, so they are identical either way: one
 * presentation per key, no replay of a card already revealed, cancel on
 * unmount, and - always - the final card renders correctly whatever happens
 * to the animation (spec 4).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { cardPresentationEngine } from './engineSingleton';
import { detectPlatform } from './resolveProfile';
import { prefersReducedMotion } from '../../utils/animationSpeed';
import type { CardAnimationProfile, CardPresentationMode, CommunityStreet } from './types';

export interface CardSqueezeState {
  /** Slot index currently squeezing, or -1. */
  readonly index: number;
  readonly profile: CardAnimationProfile | null;
}

const IDLE: CardSqueezeState = { index: -1, profile: null };

/** Street for a board that has just grown to `count` cards. */
export function streetForCount(count: number): CommunityStreet | null {
  if (count >= 5) return 'river';
  if (count === 4) return 'turn';
  if (count >= 3) return 'flop';
  return null;
}

export interface UseCardSqueezeOptions {
  /** How many community cards are visible right now. */
  visibleCount: number;
  /** Identity of the hand being shown; a change resets the lane. */
  handId: string | number;
  /** Surface identity, so two replays on one page never share a lane. */
  surfaceId?: string;
  boardIndex?: number;
  mode?: CardPresentationMode;
  /** False while the surface is off screen: the card renders instantly. */
  isVisible?: boolean;
  /** Streets that squeeze. The flop keeps its own fan on the felt. */
  streets?: readonly CommunityStreet[];
}

const DEFAULT_STREETS: readonly CommunityStreet[] = ['turn', 'river'];

export function useCardSqueeze({
  visibleCount,
  handId,
  surfaceId,
  boardIndex = 0,
  mode = 'replay',
  isVisible = true,
  streets = DEFAULT_STREETS,
}: UseCardSqueezeOptions): CardSqueezeState {
  const instanceId = useId();
  const laneId = surfaceId ?? `surface${instanceId}`;
  const prevCountRef = useRef(visibleCount);
  const prevHandRef = useRef(handId);
  const activeKeyRef = useRef<string | null>(null);
  const [state, setState] = useState<CardSqueezeState>(IDLE);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    const handChanged = prevHandRef.current !== handId;
    prevCountRef.current = visibleCount;
    prevHandRef.current = handId;

    // Stepping BACKWARD, or loading another hand, is not a reveal. Whatever
    // was in flight is abandoned and the board renders as it stands.
    if (handChanged || visibleCount <= prevCount) {
      if (activeKeyRef.current) {
        cardPresentationEngine.cancel(activeKeyRef.current, handChanged ? 'new-hand' : 'rewound');
        activeKeyRef.current = null;
      }
      setState(IDLE);
      return;
    }

    const slot = visibleCount - 1;
    const street = streetForCount(visibleCount);
    if (!street || !streets.includes(street)) {
      setState(IDLE);
      return;
    }

    const result = cardPresentationEngine.presentCard(
      {
        tableId: laneId,
        handId,
        boardIndex,
        street,
        slotIndex: slot,
        sequence: visibleCount,
      },
      {
        mode,
        platform: detectPlatform(),
        focus: isVisible ? 'focused' : 'hidden',
        reducedMotion: prefersReducedMotion(),
        allIn: false,
      }
    );

    if (result.status !== 'started') {
      setState(IDLE);
      return;
    }
    activeKeyRef.current = result.key;
    setState({ index: slot, profile: result.profile });
    const timer = setTimeout(() => {
      activeKeyRef.current = null;
      setState(IDLE);
    }, result.durationMs);
    return () => clearTimeout(timer);
  }, [visibleCount, handId, laneId, boardIndex, mode, isVisible]);

  // Unmount: never leave a timer or an engine reference behind (spec 99).
  useEffect(() => {
    return () => {
      if (activeKeyRef.current) {
        cardPresentationEngine.cancel(activeKeyRef.current, 'unmount');
        activeKeyRef.current = null;
      }
    };
  }, []);

  return state;
}
