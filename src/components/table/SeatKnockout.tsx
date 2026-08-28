/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEAT KNOCKOUT — a bounty being taken, ON THE SEAT it was taken from
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, with a PokerBros capture attached: "NOTICE THE DETAILS AND
 * ANIMATIONS OF THE BOXING GLOVES KNOCKING OUT THE OPPONENT ... IT SHOULD BE AS
 * CLOSE TO 1:1 AS YOU CAN."
 *
 * ─── What this replaces, and why ────────────────────────────────────────────
 * The previous knockout (src/components/tournament/KnockoutAnimation.tsx, and
 * deleted in the same commit as this file was added) was a 3.6s FULL-SCREEN
 * overlay: vignette, rays, shockwave, a floating head that cracked and fell,
 * a count-up and a PKO split panel. It was well built and it was the wrong
 * shape. Three things the reference does that a centre overlay structurally
 * cannot:
 *
 *   1. IT HAPPENS WHERE IT HAPPENED. The glove, the star and the stamp all
 *      land on the busted player's own chair, so you learn WHO went out from
 *      the animation itself. The overlay named two players in text and left
 *      you to find the seat afterwards.
 *
 *   2. SIMULTANEOUS KNOCKOUTS ARE SIMULTANEOUS. In the reference's three-way
 *      all-in both victims get their own glove, their own star and their own
 *      stamp ON THE SAME FRAMES. The overlay was fed through
 *      useAnimationQueue, so the second knockout waited 3.6 seconds and then
 *      replayed the whole ceremony — by which time the table had moved on.
 *
 *   3. IT DOES NOT COVER THE FELT. A knockout arrives while you may be in a
 *      hand. The old overlay was pointer-events:none so it never ate a click,
 *      but it still dimmed and covered the board for 3.6s.
 *
 * ─── The beats (measured, 30fps, t0 = the frame the glove appears) ──────────
 *   t0      glove slides in from the LEFT of the busted seat
 *   +460ms  IMPACT — white-hot spiked star, glove already driven through
 *   +540ms  the star breaks into embers, the glove rotates away right
 *   +930ms  the red KO stamp SLAMS on, and the bounty ships (see TablePage)
 *   +2400ms the stamp fades. The seat is long since EMPTY underneath it.
 *
 * The stamp OUTLIVING the seat is deliberate and is what the reference does:
 * the avatar, the cards and the name are gone while KO still burns over the
 * empty chair. Because this layer is a sibling of the seat ring rather than a
 * child of a seat, the seat vacating cannot unmount it.
 *
 * ─── Why the glove is inline SVG ────────────────────────────────────────────
 * Dan chose vector over a sprite sheet. It is crisp at every seat size, it
 * costs no network request (so the FIRST knockout of a session animates, which
 * a lazily-fetched PNG cannot promise), and it carries no <defs> ids — two
 * tables in a multi-table view mount two of these layers, and duplicated
 * gradient ids in one document silently repaint each other. Flat fills with
 * overlaid translucent shading instead.
 */

import React, { useEffect, useRef } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import './SeatKnockout.css';

/** One player busting. Several of these can be live at once, on purpose. */
export interface SeatKnockoutHit {
  /** Stable per knockout — the bounty award, or the eliminated user id. */
  id: string;
  /** PHYSICAL seat index (0-based) of the player who busted. */
  seatIndex: number;
  /** Who busted. Announced to assistive tech; never drawn. */
  eliminatedName: string;
  /** True when the hero threw the punch — a warmer stamp bloom, nothing else. */
  isHero?: boolean;
}

export interface SeatKnockoutLayerProps {
  hits: SeatKnockoutHit[];
  /**
   * The hero-rotated seat percentages the seat ring itself renders from
   * (TablePage `seatPositions`). Indexed by physical seat index.
   */
  seatPositions: Array<{ x: number; y: number } | null | undefined>;
  /** Called with the hit id once its last frame has played. */
  onDone: (id: string) => void;
  /** False on a background table — visuals still run, audio does not. */
  playSounds?: boolean;
}

