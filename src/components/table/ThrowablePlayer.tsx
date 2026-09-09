/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE PLAYER — plays a spec + rig on the seats (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The reference grammar, measured over thirty-one PokerBros throws
 * (docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md 1.1), played for any
 * item that has a rig. `ThrowAnimation.tsx` (physics profiles, impact
 * profiles, a still render per item) keeps serving the items that do not have
 * one yet; `ThrowAnimationContainer` decides per event.
 *
 *   SPAWN     the projectile scales in ON the thrower's avatar and holds
 *             (spec.spawnMs). Corner for objects, centre for characters.
 *   FLIGHT    a STRAIGHT line at CONSTANT speed to the target avatar's centre
 *             (spec.flight.ms, 133-400). No arc, no easing, no trail. The rig
 *             may spin inside its box (the dice); the box itself only slides.
 *   ARRIVAL   'blink-pop': the projectile is removed and the payload pops
 *             from a dot with a damped bounce; 'land': the payload takes over
 *             with a 1.1x overshoot; 'none': it simply appears.
 *   PAYLOAD   the rig's Payload, mounted at LANDING, centred on the target
 *             avatar, sized in avatar units, drawn OVER the avatar. It performs
 *             for spec.payload.ms and every beat inside it is CSS delay from
 *             landing.
 *   RESIDUE   optional; a hard cut is the default ending, as in the reference.
 *
 * What this player deliberately does NOT do, by ruling 6 of the plan: no
 * seat flinch, no table shake. The target's cards, stack and action badge
 * never move while a hand is live; everything happens in this overlay.
 *
 * TIME. One `speed = getAnimationSpeed()` per throw, read at mount so a
 * setting changed mid-flight cannot desynchronise a throw in the air. Every
 * phase timer multiplies by it; every rig keyframe is
 * `calc(... * var(--animation-speed, 1))`; every cue is scheduled on the
 * AudioContext clock with the same multiplier. Three clocks, one variable.
 *
 * SPACE. Mounted inside `.table-scaler` like the legacy layer and the
 * knockout, so `seatPositions` (scaler pixels, 1-indexed) is the truth. The
 * avatar unit `--thr-u` is MEASURED off the target seat's own avatar element
 * (`[data-seat-num] .seat__avatar`, layout width, so the scaler's transform
 * does not matter), scoped to THIS table via `closest('.table-page')`,
 * because a multi-table view mounts four of these. Fallback 84px.
 *
 * REDUCED MOTION collapses the flight (the payload mounts at once) but keeps
 * the payload, which is the meaning of the throw. `data-motion="keep"` marks
 * it for reducedMotion.css.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ThrowEvent } from '../../services/ThrowableService';
import { throwableSoundService } from '../../services/ThrowableSoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import type { ThrowableSpec } from '../../throwables/spec';
import { THROWABLE_GRAMMAR, throwableLandingMs } from '../../throwables/spec';
import type { ThrowableRig } from '../../throwables/rig';
import { cueUrl, isPlaceholderCue, placeholderRecipe } from '../../throwables/cues';
import './ThrowablePlayer.css';
import { hasThrowableArtwork, prepareThrowableArtwork } from '../../throwables/artwork';
import { captureThrowableAvatar, type AvatarSnapshot } from '../../throwables/avatarSnapshot';

export interface ThrowablePlayerProps {
  event: ThrowEvent;
  spec: ThrowableSpec;
  rig: ThrowableRig;
  /** Scaler pixels, keyed by 1-indexed seat number. */
  seatPositions: Map<number, { x: number; y: number }>;
  onComplete: () => void;
}

type Phase = 'loading' | 'spawn' | 'flight' | 'payload' | 'residue' | 'done';

/** Normalised stereo position (-1..1) for a scaler x, from the scaler width. */
function panFor(x: number, root: HTMLElement | null): number {
  const w =
    root?.parentElement?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
  if (!w) return 0;
  return Math.max(-0.8, Math.min(0.8, (x / w) * 2 - 1));
}

/** The avatar width at a seat, in layout pixels, measured on THIS table. */
function measureAvatarUnit(root: HTMLElement | null, seatNumber: number): number {
  try {
    const scope = root?.closest('.table-page') ?? document;
    const el = scope.querySelector<HTMLElement>(`[data-seat-num="${seatNumber}"] .seat__avatar`);
    const w = el?.offsetWidth ?? 0;
    if (w >= 24 && w <= 400) return w;
  } catch {
    /* fall through */
  }
  return 84;
}

/** Offset of the spawn point from the thrower's avatar centre, in u. */
const SPAWN_OFFSET_U: Record<ThrowableSpec['spawn'], { x: number; y: number }> = {
  'avatar-face': { x: 0, y: 0 },
  'avatar-corner': { x: -0.35, y: -0.4 },
  none: { x: 0, y: 0 },
};

