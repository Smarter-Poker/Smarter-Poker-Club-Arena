/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOW MANY COPIES, AND HOW FAST - the geometry of a seamless rail
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * TWO BUGS, ONE CAUSE: the marquee was authored without measuring anything.
 *
 * DEAD RAIL. The message was duplicated exactly twice and animated to
 * `translateX(-50%)`. That is seamless only while two copies are wider than the
 * strip. On a 2560px display with a typical 390px announcement the scroller is
 * 780px inside a 2530px track, so about 1,750px of EMPTY BAR sweeps across, and
 * both copies are on screen at once with nothing after them. It is the single
 * most visible thing in the screenshot that opened this audit.
 *
 * The fix is not "duplicate more". It is: repeat until the content is at least
 * one track-width longer than the distance travelled, and travel exactly one
 * COPY WIDTH rather than a percentage of a scroller whose width changes with
 * the message.
 *
 * FIXED DURATION. `--ticker-speed` was a whole-loop duration - 24 seconds for
 * one short countdown and 24 seconds for eight joined operational messages, so
 * the same operator setting produced a crawl on one bar and an unreadable blur
 * on the next. Broadcast rails are specified in pixels per second for exactly
 * this reason.
 *
 * `speedSeconds` KEEPS ITS NAME, ITS RANGE AND ITS DIRECTION. It is stored in
 * `game_ticker_settings.settings.speed_seconds`, clamped 8..60 by the RPC, and
 * a club has already chosen a number. Reinterpreting rather than migrating
 * means no DDL, no re-education, and the slider still runs fast-to-slow. The
 * default 24 lands on 55 px/sec, which is mid-range for a television lower
 * third and the pace this was tuned against.
 *
 * Pure on purpose: numbers in, numbers out, asserted in
 * tests/unit/tickerMarqueeMetrics.test.ts without mounting anything.
 */

/** Slowest and fastest a club is allowed to make the rail. */
export const MIN_PX_PER_SECOND = 20;
export const MAX_PX_PER_SECOND = 160;

/** The constant that maps the stored duration onto a pace. 1320 / 24 = 55. */
const PACE_CONSTANT = 1320;

/** Reading pace for a stored `speed_seconds`. Lower seconds, faster rail. */
export function pxPerSecondFor(speedSeconds: number): number {
  const seconds = Number(speedSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 55;
  return Math.max(
    MIN_PX_PER_SECOND,
    Math.min(MAX_PX_PER_SECOND, Math.round(PACE_CONSTANT / seconds))
  );
}

export interface MarqueeInput {
  /** Visible width of the scrolling region. */
  trackWidth: number;
  /** Width of ONE copy of the message, including its own padding. */
  copyWidth: number;
  /** Reading pace. */
  pxPerSecond: number;
}

export interface MarqueeMetrics {
  /** How many times to render the message inside the scroller. */
  copies: number;
  /** How far the scroller travels before the loop restarts, in px. */
  travelPx: number;
  /** Seconds for one loop. */
  durationSeconds: number;
  /**
   * The message fits: centre it and do not move.
   *
   * Motion on a rail should mean "there is more to read". A single sentence
   * gliding past an empty bar for no reason is the difference between an
   * announcement and a widget.
   */
  isStatic: boolean;
}

const STILL: MarqueeMetrics = {
  copies: 1,
  travelPx: 0,
  durationSeconds: 0,
  isStatic: true,
};

/**
 * @param input measured widths and the pace
 * @returns how to render the scroller
 */
export function marqueeMetrics(input: MarqueeInput): MarqueeMetrics {
  const track = Number(input.trackWidth);
  const copy = Number(input.copyWidth);
  const pace = Number(input.pxPerSecond);

  // Nothing measured yet, or a message with no width: hold still rather than
  // animate against numbers we do not have. The first ResizeObserver callback
  // arrives a frame later and settles it.
  if (!Number.isFinite(copy) || copy <= 0) return STILL;
  if (!Number.isFinite(track) || track <= 0) return STILL;
  if (copy <= track) return STILL;

  const speed =
    Number.isFinite(pace) && pace > 0
      ? Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, pace))
      : 55;

  // The scroller travels one copy width. At the end of that travel the window
  // [0, track] is reading scroller pixels [copy, copy + track], so the content
  // has to extend at least that far or the tail of the loop is empty rail.
  const copies = Math.max(2, Math.ceil(1 + track / copy));

  return {
    copies,
    travelPx: copy,
    durationSeconds: Math.max(1, Math.round((copy / speed) * 10) / 10),
    isStatic: false,
  };
}
