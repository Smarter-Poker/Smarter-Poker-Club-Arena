/**
 * LIGHTNING PHASE 6: THE ONLY WORDS A GAP BETWEEN HANDS EVER GETS.
 *
 * A Lightning gap is normally shorter than a blink and says nothing. Only when
 * the quiet outlasts LIGHTNING_NEXT_HAND_NOTICE_MS does the felt say
 * "Next Hand...", and never what the machinery is doing behind it.
 *
 * LIGHTNING TRANSITION, PHASE 1: the line fades in when it is due, and when
 * the next deal starts it fades out rather than vanishing in one frame. It
 * stays mounted for the fade (`data-leaving`), for the fade's full length at
 * the player's Animation Speed (CLAUDE.md 10.6), and is then removed. The
 * words never change: "Next Hand...", nothing else.
 */
import { useEffect, useRef, useState } from 'react';
import {
  LIGHTNING_NEXT_HAND_FADE_MS,
  LIGHTNING_NEXT_HAND_NOTICE_MS,
  LIGHTNING_NEXT_HAND_TEXT,
  nextHandNoticeDue,
} from '../../lightning/lightningHand';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import './LightningFoldBar.css';

export default function LightningNextHand({
  handInProgress,
  handComplete = false,
  thresholdMs = LIGHTNING_NEXT_HAND_NOTICE_MS,
}: {
  handInProgress: boolean;
  /** The felt's hand-bound completion latch, after its full award hold. */
  handComplete?: boolean;
  thresholdMs?: number;
}) {
  // A winner can keep the completed hand's snapshot while waiting to be
  // matched again. The existing completion latch ends that hand on the felt;
  // handSettling alone is too early because the pot push is still playing.
  const handActive = handInProgress && !handComplete;
  const quietSinceRef = useRef<number | null>(handActive ? null : Date.now());
  const [, setTick] = useState(0);
  /* Whether the line has been shown since it last finished leaving. Read in
     render so the fade-out starts in the same frame the deal does: the line
     is never unmounted and remounted on its way out. */
  const shownRef = useRef(false);
  useEffect(() => {
    if (handActive) {
      quietSinceRef.current = null;
      setTick((t) => t + 1);
      return;
    }
    if (quietSinceRef.current === null) quietSinceRef.current = Date.now();
    const wait = Math.max(0, quietSinceRef.current + thresholdMs - Date.now());
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  }, [handActive, thresholdMs]);
  const due = nextHandNoticeDue({
    handInProgress: handActive,
    quietSinceMs: quietSinceRef.current,
    nowMs: Date.now(),
    thresholdMs,
  });
  if (due) shownRef.current = true;
  const leaving = !due && shownRef.current;
  /* The fade out runs its full length at the player's speed, then the line
     is removed. A deal that ends again inside the fade keeps the same timer. */
  useEffect(() => {
    if (!leaving) return;
    const fade = Math.round(LIGHTNING_NEXT_HAND_FADE_MS * getAnimationSpeed());
    const done = setTimeout(() => {
      shownRef.current = false;
      setTick((t) => t + 1);
    }, fade);
    return () => clearTimeout(done);
  }, [leaving]);
  if (!due && !leaving) return null;
  return (
    <p
      className="lightning-next-hand"
      data-testid="lightning-next-hand"
      data-leaving={due ? undefined : 'true'}
      role="status"
    >
      {LIGHTNING_NEXT_HAND_TEXT}
    </p>
  );
}
