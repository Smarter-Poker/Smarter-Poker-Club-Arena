/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEAT KNOCKOUT — a bounty being taken, ON THE SEAT it was taken from
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, with a PokerBros capture attached: "NOTICE THE DETAILS AND
 * ANIMATIONS OF THE BOXING GLOVES KNOCKING OUT THE OPPONENT ... IT SHOULD BE AS
 * CLOSE TO 1:1 AS YOU CAN."
 *
 * Dan 2026-08-29, on the first cut: "THATS A START, GRAPHICS AND ANIMATION
 * LOOKS LIKE SHIT THOUGH AND NEEDS TO BE UPGRADED BADLY!"
 *
 * Dan 2026-08-29, with two branded glove renders and a second capture:
 * "I'VE ATTACHED A PREMIUM LEFT AND RIGHT BOXING GLOVE THAT YOU SHOULD BE
 * USING... PLUS A VIDEO OF HOW IT SHOULD LOOK WITH TWO GLOVES." And then:
 * "THE ANIMATIONS SHOULD BE LARGER, DURING A KO IN A TOURNAMENT, THIS VIDEO IS
 * FROM A THROWABLE IN THE CASH GAME, BUT SAME IDEA AND PRINCIPLE."
 *
 * So this is not one glove creeping in and striking once. It is a FLURRY of
 * two branded gloves, at tournament scale.
 *
 * ─── What this replaces, and why ────────────────────────────────────────────
 * The previous knockout (src/components/tournament/KnockoutAnimation.tsx, and
 * deleted in the same commit as this file was added) was a 3.6s FULL-SCREEN
 * overlay: vignette, rays, shockwave, a floating head that cracked and fell,
 * a count-up and a PKO split panel. It was well built and it was the wrong
 * shape. Three things the reference does that a centre overlay structurally
 * cannot:
 *
 *   1. IT HAPPENS WHERE IT HAPPENED. The gloves, the star and the stamp all
 *      land on the busted player's own chair, so you learn WHO went out from
 *      the animation itself. The overlay named two players in text and left
 *      you to find the seat afterwards.
 *
 *   2. SIMULTANEOUS KNOCKOUTS ARE SIMULTANEOUS. In the reference's three-way
 *      all-in both victims get their own gloves, their own star and their own
 *      stamp ON THE SAME FRAMES. The overlay was fed through
 *      useAnimationQueue, so the second knockout waited 3.6 seconds and then
 *      replayed the whole ceremony — by which time the table had moved on.
 *
 *   3. IT DOES NOT COVER THE FELT. A knockout arrives while you may be in a
 *      hand. The old overlay was pointer-events:none so it never ate a click,
 *      but it still dimmed and covered the board for 3.6s.
 *
 * All three are architecture and are UNCHANGED. What changed is every pixel.
 *
 * ═══ THE FLURRY, MEASURED ═══════════════════════════════════════════════════
 *
 * The second capture (KO KNOCKOUT.MOV) is a cash-game throwable, so it is the
 * CHOREOGRAPHY that transfers, not the scale. Read frame by frame at 30fps,
 * and confirmed against its own audio track by onset detection:
 *
 *   - punches ALTERNATE, one glove from the lower left, one from the lower
 *     right, each arriving on its own diagonal;
 *   - they land 64-272ms apart (seven onsets across 0.9s), which is a flurry,
 *     not a swing;
 *   - every landing throws its own small WARM burst at the contact point —
 *     orange-gold, not the white of the big finish;
 *   - the head snaps on each landing and the gloves withdraw between them.
 *
 * Our three beats, inside the same 930ms the stamp has always waited for:
 *
 *   t0+180ms   RIGHT glove lands           (warm burst, seat snaps)
 *   t0+320ms   LEFT glove lands            (warm burst, seat snaps)
 *   t0+460ms   BOTH land together          (the white star — SKO_IMPACT_AT_MS)
 *   t0+930ms   the red KO stamp SLAMS on, and the bounty ships (TablePage)
 *   t0+2400ms  the stamp fades. The seat is long since EMPTY underneath it.
 *
 * The finisher stays at 460ms and the stamp at 930ms because those are the
 * numbers TablePage's bounty coalescing and the law tests are built on. The
 * flurry fits INSIDE the window that already existed.
 *
 * The stamp OUTLIVING the seat is deliberate and is what the reference does:
 * the avatar, the cards and the name are gone while KO still burns over the
 * empty chair. Because this layer is a sibling of the seat ring rather than a
 * child of a seat, the seat vacating cannot unmount it.
 *
 * ═══ THE GLOVES ARE DAN'S ART, NOT A DRAWING OF IT ══════════════════════════
 *
 * Two branded renders, `public/images/knockout/glove-{left,right}.webp`, 512px
 * wide at q86 (~58KB each). They are NOT inlined and they are NOT imported
 * into the bundle: they go through `mediaUrl()` like every other large static
 * asset here, so they can be flipped to the CDN with VITE_MEDIA_BASE.
 *
 * They ARE preloaded at module scope. That matters and it is the reason the
 * first cut of this file drew the glove as vector at all — its header said "a
 * lazily-fetched PNG cannot promise the FIRST knockout of a session animates".
 * True, and solved properly: this module is imported by TablePage, so the
 * decode starts when a table opens and is long finished before anyone busts.
 * A hand-drawn glove is no longer worth the tradeoff now that there is real
 * art to use.
 *
 * WHICH GLOVE IS WHICH: the art is pre-rotated. `glove-left` has its cuff at
 * the lower LEFT and its fist up and to the right, so it is the glove that
 * arrives from the left. `glove-right` mirrors it. Neither is rotated by the
 * CSS beyond a few degrees of snap — rotating them to taste fights the
 * lighting baked into the render.
 *
 * ═══ THE REST OF THE REBUILD ════════════════════════════════════════════════
 *
 * 1. THE STAR IS ONE PATH, NOT TWELVE DIVS. Twelve <span> rays at exact
 *    30-degree increments cannot be irregular, and the reference's burst has
 *    no pattern in it at all. One hand-authored <path> is irregular by
 *    construction and costs one element instead of twelve.
 *
 * 2. THE STAMP IS SVG PATHS, NOT A SYSTEM FONT. 'Arial Black' does not exist
 *    on Android, so the one element here that carries INFORMATION rather than
 *    drama was the one rendering differently per device.
 *
 * 3. THE SEAT REACTS, ON EVERY PUNCH. Same mechanism ThrowAnimation has used
 *    since 2026-08-15: SeatSlot exposes `data-seat-num`, scoped to THIS table
 *    via closest('.table-page') so a multi-table view does not flinch the
 *    first seat in DOM order.
 *
 * 4. GRADIENT IDS ARE INSTANCE-SCOPED. SVG <defs> ids are global to the
 *    document and a multi-table view mounts one of these layers per table, so
 *    duplicate ids silently repaint each other. `useId()` solves it; nothing
 *    here may hardcode one again, and a test pins that.
 *
 * 5. PERFORMANCE. Worst case is eight simultaneous knockouts (a 9-handed
 *    table, one survivor). Everything animates transform and opacity only, and
 *    `will-change` is NOT set anywhere: a permanently-promoted layer per
 *    element per knockout is a GPU memory problem, and Chrome promotes a
 *    RUNNING transform animation on its own for exactly as long as it runs.
 *    Measured in Chrome with all eight going at once: mean 16.67ms/frame,
 *    p95 17.5ms — a clean 60fps.
 */

