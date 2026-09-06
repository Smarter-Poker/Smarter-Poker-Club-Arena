/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SPEC — the contract between a rig, the player, the sound and the
 *  tests (throwables programme, phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "CURRENTLY THEY ARE JUST EMOJI'S THAT DON'T DO ANYTHING, WE NEED TO ADD
 * IN THE FULL FRAME BY FRAME ANIMATION FOR EACH AND EVERY SINGLE ONE."
 *
 * The plan (docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md) measured
 * thirty-one PokerBros throws at 30 fps and found ONE grammar under all of
 * them: spawn on the thrower's face, a straight constant-speed flight of about
 * a third of a second, a blink-and-pop landing, and then a PERFORMANCE on the
 * target's chair for about four seconds, drawn over the avatar, cut hard.
 * Every number in a spec is that grammar for one item. The player reads it;
 * the rig is drawn to it; the tests bound it; the sound is scheduled from it.
 *
 * TIME. Every `at` in a spec is MILLISECONDS FROM LAUNCH at Animation Speed
 * 1.0, exactly as the reference catalogues record them, so a beat can be
 * checked against a frame number without arithmetic. Spawn is BEFORE launch
 * (the item scales in on the thrower for `spawnMs`, then leaves). The player
 * multiplies everything by the player's speed once, at mount.
 *
 * SIZE. `u` is one avatar width at the target seat. A payload of 1.05 u
 * covers the face; a burst of 2.4 u is the fireworks. Rigs draw in a fixed
 * viewBox where 100 units = 1 u (see src/throwables/rig.ts), so a rig never
 * sees a pixel and is correct at every seat rung.
 */

export type ThrowableTier = 'free' | 'vip' | 'premium';

export type ThrowableCategory = 'objects' | 'characters' | 'cheers' | 'emoticons' | 'special';

/** How the item leaves the thrower. */
export type ThrowableSpawn =
  /** Scales in centred on the thrower's face (characters, emoticons). */
  | 'avatar-face'
  /** Scales in at the upper-left corner of the thrower's face (objects). */
  | 'avatar-corner'
  /** Nothing is drawn at the thrower (fireworks, lightning). */
  | 'none';

/** What happens in the last frames before the payload appears. */
export type ThrowableArrival =
  /** The projectile collapses to a dot, blinks, and the payload pops from the
   *  centre with a damped bounce (overshoot 1.1-1.5x, one undershoot). */
  | 'blink-pop'
  /** The projectile simply arrives; the payload takes over with a 1.1x
   *  overshoot (bottles, mugs, anything that must stay upright). */
  | 'land'
  /** The payload appears with no arrival beat (no projectile at all). */
  | 'none';

export interface ThrowableFlight {
  /** Straight-line travel time at speed 1.0. The reference is 133-400. */
  ms: number;
  /** 'none' for items that spawn at the target (fireworks). */
  mode: 'straight' | 'none';
  /** The projectile keeps its orientation (mug, bottle, trophy). */
  upright?: boolean;
  /** The projectile tumbles in flight (the dice; nothing else in the set). */
  tumble?: boolean;
}

export interface ThrowablePayload {
  /** Width of the payload's own box in avatar widths. */
  sizeU: number;
  /** Where the payload's centre sits relative to the target avatar. */
  anchor: 'face' | 'above' | 'left' | 'right';
  /** True when the avatar is hidden underneath (characters, splats). */
  coversAvatar: boolean;
  /** How long the payload performs, from LANDING, before the cut / residue. */
  ms: number;
}

export interface ThrowableResidue {
  /** How long the residue stays after the payload's own life, from landing. */
  ms: number;
  /** The reference cuts almost everything in one frame. */
  fade: 'cut' | 'fade';
}

export interface ThrowableBeat {
  /** ms from launch. */
  at: number;
  /** A name the rig, the harness and the parity test agree on. */
  marker: string;
}

export interface ThrowableCue {
  /** ms from launch. */
  at: number;
  /** A cue name in scripts/audio/throwable-cues.manifest.json. */
  sample: string;
  /** Linear gain, default 1. */
  gain?: number;
  /** For loops: keep playing until this ms from launch, then stop. */
  loopUntil?: number;
  /** Where the sound sits in the stereo field. Default 'target'. */
  pan?: 'target' | 'thrower';
}

export interface ThrowableCaption {
  /** The ONE sanctioned kind of word on the felt (ruling 7). Rendered by the
   *  rig at this beat, in Title Case, never as a DOM text node over the felt. */
  text: string;
  at: number;
}

export interface ThrowableSpec {
  /** == the catalogue id == the rig id. Never renamed; the wire carries it. */
  id: string;
  name: string;
  tier: ThrowableTier;
  category: ThrowableCategory;
  spawn: ThrowableSpawn;
  /** Scale-in + hold on the thrower before launch. The reference is 100-300. */
  spawnMs: number;
  flight: ThrowableFlight;
  arrival: ThrowableArrival;
  payload: ThrowablePayload;
  residue?: ThrowableResidue;
  beats: ThrowableBeat[];
  audio: ThrowableCue[];
  caption?: ThrowableCaption;
  /** Frame numbers in the reference catalogue this spec was measured from. */
  reference?: { video: 1 | 2; launchFrame: number; throw: string };
}

/** The reference grammar, as bounds the tests hold every spec to. */
export const THROWABLE_GRAMMAR = {
  spawnMs: { min: 0, max: 400 },
  flightMs: { min: 133, max: 400 },
  /** ms from landing. */
  payloadMs: { min: 1800, max: 5800 },
  /** From first pixel to clean, at speed 1. */
  totalMs: { min: 2000, max: 6500 },
  /** Blink-and-pop arrival, from the reference's 2-8 frame settle. */
  arrivalMs: 267,
  /** 'land' overshoot. */
  landMs: 100,
} as const;

/**
 * From first pixel on the thrower to the last frame at the target. The
 * arrival beat is the payload's ENTRANCE (its first `arrivalMs`), so it is
 * inside `payload.ms`, not added to it: the catalogue counts "pop" frames as
 * part of the time on target and so does this.
 */
export function throwableTotalMs(spec: ThrowableSpec): number {
  const flight = spec.flight.mode === 'none' ? 0 : spec.flight.ms;
  const atTarget = Math.max(spec.payload.ms, spec.residue?.ms ?? 0);
  return spec.spawnMs + flight + atTarget;
}

/** ms from launch at which the payload is mounted (the LANDING). */
export function throwableLandingMs(spec: ThrowableSpec): number {
  return spec.flight.mode === 'none' ? 0 : spec.flight.ms;
}
