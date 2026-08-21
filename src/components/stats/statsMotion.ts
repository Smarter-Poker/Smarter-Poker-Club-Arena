/**
 * Shared framer-motion variants for the player stats page.
 *
 * SCOPE, DELIBERATELY: this lives next to the stats components rather than in
 * `src/lib/`. A global animations module used to exist and was deleted on
 * 2026-08-19 in favour of framer-motion (see the note in src/lib/index.ts) —
 * resurrecting one under a new name would walk straight back into the thing
 * that was just removed. If a second page ever wants these, promote them then,
 * on purpose.
 *
 * REDUCED MOTION: every consumer must call framer-motion's `useReducedMotion()`
 * and swap in `instant` below. The page's CSS already has a
 * `prefers-reduced-motion` block, but that only kills CSS keyframes — it has no
 * effect on JS-driven transforms, so an accessibility setting that used to be
 * respected would silently stop being respected the moment animation moved to
 * framer-motion. This is the single easiest thing to get wrong here.
 */

import type { Variants, Transition } from 'framer-motion';

/** Swap into any `transition` prop when the user asked for reduced motion. */
export const instant: Transition = { duration: 0 };

/** Spring used for content that should feel physical rather than timed. */
export const springy: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 26,
  mass: 0.7,
};

/**
 * Tab body transition. `mode="wait"` on the parent AnimatePresence means the
 * outgoing tab finishes before the incoming one starts, so the two never
 * overlap and the page height never lurches mid-swap.
 */
export const tabTransition: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

/**
 * Parent of a list of cards or rows. Children inherit the stagger, so no child
 * needs a hardcoded delay.
 *
 * This replaces `:nth-child(1)`..`:nth-child(8)` delay rules in
 * PlayerStatsPage.css, which animated exactly the first eight rows and let
 * everything after them appear instantly — visible on the Performance tab,
 * which has more than eight.
 */
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.045, delayChildren: 0.02 },
  },
};

/** Child of `staggerContainer`. */
export const fadeUp: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

/** Charts earn a slightly heavier entrance than a stat row. */
export const chartReveal: Variants = {
  initial: { opacity: 0, y: 16, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
};