import React, { useEffect, useId, useRef } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { mediaUrl } from '../../utils/mediaBase';
import './SeatKnockout.css';

/** Dan's branded renders. See the header on why these are media URLs and not
 *  bundled imports, and on why they are preloaded. */
export const GLOVE_LEFT_URL = mediaUrl('images/knockout/glove-left.webp');
export const GLOVE_RIGHT_URL = mediaUrl('images/knockout/glove-right.webp');

/* WARM THE CACHE AT MODULE LOAD. TablePage imports this file, so both decodes
   start when a table opens — minutes before anyone busts — and the first
   knockout of a session animates with everything already in memory. Guarded
   for SSG/jsdom, where Image may not exist and nothing needs preloading. */
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  try {
    for (const src of [GLOVE_LEFT_URL, GLOVE_RIGHT_URL]) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }
  } catch {
    /* preloading is an optimisation; the <img> tags below still work */
  }
}

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
/** The three landings. The last one IS SKO_IMPACT_AT_MS — the flurry finishes
 *  on the beat everything downstream was already built around. */
export const SKO_PUNCH_AT_MS: readonly number[] = [180, 320, SKO_IMPACT_AT_MS];
/** How long the busted seat carries `seat--ko-flinch` per landing. Paired with
 *  the skoSeatFlinch keyframe in SeatKnockout.css — change both or neither. */
