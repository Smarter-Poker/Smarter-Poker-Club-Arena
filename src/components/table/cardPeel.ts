/**
 * CARD PEEL - tilting the far edge of a face-down card toward you
 *
 * REWRITTEN 2026-09-05 from Dan's own video of himself doing it with real
 * cards (CARD PEELING.MOV), frame by frame. Two earlier versions were wrong in
 * two different ways, and the frames settle both:
 *
 *   v1  folded a CORNER diagonally, page-curl style, with a dog-ear flap and a
 *       synthetic index printed under it. He does not do that.
 *   v2  folded a horizontal line and revealed the face BOTTOM-UP. Also wrong,
 *       and it is what "THE CARDS ARE STILL BACKWARDS" was about.
 *
 * What the frames actually show (fps=4, frames 7-19):
 *
 *   f07   both cards flat on the table, face down, full red back
 *   f09   a thin band of FACE along the TOP: the Q and the J indices, side by
 *         side, right way up. Red back still showing below them.
 *   f11   the band is taller - the court art starts appearing UNDER the indices
 *   f13   taller again, most of both faces readable
 *   f17   effectively the whole pair, a sliver of red left at the edge
 *
 * So he is not folding the card over at all: he TIPS the pair up, far edge
 * toward himself, pivoting on the near edge. As the tilt grows, the face comes
 * into view from the TOP DOWN and reads the right way up the whole time - which
 * is exactly why nothing in here mirrors or reflects any more. The indices are
 * first because they are printed at the top-left; that is the reveal doing its
 * job, not something we draw.
 *
 * Both cards move together as one, always.
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
  /** `inset()` clip for the BACK: everything BELOW the boundary. */
  backClip: string;
  /** `inset()` clip for the FACE: everything ABOVE the boundary. */
  faceClip: string;
  /** How far the pair is tipped toward the player, degrees. */
  bendDeg: number;
}

/** A card lying flat: all back, no face. */
export function flatPeel(): PeelFrame {
  return {
    progress: 0,
    foldPercent: 0,
    backClip: 'inset(0 0 0 0)',
    faceClip: 'inset(0 0 100% 0)',
    bendDeg: 0,
  };
}

export function computePeel(input: PeelInput): PeelFrame {
  const height = Math.max(1, input.height);
  // A full card-height of upward travel is a full peel. Downward travel (a
  // finger pushing the card back down) is simply flat.
  const progress = Math.max(0, Math.min(1, input.lift / height));
  if (progress <= 0) return flatPeel();

  // The boundary starts at the top edge (0%) and travels down to the bottom
  // (100%) - the face growing downward, the back shrinking away beneath it.
  const foldPercent = Math.round(progress * 10000) / 100;

  return {
    progress,
    foldPercent,
    // The back keeps the part BELOW the boundary: clip its top off.
    backClip: `inset(${foldPercent}% 0 0 0)`,
    // The face shows the part ABOVE the boundary: clip its bottom off.
    faceClip: `inset(0 0 ${100 - foldPercent}% 0)`,
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
