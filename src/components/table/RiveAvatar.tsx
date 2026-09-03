/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RIVE AVATAR — a rigged character, when one exists
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders a .riv in place of the static bust and drives its state machine from
 * the SAME gesture value the CSS choreography already uses, so a rigged avatar
 * and an unrigged one are in lockstep at the table.
 *
 * EVERY FAILURE FALLS BACK, SILENTLY
 * No manifest, no rig for this avatar, runtime import fails, .riv fails to load,
 * state machine missing, reduced motion — all of them render nothing and let the
 * caller keep its existing <img>. A player must never see a hole where their
 * avatar was because a rig went wrong.
 *
 * THE RUNTIME IS LAZY ON PURPOSE
 * @rive-app/canvas is 4.7MB unpacked and carries a WASM payload. It is imported
 * with a dynamic `import()` INSIDE the effect that has already established a rig
 * exists, so Vite splits it into its own chunk and no player downloads a byte of
 * it while no avatar is rigged — which is every player, today.
 *
 * WHAT A RIG CAN AND CANNOT DO
 * Measured 2026-08-21: the table artwork is 125x170 portrait crops, mostly
 * head-and-shoulders. A rig can blink, turn a head, shrug, sway a cape. It
 * cannot reach an arm toward the pot, because no arm was drawn. Contract and
 * input names: docs/RIVE-AVATAR-CONTRACT.md
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AvatarGesture } from './SeatSlot';
import { riveUrlForAvatar } from '../../utils/riveRigRegistry';
import { prefersReducedMotion } from '../../utils/animationSpeed';

export interface RiveAvatarProps {
  /** The static artwork URL. Used to look up whether a rig exists. */
  avatarUrl: string;
  /** Current one-shot gesture, or null when idle. Same value the CSS uses. */
  gesture: AvatarGesture;
  /** True while it is this seat's turn — drives a held "attentive" pose. */
  isActive: boolean;
  /** True once the player has folded — drives a held "out of the hand" pose. */
  isFolded: boolean;
  /** Rendered box, in CSS px. */
  size: number;
  /** Called once a rig is confirmed live, so the caller can hide its <img>. */
  onRigActive?: (active: boolean) => void;
}

/** The state machine every rigged avatar must expose. See the contract doc. */
export const RIVE_STATE_MACHINE = 'SeatState';

/**
 * Gesture -> trigger name. These are TRIGGERS (fire-and-forget), matching the
 * one-shot nature of the CSS gestures. Held states are booleans instead,
 * because "is folded" is a condition, not an event.
 */
export const RIVE_TRIGGERS: Record<NonNullable<AvatarGesture>, string> = {
  push: 'Push',
  check: 'Check',
  fold: 'Fold',
  celebrate: 'Celebrate',
  lose: 'Lose',
  alert: 'Alert',
};

export const RIVE_BOOL_ACTIVE = 'IsActive';
export const RIVE_BOOL_FOLDED = 'IsFolded';

export const RiveAvatar: React.FC<RiveAvatarProps> = ({
  avatarUrl,
  gesture,
  isActive,
  isFolded,
  size,
  onRigActive,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [live, setLive] = useState(false);
  // Held in a ref rather than state: the gesture effect needs the instance
  // without re-subscribing, and a Rive instance is not renderable data.
  const riveRef = useRef<any>(null);
  const inputsRef = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let instance: any = null;

    (async () => {
      // NO RIG ART EXISTS YET (2026-08-21), and until it does the 4.7MB
      // runtime is dead weight in the BUILD even though no player ever
      // fetches its chunk. Vite inlines this literal, so everything below is
      // statically unreachable and rollup drops the dynamic import entirely
      // -- 182kB raw / 52kB gzipped out of the artefact. Flip
      // VITE_RIVE_RIGS=on in the same commit that lands the first .riv and
      // the lazy behaviour described above resumes untouched.
      if (import.meta.env.VITE_RIVE_RIGS !== 'on') return;

      // A rigged avatar is still an animation. Someone who asked the OS for
      // less motion should get the static bust, not a looping character.
      if (prefersReducedMotion()) return;

      const url = await riveUrlForAvatar(avatarUrl);
      if (!url || cancelled) return;

      let Rive: any;
      try {
        // Lazy: this is the ONLY reference to the runtime, so it lands in its
        // own chunk and is fetched only once a rig is known to exist.
        ({ Rive } = await import('@rive-app/canvas'));
      } catch {
        return; // Chunk failed to load — keep the static avatar.
      }
      if (cancelled || !canvasRef.current) return;

      try {
        instance = new Rive({
          src: url,
          canvas: canvasRef.current,
          autoplay: true,
          stateMachines: RIVE_STATE_MACHINE,
          onLoad: () => {
            if (cancelled) return;
            try {
              const inputs = instance.stateMachineInputs(RIVE_STATE_MACHINE);
              if (!inputs || !inputs.length) return; // Wrong/absent machine.
              const map = new Map<string, any>();
              for (const i of inputs) map.set(i.name, i);
              inputsRef.current = map;
              riveRef.current = instance;
              setLive(true);
              onRigActive?.(true);
            } catch {
              /* malformed rig — stay on the static avatar */
            }
          },
          onLoadError: () => {
            /* .riv missing or corrupt — stay on the static avatar */
          },
        });
      } catch {
        /* constructor threw — stay on the static avatar */
      }
    })();

    return () => {
      cancelled = true;
      onRigActive?.(false);
      try {
        instance?.cleanup?.();
      } catch {
        /* nothing useful to do on teardown failure */
      }
      riveRef.current = null;
      inputsRef.current = new Map();
    };
    // avatarUrl is the only thing that can change which rig is correct.
  }, [avatarUrl]);

  // One-shot gestures -> triggers.
  useEffect(() => {
    if (!live || !gesture) return;
    const input = inputsRef.current.get(RIVE_TRIGGERS[gesture]);
    // A rig that omits an optional trigger is valid; it simply will not react
    // to that gesture. Missing inputs must never throw.
    try {
      input?.fire?.();
    } catch {
      /* ignore */
    }
  }, [gesture, live]);

  // Held conditions -> booleans.
  useEffect(() => {
    if (!live) return;
    try {
      const a = inputsRef.current.get(RIVE_BOOL_ACTIVE);
      if (a) a.value = isActive;
      const f = inputsRef.current.get(RIVE_BOOL_FOLDED);
      if (f) f.value = isFolded;
    } catch {
      /* ignore */
    }
  }, [isActive, isFolded, live]);

  return (
    <canvas
      ref={canvasRef}
      className="seat__avatar-rive"
      /* ATTRIBUTES set the drawing buffer, CSS sets the displayed box, and they
         are deliberately different things. The buffer is 2x for retina; the box
         comes from `.seat__avatar-rive` in avatarChoreography.css so the canvas
         inherits the SAME bust transform as the <img> it replaces.

         Sizing the box inline here instead — which is what this did first —
         pins it to an 84px SQUARE with no scale, while the bust beside it
         renders about 90x122. The rig would look shrunken and would float off
         the name box. Display size belongs to the stylesheet that owns the
         geometry, not to this component. */
      width={size * 2}
      height={size * 2}
      style={{
        // Hidden until the rig is confirmed live, so a failed load never leaves
        // a blank canvas sitting on top of the static avatar underneath.
        display: live ? 'block' : 'none',
      }}
      aria-hidden="true"
    />
  );
};

export default RiveAvatar;