export const SKO_FLINCH_MS = 200;

/* ── Sparks ────────────────────────────────────────────────────────────────
   The star does not switch off, it COMES APART: in the reference the wedges
   break into a shower that lifts slightly, then falls, and the last of it
   lands below the seat plate on the name row.

   Sixteen entries, each [dx, dy, size, delayStep]. dx/dy are FINAL offsets in
   --sko-unit multiples; the midpoint is derived in CSS with an upward bias so
   the path is a ballistic arc rather than a straight line. `size` varies
   0.026-0.078 units — eight identical round dots read as a pattern, not an
   explosion.

   FIXED, NEVER Math.random(): a knockout must look the same every time it
   plays, and a random table in a render body also re-scatters the sparks on
   any re-render mid-flight. */
const EMBERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-0.7, 0.48, 0.058, 0],
  [-0.46, 0.7, 0.04, 3],
  [-0.18, 0.81, 0.07, 1],
  [0.11, 0.76, 0.035, 5],
  [0.4, 0.68, 0.05, 2],
  [0.68, 0.46, 0.064, 4],
  [0.84, 0.22, 0.032, 7],
  [-0.84, 0.16, 0.048, 6],
  [-0.62, -0.22, 0.038, 9],
  [-0.27, -0.46, 0.056, 8],
  [0.08, -0.54, 0.03, 11],
  [0.43, -0.4, 0.046, 10],
  [0.73, -0.11, 0.027, 13],
  [-0.11, 0.38, 0.078, 12],
  [0.27, 0.27, 0.035, 15],
  [-0.38, 0.22, 0.043, 14],
];

/** Trail direction, derived once at module load so a spark stretches ALONG the
 *  way it is travelling instead of being a round dot. Deterministic by
 *  construction — it is a pure function of the table above. */
const EMBER_ROT = EMBERS.map(([dx, dy]) => (Math.atan2(dy, dx) * 180) / Math.PI);

/* ── The impact star ───────────────────────────────────────────────────────
   Hand-authored against the capture at 30fps. FIFTEEN needles, tips 34-105
   against valleys of 10-16, so each arm's base is roughly a tenth of its own
   length. That ratio is the whole ballgame and it took three passes of the
   frame comparison to find: valleys of 13-23 photographed as a snowflake,
   valleys of 22-34 photographed as a sheriff's badge, and both were too
   EVENLY SPACED besides. The capture is a SPARKLER — long thin needles of
   wildly different lengths, and CLUSTERED: dense to the upper left and
   straight down, with a real gap out to the right. The angles are that
   distribution, not 360/15.

   Thirteen MORE, shorter, in a second set at 40% opacity and a different
   rotation, filling the gaps the first set leaves. Two interleaved irregular
   sets is what finally removed the rotational symmetry that makes a burst read
   as a decoration instead of an explosion.

   The same two paths are reused, small and tinted warm, for the two flurry
   landings — see `.sko__hit` in the CSS. */