/* ── The beats, in milliseconds at speed 1 ──────────────────────────────────
   These are the JS half of a pair. SeatKnockout.css carries the same numbers
   as calc(<n>s * var(--animation-speed, 1)), and BOTH halves multiply by the
   player's speed setting. The retired overlay scaled only its JS timers, which
   is how it managed to strip its own stamp mid-keyframe at 0.5x. */
export const SKO_IMPACT_AT_MS = 460;
export const SKO_STAMP_AT_MS = 930;
export const SKO_DURATION_MS = 2400;
/** Reduced motion still has to leave the stamp on screen long enough to READ. */
export const SKO_REDUCED_DURATION_MS = 1400;

const RAY_COUNT = 12;

/** Ember drift, in --sko-unit multiples. Fixed, not random: a knockout must
 *  look the same every time it plays, and Math.random() in a render body also
 *  re-scatters the sparks on any re-render mid-flight. */
const EMBERS: ReadonlyArray<readonly [number, number]> = [
  [-0.42, 0.3],
  [-0.24, 0.44],
  [0.02, 0.5],
  [0.28, 0.42],
  [0.46, 0.26],
  [-0.5, 0.08],
  [0.36, -0.18],
  [-0.16, -0.3],
];

/**
 * The glove. Right-facing, laced cuff at the wrist, drawn flat with translucent
 * shading on top — see the header note on why there are no gradient <defs>.
 */
function GloveArt() {
  return (
    <svg viewBox="0 0 128 96" aria-hidden="true" focusable="false">
      {/* cuff */}
      <rect x="2" y="27" width="31" height="42" rx="9" fill="#f1e6d0" />
      <path d="M2 50h31v10a9 9 0 0 1-9 9H11a9 9 0 0 1-9-9z" fill="#000" opacity="0.16" />
      {/* wrist lacing */}
      <path
        d="M11 32v32M20 30v36M29 32v32"
        stroke="#c6b28a"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* fist */}
      <path
        d="M31 19h35c26 0 46 13 46 29S92 77 66 77H31c-7 0-12-5-12-12V31c0-7 5-12 12-12z"
        fill="#d51616"
      />
      {/* lit top edge */}
      <path d="M33 25h33c19 0 34 6 41 14-9-9-24-14-41-14H33z" fill="#ff7b6b" opacity="0.85" />
      <ellipse cx="55" cy="35" rx="16" ry="7" fill="#fff" opacity="0.26" />
      {/* shaded underside */}
      <path d="M31 77h35c22 0 40-9 45-22-2 17-21 29-45 29H31z" fill="#5f0303" opacity="0.5" />
      {/* knuckle crease */}
      <path
        d="M78 28c8 9 8 30 0 39"
        stroke="#8e0808"
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
      {/* thumb */}
      <path d="M38 58c0-9 8-14 17-14 11 0 18 7 18 16s-8 17-18 17H43c-3 0-5-3-5-6z" fill="#bd1111" />
      <path
        d="M43 50c4-3 9-4 13-4 8 0 14 3 17 8-4-7-11-10-18-10-4 0-9 2-12 6z"
        fill="#ff7b6b"
        opacity="0.6"
      />
    </svg>
  );
}

