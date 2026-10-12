/**
 * LIGHTNING PHASE 10: HAND VOLUME, ALWAYS ON SCREEN, WITHOUT A POLL.
 *
 * Lightning deals a very high hand volume, so the session's size must be in
 * front of the player at all times, not behind a panel. The numbers come
 * from data the client already has:
 *
 *   - the BASELINE is one fn_lightning_session_stats read when the room's
 *     tools mount (and whatever fresher stats the Session panel reads while
 *     it is open - the same object, handed in as it arrives);
 *   - HANDS tick locally: every new hand key on the felt is one more hand,
 *     counted the moment it deals, and reconciled whenever a baseline
 *     arrives (the database's count wins; the local ticks on top of it are
 *     only the hands it has not counted yet);
 *   - DURATION ticks locally from the baseline's clock, one second at a
 *     time, only while the room is on screen.
 *
 * Nothing here polls, spends, or decides anything: it is arithmetic over
 * one read and the stream the room already receives.
 */
import { useEffect, useRef, useState } from 'react';
import {
  fetchLightningSessionStats,
  lightningDurationText,
  lightningRateText,
  type LightningSessionStats,
} from './lightningSessionApi';

export interface LightningHandVolume {
  /** Hands this session, or null before anything is known. */
  hands: number | null;
  /** Seconds this session has run, or null before the baseline arrives. */
  durationS: number | null;
  /** Hands per hour over the session, or null while it cannot be said. */
  handsPerHour: number | null;
}

/**
 * The arithmetic, on its own so it is testable: the baseline's hands plus
 * the hands seen locally since it, the baseline's duration plus the seconds
 * since it was read, and the rate the two imply.
 */
export function lightningHandVolume(input: {
  baseHands: number | null;
  baseDurationS: number | null;
  /** Epoch ms the baseline was read; null when there is none. */
  baseAtMs: number | null;
  /** Hands seen on the felt since the baseline was read. */
  handsSinceBase: number;
  nowMs: number;
}): LightningHandVolume {
  const { baseHands, baseDurationS, baseAtMs, handsSinceBase, nowMs } = input;
  const hands =
    baseHands === null ? (handsSinceBase > 0 ? handsSinceBase : null) : baseHands + handsSinceBase;
  const elapsed = baseAtMs === null ? null : Math.max(0, Math.round((nowMs - baseAtMs) / 1000));
  const durationS = baseDurationS === null ? elapsed : baseDurationS + (elapsed ?? 0);
  const handsPerHour =
    hands !== null && durationS !== null && durationS >= 60 ? (hands / durationS) * 3600 : null;
  return { hands, durationS, handsPerHour };
}

/** The strip's one line. A dash is "not known", never a zero that lies. */
export function lightningHandVolumeText(v: LightningHandVolume): string {
  const hands = v.hands === null ? '-' : v.hands.toLocaleString();
  const duration = lightningDurationText(v.durationS);
  const rate = v.handsPerHour === null ? '-' : lightningRateText(v.handsPerHour, 0);
  return `Hands ${hands} · ${duration} · ${rate}/hr`;
}

/**
 * The live volume for one room. One stats read on mount is the baseline;
 * `panelStats` (the Session panel's own read, when it is open) re-baselines
 * for free; `handKey` changes count the hands in between; a one-second local
 * tick moves the clock while `active`.
 */
export function useLightningHandVolume(
  poolSessionId: string | null,
  handKey: string | null,
  active: boolean,
  panelStats: LightningSessionStats | null = null
): LightningHandVolume {
  const [, setTick] = useState(0);
  const base = useRef<{ hands: number | null; durationS: number | null; atMs: number | null }>({
    hands: null,
    durationS: null,
    atMs: null,
  });
  const sinceBase = useRef(0);
  const lastKey = useRef<string | null>(null);

  // The baseline: one read per room, on mount.
  useEffect(() => {
    if (!poolSessionId) return;
    let live = true;
    base.current = { hands: null, durationS: null, atMs: null };
    sinceBase.current = 0;
    lastKey.current = null;
    fetchLightningSessionStats(poolSessionId)
      .then((s) => {
        if (!live || !s) return;
        base.current = { hands: s.hands, durationS: s.durationS, atMs: Date.now() };
        sinceBase.current = 0;
        setTick((t) => t + 1);
      })
      .catch(() => {
        /* the local count still ticks; the next panel read re-baselines */
      });
    return () => {
      live = false;
    };
  }, [poolSessionId]);

  // The Session panel's fresher read wins whenever it arrives.
  useEffect(() => {
    if (!panelStats) return;
    base.current = {
      hands: panelStats.hands,
      durationS: panelStats.durationS,
      atMs: Date.now(),
    };
    sinceBase.current = 0;
    setTick((t) => t + 1);
  }, [panelStats]);

  // A new hand on the felt is one more hand, the moment it deals. The very
  // first key seen is the hand already underway at mount - the baseline's
  // business, not a local tick.
  useEffect(() => {
    if (!handKey || handKey === lastKey.current) return;
    const first = lastKey.current === null;
    lastKey.current = handKey;
    if (!first) {
      sinceBase.current += 1;
      setTick((t) => t + 1);
    }
  }, [handKey]);

  // The clock, locally, only while the room is on screen.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  return lightningHandVolume({
    baseHands: base.current.hands,
    baseDurationS: base.current.durationS,
    baseAtMs: base.current.atMs,
    handsSinceBase: sinceBase.current,
    nowMs: Date.now(),
  });
}