const STAR_MAIN =
  'M4.9 86.6Q55.1 93.1 88.2 96.8Q74.0 90.2 49.9 79.8Q74.6 89.2 89.5 94.4Q64.9 77.0 27.0 50.8' +
  'Q65.3 75.3 90.4 90.4Q87.1 82.8 78.8 68.5Q88.8 81.7 94.6 87.9Q90.2 64.8 82.1 28.2' +
  'Q93.2 63.0 101.7 83.7Q119.9 53.9 145.6 6.5Q122.1 56.4 107.0 89.6Q115.3 81.9 129.4 67.3' +
  'Q117.9 82.9 113.2 92.0Q119.4 93.2 133.0 91.8Q120.5 97.0 115.7 101.1Q131.5 110.5 159.3 124.0' +
  'Q129.7 113.3 111.5 107.7Q133.4 132.9 168.1 170.5Q131.7 134.5 107.3 111.7Q110.3 124.7 117.1 147.0' +
  'Q107.8 125.8 101.5 114.4Q95.6 141.8 88.0 185.2Q92.8 141.3 94.9 113.2Q83.8 126.4 66.4 149.7' +
  'Q81.6 124.9 89.6 109.7Q59.3 125.1 13.4 150.0Q58.7 123.0 88.4 104.7Q78.0 106.2 59.2 110.2' +
  'Q77.2 104.6 86.5 100.7Q54.4 94.7 4.9 86.6Z';

const STAR_ALT =
  'M57.7 87.9Q77.0 91.9 87.5 92.8Q77.2 80.0 58.3 59.7Q79.2 78.3 92.3 88.5Q92.0 83.5 88.8 72.2' +
  'Q94.6 82.0 98.4 85.0Q103.0 73.0 108.7 50.8Q106.0 73.8 105.5 87.0Q111.2 82.3 121.2 70.9' +
  'Q113.7 83.9 111.5 90.7Q125.5 86.9 149.3 78.0Q127.2 90.0 115.3 98.1Q119.7 101.5 131.5 105.6' +
  'Q118.7 104.7 113.0 105.5Q123.1 115.2 142.1 130.6Q121.6 117.2 109.3 110.3Q111.0 116.7 117.0 129.4' +
  'Q108.8 118.2 104.0 113.9Q102.4 126.0 101.7 148.0Q99.4 126.1 97.0 114.2Q92.8 118.0 86.0 128.8' +
  'Q90.5 116.7 91.5 110.9Q80.3 118.1 61.7 132.1Q79.3 116.3 89.0 106.6Q84.5 107.2 74.0 110.5' +
  'Q82.4 104.8 83.9 100.8Q75.5 95.3 57.7 87.9Z';

/** Angular debris — six hard-edged slivers thrown clear of the star, distinct
 *  from the round-ish sparks. The reference throws these on the impact frame
 *  and they are gone two frames later. */
const STAR_SHARDS =
  'M46.6 65.1L-0.5 42.0L43.1 71.2ZM126.8 37.3L142.4 -16.5L119.8 34.7Z' +
  'M151.6 133.7L197.0 156.0L155.0 127.8ZM119.1 163.2L141.0 212.8L125.9 160.7Z' +
  'M51.6 136.3L15.7 170.7L55.9 141.4ZM154.7 83.4L197.7 64.4L152.6 77.5Z';

/** The KO stamp, as PATHS.
 *
 *  'Arial Black' is not installed on Android, so the first cut's font stack
 *  fell through to something much lighter for a large share of the userbase —
 *  the one element of this animation that carries INFORMATION rather than
 *  drama was the one element that rendered differently per device. Two
 *  hand-authored glyphs are pixel-identical everywhere, need no font load and
 *  cannot FOUT, and they can carry the bevel and the hard extrusion the
 *  reference's stamp plainly has and a text node cannot.
 *
 *  #FC0000 is the measured red, sampled off the capture. The first cut used
 *  #ff1f1f, which is visibly pinker.
 */
