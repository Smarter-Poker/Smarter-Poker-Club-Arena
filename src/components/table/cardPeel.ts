/**
 * CARD PEEL - the near edge lifts and the face comes up from the bottom
 *
 * THE DIRECTION IS DAN'S CALL, NOT MY READING OF HIS VIDEO. That distinction
 * is the whole reason this header exists, because I got it wrong twice by
 * treating a shaky handheld clip as a spec:
 *
 *   v1  folded a CORNER diagonally, page-curl style, with a dog-ear flap
 *   v2  a horizontal boundary, face revealed BOTTOM-UP
 *   v3  I re-read the video frame by frame, decided the face arrived from the
 *       TOP, and "corrected" v2 into it. Shipped 2026-09-05.
 *   v4  Dan watched v3 on his phone: "THE CARDS ARE 'PEELING BACKWARDS' TOP TO
 *       BOTTOM INSTEAD OF THE WAY I SHOWED YOU IN THE PREVIOUS VIDEO."
 *
 * So v2 was right and I broke it. Worth being precise about how, because the
 * mistake was not carelessness - it was inferring physics from 220x480 video:
 * v2's "still backwards" complaint was made while PRODUCTION was still serving
 * v1's corner curl, so it was never a verdict on v2's direction at all. I
 * treated it as one, went looking for a different answer in the frames, and
 * found one, because a bent card at that resolution supports either reading.
 *
 * THE RULE THIS LEAVES BEHIND: a direction Dan has watched and named beats a
 * direction derived from footage. If a future frame-by-frame pass seems to
 * show the face arriving from the top, it is the pass that is wrong.
 *
 * The model: the boundary starts at the bottom edge and travels UP. Below it
 * is face, above it is back, and the back recedes upward as the drag grows.
 *
 * Coordinates are card-local pixels, origin top-left, y down.
 */

export type PeelInput = {
  /** Card size in px, measured when the finger went down. */
  width: number;
  height: number;
  /** How far the finger has travelled UP from where it went down, px. */
  lift: number;
};

export interface PeelFrame {
  /**
   * 0 = flat on the felt, 1 = tipped far enough that the whole face is showing.
   * A drag of one card-height is a full peel.
   */
  progress: number;
  /** Where the boundary between face and back sits, as a % from the TOP. */
  foldPercent: number;
  /** `inset()` clip for the BACK: everything ABOVE the boundary. */
  backClip: string;
  /** `inset()` clip for the FACE: everything BELOW the boundary. */
  faceClip: string;
  /** How far the pair is tipped toward the player, degrees. */
  bendDeg: number;
}

/** A card lying flat on the felt: all back, no face. */
export function flatPeel(): PeelFrame {
  return {
    progress: 0,
    foldPercent: 100,
    backClip: 'inset(0 0 0 0)',
    faceClip: 'inset(100% 0 0 0)',
    bendDeg: 0,
  };
}

export function computePeel(input: PeelInput): PeelFrame {
  const height = Math.max(1, input.height);
  // A full card-height of upward travel is a full peel. Downward travel (a
  // finger pushing the card back down) is simply flat.
  const progress = Math.max(0, Math.min(1, input.lift / height));
  if (progress <= 0) return flatPeel();

  // The boundary starts at the bottom edge (100%) and travels UP to the top
  // (0%) - the face growing upward, the back receding above it.
  const foldPercent = Math.round((1 - progress) * 10000) / 100;

  return {
    progress,
    foldPercent,
    // The back keeps the part ABOVE the boundary: clip its bottom off.
    backClip: `inset(0 0 ${100 - foldPercent}% 0)`,
    // The face shows the part BELOW the boundary: clip its top off.
    faceClip: `inset(${foldPercent}% 0 0 0)`,
    // The pair tips toward the player as it comes up off the felt. Peaks in
    // the middle of the drag: held flat to the eye at the end, it is square
    // to the player again.
    bendDeg: Math.round(Math.sin(progress * Math.PI) * 14 * 100) / 100,
  };
}

/** The lift, in px, that corresponds to a given progress. For tweening. */
export function liftAtProgress(height: number, progress: number): number {
  return Math.max(0, Math.min(1, progress)) * Math.max(1, height);
}