/** One seat's knockout. Keyed by hit id so a repeat on the same seat replays. */
function SeatKnockoutHitView({
  hit,
  pos,
  onDone,
  playSoundsRef,
}: {
  hit: SeatKnockoutHit;
  pos: { x: number; y: number } | null;
  onDone: (id: string) => void;
  playSoundsRef: React.MutableRefObject<boolean>;
}) {
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  /* A hit we cannot place still has to EXPIRE. This view is mounted either
     way and always owns the done timer; without that, a knockout arriving for
     a seat this client has never seen would sit in the parent's array forever
     and leak a little more on every one. Only the drawing and the audio are
     conditional. Boolean rather than the position object so the effect's
     dependency is stable across the re-render that follows any table resize. */
  const placed = !!pos;

  useEffect(() => {
    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();
    const timers: ReturnType<typeof setTimeout>[] = [];

    // The swing goes out on the FIRST frame, with the glove. Two cues rather
    // — unless there is no seat to draw on, in which case this hit is silent
    // as well as invisible (see the `pos` guard in the render below).
    // than one because the reference's audio is two distinct bursts — the
    // wind-up whoosh (t0..+250ms) and the hit (+460ms..+1000ms) — and a single
    // cue on impact leaves the 460ms of travel silent.
    if (placed && playSoundsRef.current) {
      try {
        soundService.playKnockoutSwing();
      } catch {
        /* audio is best-effort — it never gets to break the visual */
      }
      timers.push(
        setTimeout(
          () => {
            try {
              soundService.playKnockoutImpact(!!hit.isHero);
            } catch {
              /* see above */
            }
          },
          // Reduced motion skips the swing entirely, so the hit lands at once
          // rather than after a wind-up nobody can see.
          (reduced ? 0 : SKO_IMPACT_AT_MS) * speed
        )
      );
    }

    timers.push(
      setTimeout(
        () => onDoneRef.current(hit.id),
        (reduced ? SKO_REDUCED_DURATION_MS : SKO_DURATION_MS) * speed
      )
    );

    timersRef.current = timers;
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // `hit.id` identity is the retrigger. playSounds is read through the ref
    // it arrives in (see the layer below) so a multi-table tab switch cannot
    // restart a knockout mid-flight — that bug cost the old overlay its whole
    // sequence and is pinned in tests/animations-always-play.law.test.ts.
  }, [hit.id, hit.isHero, placed, playSoundsRef]);

  // Nothing to draw on. The timer above still runs, so the parent is told.
  if (!pos) return null;

  return (
    <div
      className={`sko${hit.isHero ? ' sko--hero' : ''}`}
      style={
        {
          '--sko-x': `${pos.x}%`,
          '--sko-y': `${pos.y}%`,
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`${hit.eliminatedName} knocked out`}
    >
      <div className="sko__glove" aria-hidden="true">
        <GloveArt />
      </div>

      <div className="sko__burst" aria-hidden="true">
        {Array.from({ length: RAY_COUNT }, (_, i) => (
          <span
            key={i}
            className="sko__ray"
            style={{ ['--sko-ray-i' as string]: i } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="sko__core" aria-hidden="true" />

      {EMBERS.map(([ex, ey], i) => (
        <span
          key={i}
          className="sko__ember"
          aria-hidden="true"
          style={
            {
              '--sko-ember-x': ex,
              '--sko-ember-y': ey,
              animationDelay: `calc((0.54s + ${i * 0.018}s) * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        />
      ))}

      {/* The one element whose DURATION is information rather than drama, so
          the one element exempted from the global reduced-motion collapse. */}
      <div className="sko__stamp" data-motion="keep" aria-hidden="true">
        KO
      </div>
    </div>
  );
}

export default function SeatKnockoutLayer({
  hits,
  seatPositions,
  onDone,
  playSounds = true,
}: SeatKnockoutLayerProps) {
  // ANIMATION AUDIT 2026-08-27, inherited from the overlay this replaces:
  // `playSounds` (ambientSoundsAllowed) flips on EVERY multi-table tab switch.
  // As an effect dependency it restarted the whole sequence mid-flight. It
  // gates audio only, so it is read through a ref and never listed as a dep.
  const playSoundsRef = useRef(playSounds);
  playSoundsRef.current = playSounds;

  if (!hits.length) return null;

  return (
    <div className="sko-layer" aria-hidden={false}>
      {hits.map((hit) => (
        // Every hit is MOUNTED, including one whose seat cannot be resolved —
        // that view draws nothing but still expires itself. Filtering here
        // instead would strand the unplaceable hit in the parent's array.
        // Drawing it at a 50/50 fallback is the other wrong answer: it puts a
        // boxing glove in the middle of the board.
        <SeatKnockoutHitView
          key={hit.id}
          hit={hit}
          pos={seatPositions[hit.seatIndex] ?? null}
          onDone={onDone}
          playSoundsRef={playSoundsRef}
        />
      ))}
    </div>
  );
}
