/**
 * LIGHTNING PHASE 6: THE ONLY WORDS A GAP BETWEEN HANDS EVER GETS.
 *
 * A Lightning gap is normally shorter than a blink and says nothing. Only when
 * the quiet outlasts LIGHTNING_NEXT_HAND_NOTICE_MS does the felt say
 * "Next Hand...", and never what the machinery is doing behind it.
 */
import { useEffect, useRef, useState } from 'react';
import {
  LIGHTNING_NEXT_HAND_NOTICE_MS,
  LIGHTNING_NEXT_HAND_TEXT,
  nextHandNoticeDue,
} from '../../lightning/lightningHand';
import './LightningFoldBar.css';

export default function LightningNextHand({
  handInProgress,
  thresholdMs = LIGHTNING_NEXT_HAND_NOTICE_MS,
}: {
  handInProgress: boolean;
  thresholdMs?: number;
}) {
  const quietSinceRef = useRef<number | null>(handInProgress ? null : Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    if (handInProgress) {
      quietSinceRef.current = null;
      setTick((t) => t + 1);
      return;
    }
    if (quietSinceRef.current === null) quietSinceRef.current = Date.now();
    const wait = Math.max(0, quietSinceRef.current + thresholdMs - Date.now());
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  }, [handInProgress, thresholdMs]);
  const due = nextHandNoticeDue({
    handInProgress,
    quietSinceMs: quietSinceRef.current,
    nowMs: Date.now(),
    thresholdMs,
  });
  if (!due) return null;
  return (
    <p className="lightning-next-hand" data-testid="lightning-next-hand" role="status">
      {LIGHTNING_NEXT_HAND_TEXT}
    </p>
  );
}