export function ThrowablePlayer({
  event,
  spec,
  rig,
  seatPositions,
  onComplete,
}: ThrowablePlayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const toPos = seatPositions.get(event.toSeat);
  // An unseated thrower (a railbird, or a seat this client could not resolve)
  // launches from below the target, as the legacy layer does, so a paid throw
  // is always seen.
  const fromPos =
    seatPositions.get(event.fromSeat) || (toPos ? { x: toPos.x, y: toPos.y + 240 } : undefined);

  const speed = useMemo(() => getAnimationSpeed(), []);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [phase, setPhase] = useState<Phase>(() =>
    hasThrowableArtwork(spec.id)
      ? 'loading'
      : reduced || spec.flight.mode === 'none'
        ? 'payload'
        : 'spawn'
  );
  const [unit, setUnit] = useState<number>(84);
  const [targetAvatar, setTargetAvatar] = useState<AvatarSnapshot>();

  useEffect(() => {
    if (!toPos) {
      onCompleteRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  useEffect(() => {
    if (!toPos || !fromPos) return;
    const root = rootRef.current;
    setUnit(measureAvatarUnit(root, event.toSeat));
    if (rig.needsTargetAvatar) setTargetAvatar(captureThrowableAvatar(root, event.toSeat));

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, Math.max(0, ms * speed)));

    let cancelled = false;
    let cancelCues = () => {};
    const start = () => {
      if (cancelled) return;
      setPhase(reduced || spec.flight.mode === 'none' ? 'payload' : 'spawn');
      const landing = spec.spawnMs + throwableLandingMs(spec);
      const atTarget = Math.max(spec.payload.ms, spec.residue?.ms ?? 0);

      // Immediate payloads skip spawn/flight. Shift their sound clock by the
      // same amount and omit cues belonging only to the skipped travel.
      const immediatePayload = reduced || spec.flight.mode === 'none';
      const audio = immediatePayload
        ? spec.audio.filter((cue) => cue.at >= throwableLandingMs(spec))
        : spec.audio;
      cancelCues = throwableSoundService.scheduleCues(audio, {
        speed,
        offsetMs: immediatePayload ? -throwableLandingMs(spec) : spec.spawnMs,
        panTarget: panFor(toPos.x, root),
        panThrower: panFor(fromPos.x, root),
        urlFor: cueUrl,
        isPlaceholder: isPlaceholderCue,
        playPlaceholder: (name, pan) => {
          const recipe = placeholderRecipe(name);
          if (recipe) throwableSoundService.playImpact(recipe, 'medium', pan);
        },
      });

      if (reduced || spec.flight.mode === 'none') {
        // Straight to the performance. Fireworks spawn nothing at the thrower
        // by design; reduced motion gets the meaning without the travel.
        at(spec.payload.ms, () => {
          if (spec.residue && spec.residue.ms > spec.payload.ms) setPhase('residue');
        });
        at(atTarget, () => {
          setPhase('done');
          onCompleteRef.current();
        });
      } else {
        at(spec.spawnMs, () => setPhase('flight'));
        at(landing, () => setPhase('payload'));
        if (spec.residue && spec.residue.ms > spec.payload.ms) {
          at(landing + spec.payload.ms, () => setPhase('residue'));
        }
        at(landing + atTarget, () => {
          setPhase('done');
          onCompleteRef.current();
        });
      }
    };
    if (hasThrowableArtwork(spec.id)) {
      void prepareThrowableArtwork(spec.id).then(start, () => {
        if (cancelled) return;
        setPhase('done');
        onCompleteRef.current();
      });
    } else {
      start();
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      cancelCues();
    };
    // `event.id` identity is the retrigger; positions are read once per throw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  if (!fromPos || !toPos || phase === 'done') return null;

  const spawnOff = SPAWN_OFFSET_U[spec.spawn];
  const spawnX = fromPos.x + spawnOff.x * unit;
  const spawnY = fromPos.y + spawnOff.y * unit;
  const anchorY = spec.payload.anchor === 'above' ? toPos.y - 0.9 * unit : toPos.y;
  const anchorX =
    spec.payload.anchor === 'left'
      ? toPos.x - 0.6 * unit
      : spec.payload.anchor === 'right'
        ? toPos.x + 0.6 * unit
        : toPos.x;

  // Unit direction toward the source, so return gags work from every seat.
  const backX = fromPos.x - toPos.x;
  const backY = fromPos.y - toPos.y;
  const backLength = Math.hypot(backX, backY);
  const vars = {
    '--thr-return-x': `${backLength ? backX / backLength : 0}px`,
    '--thr-return-y': `${backLength ? backY / backLength : -1}px`,
    '--animation-speed': speed,
    '--thr-u': `${unit}px`,
    '--thr-from-x': `${spawnX}px`,
    '--thr-from-y': `${spawnY}px`,
    '--thr-to-x': `${toPos.x}px`,
    '--thr-to-y': `${toPos.y}px`,
    '--thr-spawn-ms': `${spec.spawnMs}ms`,
    '--thr-flight-ms': `${spec.flight.ms}ms`,
    '--thr-arrival-ms': `${spec.arrival === 'land' ? THROWABLE_GRAMMAR.landMs : THROWABLE_GRAMMAR.arrivalMs}ms`,
    '--thr-payload-ms': `${spec.payload.ms}ms`,
    '--thr-residue-ms': `${spec.residue?.ms ?? spec.payload.ms}ms`,
  } as React.CSSProperties;

  const { Projectile, Payload } = rig;
  const showProjectile = phase === 'spawn' || phase === 'flight';
  const showPayload = phase === 'payload' || phase === 'residue';

  return (
    <div
      ref={rootRef}
      className={`thr thr--${spec.id}`}
      data-throwable={spec.id}
      data-phase={phase}
      style={vars}
      aria-hidden="true"
    >
      {showProjectile && (
        <div
          className={`thr__proj thr__proj--${phase}${spec.flight.upright ? ' thr__proj--upright' : ''}${spec.flight.tumble ? ' thr__proj--tumble' : ''}`}
        >
          <Projectile uid={`${uid}p`} />
        </div>
      )}
      {showPayload && (
        <div
          className={`thr__payload thr__payload--${spec.arrival} thr__payload--${phase}${spec.residue?.fade === 'fade' ? ' thr__payload--fades' : ''}`}
          style={{ left: anchorX, top: anchorY } as React.CSSProperties}
          data-motion="keep"
        >
          <Payload uid={`${uid}q`} targetAvatar={targetAvatar} throwId={event.id} />
        </div>
      )}
    </div>
  );
}

export default ThrowablePlayer;