function StampArt({ uid }: { uid: string }) {
  const g = (n: string) => `sko-${n}-${uid}`;
  const K = 'M6 6h24v20L54 6h30L52 36l34 30H54L30 44v22H6Z';
  const O =
    'M96 6C114 6 126 19 126 36C126 53 114 66 96 66C78 66 66 53 66 36C66 19 78 6 96 6Z' +
    'M96 24C89 24 85 29 85 36C85 43 89 48 96 48C103 48 107 43 107 36C107 29 103 24 96 24Z';

  return (
    <svg viewBox="0 0 138 78" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={g('ko')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff5a44" />
          <stop offset="34%" stopColor="#fc0000" />
          <stop offset="100%" stopColor="#b60000" />
        </linearGradient>
      </defs>
      {/* The italic lean is the reference's, and it is slight — the first cut
          got its lean from a -9deg rotation wobble instead, which read as
          bouncy-cute rather than as a slam. */}
      <g transform="translate(6 4) skewX(-7)">
        {/* EXTRUSION — the stamped edge. Drawn first, offset down. */}
        <g transform="translate(0 4)" fill="#5c0000">
          <path d={K} />
          <path d={O} fillRule="evenodd" />
        </g>
        {/* FACE */}
        <g fill={`url(#${g('ko')})`}>
          <path d={K} />
          <path d={O} fillRule="evenodd" />
        </g>
        {/* TOP BEVEL — a light edge along the top of each glyph. */}
        <g
          transform="translate(0 -1.6)"
          fill="none"
          stroke="#ff9d86"
          strokeWidth="1.8"
          opacity="0.55"
        >
          <path d={K} />
          <path d={O} fillRule="evenodd" />
        </g>
      </g>
    </svg>
  );
}

/**
 * THE FLURRY ITSELF — position-agnostic, timer-free, sound-free.
 *
 * Split out 2026-08-29 because Dan asked for the same animation on the
 * `boxing_glove` THROWABLE: "SAME ANIMATION, SAME SOUND EFFECTS (MINUS THE
 * K.O. AT THE END)". A throwable is not a knockout — nobody has been
 * eliminated, no bounty ships, and stamping KO on a seat that is still
 * occupied would be a lie — so the stamp, its flash and its shockwave are
 * behind `showStamp`, and ThrowAnimation passes false.
 *
 * Everything positional lives on the PARENT `.sko` element. SeatKnockoutHitView
 * places it from the seat ring's own hero-rotated percentages; ThrowAnimation
 * places it in pixels at the target it already computed. Neither knows about
 * the other, and this component knows about neither.
 *
 * `uid` must be unique per mounted instance — SVG <defs> ids are global to the
 * document and duplicates silently repaint each other. Both callers pass
 * useId().
 */
export function KnockoutFlurry({ uid, showStamp = true }: { uid: string; showStamp?: boolean }) {
  return (
    <>
      {/* The felt's own reaction to the light. A flash that does not light
          anything around it is the tell that it is 2D — but the radius is
          SMALL: covering the board was the retired full-screen overlay's
          original sin and Dan rejected it. */}
      <div className="sko__light" aria-hidden="true" />

      {/* The crack: a thin, fast ring one frame behind the star. */}
      <div className="sko__ring" aria-hidden="true" />

      {/* DAN'S GLOVES — drawn BEFORE the bursts, so every burst blows out
          OVER the glove that caused it. That is the order the capture shows and
          it is the difference between a punch landing and a punch being
          politely covered up by its own flash.

          DAN'S GLOVES. `alt=""` and aria-hidden: the seat's own role="status"
          above already announces the knockout, and two more announcements per
          bust is noise in a screen reader. draggable=false because an <img>
          inside a pointer-events:none layer can still be dragged out of the
          page in some browsers, which would be a very strange thing to happen
          in the middle of a hand. */}
      <img
        className="sko__glove sko__glove--r"
        src={GLOVE_RIGHT_URL}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
      />
      <img
        className="sko__glove sko__glove--l"
        src={GLOVE_LEFT_URL}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
      />

      <svg
        className="sko__star"
        viewBox="-30 -30 260 260"
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id={`sko-burst-${uid}`} cx="0.5" cy="0.5" r="0.5">
            {/* MEASURED (251,252,255): the core is effectively PURE WHITE. The
                first cut went gold at 26% of the radius and photographed as a
                cartoon sun; white now holds past 45%. */}
            <stop offset="0%" stopColor="#fbfcff" />
            <stop offset="46%" stopColor="#fffdf7" />
            <stop offset="70%" stopColor="#fff4d9" />
            <stop offset="88%" stopColor="#ffdf9e" />
            <stop offset="100%" stopColor="#ffbe63" stopOpacity="0.75" />
          </radialGradient>
          {/* The flurry landings are WARM — orange-gold, measured off the
              second capture, where only the big finish is white. */}
          <radialGradient id={`sko-hit-${uid}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#fffdf4" />
            <stop offset="34%" stopColor="#ffe9a8" />
            <stop offset="72%" stopColor="#ffa93c" />
            <stop offset="100%" stopColor="#ff6a12" stopOpacity="0.85" />
          </radialGradient>
        </defs>
        <g className="sko__star-alt">
          <path d={STAR_ALT} fill={`url(#sko-burst-${uid})`} opacity="0.4" />
        </g>
        <g className="sko__star-main">
          <path d={STAR_MAIN} fill={`url(#sko-burst-${uid})`} />
        </g>
        <g className="sko__shards">
          <path d={STAR_SHARDS} fill="#fffdf4" />
        </g>
      </svg>

      <div className="sko__core" aria-hidden="true" />

      {/* ONE element for BOTH flurry landings. It flashes at +180ms on the
          right of the plate and again at +320ms on the left; between the two
          it is fully transparent, so the tween across the gap is invisible and
          a second element would have been a second element for nothing. */}
      <svg
        className="sko__hit"
        viewBox="-30 -30 260 260"
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="xMidYMid meet"
      >
        <path d={STAR_ALT} fill={`url(#sko-hit-${uid})`} />
      </svg>

      {EMBERS.map(([ex, ey, size], i) => (
        <span
          key={i}
          className="sko__ember"
          aria-hidden="true"
          style={
            {
              '--sko-ember-x': ex,
              '--sko-ember-y': ey,
              '--sko-ember-size': size,
              '--sko-ember-rot': `${EMBER_ROT[i].toFixed(1)}deg`,
              // Staggered so they do not all die on the same frame, which is
              // what made eight identical dots read as a pattern.
              animationDelay: `calc((0.54s + ${(EMBERS[i][3] * 0.014).toFixed(3)}s) * var(--animation-speed, 1))`,
              animationDuration: `calc((0.44s + ${((i % 4) * 0.05).toFixed(2)}s) * var(--animation-speed, 1))`,
            } as React.CSSProperties
          }
        />
      ))}

      {showStamp && (
        <>
          {/* The white frame the stamp lands ON, and the shockwave it pushes out. */}
          <div className="sko__flash" aria-hidden="true" />
          <div className="sko__stampring" aria-hidden="true" />

          {/* The one element whose DURATION is information rather than drama, so
            the one element exempted from the global reduced-motion collapse. */}
          <div className="sko__stamp" data-motion="keep" aria-hidden="true">
            <StampArt uid={uid} />
          </div>
        </>
      )}
    </>
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  /* Unique per component INSTANCE and stable across renders — this is what
     makes <defs> gradients safe in a multi-table view. */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

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

    /* THE WHOLE FLURRY IS ONE CUE, SCHEDULED ON THE AUDIO CLOCK.
       Not four setTimeouts. A main thread busy re-laying-out a table that just
       lost a seat drifts a timer by tens of milliseconds, and SoundService's
       50ms priority window then eats the late arrival outright — the same
       reasoning playDealSequence is built on, and the reason the KO stamp's
       tick has always been scheduled inside the impact cue rather than behind
       a third timer. `speed` goes in so the cue stretches with the player's
       Animation Speed exactly as the CSS does.

       Reduced motion collapses the visuals, so the audio collapses with them:
       one hit instead of a flurry nobody can see. */
    if (placed && playSoundsRef.current) {
      try {
        soundService.playKnockoutFlurry({
          isHero: !!hit.isHero,
          speed,
          punchesAtMs: reduced ? [0] : SKO_PUNCH_AT_MS,
          stampAtMs: reduced ? 120 : SKO_STAMP_AT_MS,
        });
      } catch {
        /* audio is best-effort — it never gets to break the visual */
      }
    }

    /* THE SEAT REACTS, ON EVERY LANDING. The capture snaps the head on each
       punch of the flurry and the first cut did nothing at all, which is why
       the punch read as landing on a photograph.

       Same mechanism ThrowAnimation has used since 2026-08-15, including the
       lesson that cost it a day: SCOPE IT TO THIS TABLE. A bare
       document.querySelector('[data-seat-num="3"]') hits the FIRST seat 3 in
       DOM order, which in a multi-table view is somebody else's table.

       data-seat-num is 1-BASED (TablePage: `const seatNumber = idx + 1`) and
       hit.seatIndex is 0-based, hence the +1. Getting that wrong flinches the
       neighbour, silently and plausibly.

       Reduced motion gets no flinch: it is pure motion and carries nothing a
       player needs to read, so it is dropped rather than collapsed. */
    if (placed && !reduced) {
      const findSeat = () => {
        const scope = rootRef.current?.closest('.table-page') ?? document;
        return scope.querySelector(`[data-seat-num="${hit.seatIndex + 1}"]`);
      };
      for (const at of SKO_PUNCH_AT_MS) {
        timers.push(
          setTimeout(() => {
            try {
              const seatEl = findSeat();
              if (!seatEl) return;
              /* Retrigger: removing and re-adding in the same frame does
                 nothing, because the style recalc coalesces. Forcing a reflow
                 between the two is what makes the SECOND and THIRD punches
                 actually snap the head instead of silently no-oping. */
              seatEl.classList.remove('seat--ko-flinch');
              void (seatEl as HTMLElement).offsetWidth;
              seatEl.classList.add('seat--ko-flinch');
              timers.push(
                setTimeout(
                  () => seatEl.classList.remove('seat--ko-flinch'),
                  // A cushion over the keyframe: an exact tie races the last
                  // frame and strips the class mid-animation.
                  (SKO_FLINCH_MS + 80) * speed
                )
              );
            } catch {
              /* the flinch is decorative — it never gets to break the punch */
            }
          }, at * speed)
        );
      }
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
      /* If this unmounts mid-flinch the class would be stranded on a seat that
         outlives us — the seat itself does not re-render it away. */
      try {
        const scope = rootRef.current?.closest('.table-page') ?? document;
        scope
          .querySelector(`[data-seat-num="${hit.seatIndex + 1}"]`)
          ?.classList.remove('seat--ko-flinch');
      } catch {
        /* nothing to clean up */
      }
    };
    // `hit.id` identity is the retrigger. playSounds is read through the ref
    // it arrives in (see the layer below) so a multi-table tab switch cannot
    // restart a knockout mid-flight — that bug cost the old overlay its whole
    // sequence and is pinned in tests/animations-always-play.law.test.ts.
  }, [hit.id, hit.isHero, hit.seatIndex, placed, playSoundsRef]);

  // Nothing to draw on. The timer above still runs, so the parent is told.
  if (!pos) return null;

  return (
    <div
      ref={rootRef}
      className={`sko${hit.isHero ? ' sko--hero' : ''}`}
      style={
        {
          '--sko-x': `${pos.x}%`,
          '--sko-y': `${pos.y}%`,
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      aria-label={`${hit.eliminatedName} Knocked Out`}
    >
      <KnockoutFlurry uid={uid} />
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
