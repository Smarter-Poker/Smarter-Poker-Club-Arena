/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PORTRAIT LOCK — the felt is a portrait oval, so the table is portrait only
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "lock it, portrait mode only."
 *
 * ─── WHY A PROMPT AND NOT AN ACTUAL LOCK ───────────────────────────────────
 *
 * `screen.orientation.lock()` is not a lock you can rely on. It rejects unless
 * the document is fullscreen, it is absent from iOS Safari entirely, and on the
 * browsers that do have it the promise rejects rather than throwing. It is
 * attempted below because where it works it is strictly better than a prompt
 * (the screen simply does not turn), and every failure path is swallowed,
 * because a rejected orientation lock is the expected case rather than an error.
 *
 * The prompt is the actual mechanism. It is what every phone poker client does,
 * for the same reason.
 *
 * ─── WHY THE TABLE CANNOT SIMPLY BE MADE TO WORK IN LANDSCAPE ──────────────
 *
 * Measured with `scripts/dev/measure-felt.mjs` on 2026-08-28: an 844x390 phone
 * in landscape renders a **96px** felt, with a PLO4 hole-card row at 103% of it.
 * `.table-scaler` is `aspect-ratio: 605/1000` and takes its width from leftover
 * HEIGHT, so a 390px-tall viewport cannot produce a table wider than ~175px
 * however the reserves are tuned. Proportional card sizing (same date) improved
 * the ratio and could not fix the cause.
 *
 * The fix for landscape would be a landscape oval, and TablePage.css:869 states
 * what that costs: the 605/1000 aspect is the crop of the canonical 896x1200
 * skin composites, and "the seat ring percentages in TablePage.tsx are derived
 * from THIS box; changing the aspect moves every seat off the painted rail." New
 * artwork plus a second seat ring. Until that exists, landscape is not a smaller
 * table, it is a broken one, and showing a player a broken table is worse than
 * asking them to turn the phone back.
 *
 * ─── VISIBILITY IS PURE CSS, DELIBERATELY ──────────────────────────────────
 *
 * There is no resize listener, no orientation event handler and no state here.
 * The overlay is always rendered on a table route and a media query decides
 * whether it is displayed. Three reasons, and the third is the one that matters:
 *
 *   1. No flash. A JS-driven version paints the table for a frame mid-rotation.
 *   2. No re-render. Rotating a phone fires a burst of resize events, and this
 *      component sits above four mounted TablePages.
 *   3. IT UNCOVERS THE TABLE THE INSTANT THE PHONE IS UPRIGHT. A player who
 *      rotates mid-hand is on a clock — the server is authoritative, the other
 *      players are waiting, and nothing here can pause their turn timer. The
 *      cost of covering the felt is measured in folded hands, so the uncovering
 *      has to be a style recalculation and not a React commit.
 *
 * That clock is also why the copy says the hands are still live. It is stated
 * unconditionally rather than only when it is the hero's turn: turn state lives
 * in MultiTablePage, BELOW this layer, and lifting it up through the component
 * whose entire job is to never unmount is a worse trade than a sentence that is
 * true in every case.
 */

import { useEffect } from 'react';
import './PortraitLock.css';

export default function PortraitLock({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    /* Best effort only. Rejects outside fullscreen, absent on iOS, and both are
       normal — the overlay below is the mechanism that actually holds. */
    const orientation = window.screen?.orientation as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
      | undefined;
    void orientation?.lock?.('portrait').catch(() => {});
    return () => {
      try {
        orientation?.unlock?.();
      } catch {
        /* Same story in reverse: nothing to report and nothing to recover. */
      }
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className="portrait-lock" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div className="portrait-lock__inner">
        {/* A phone that turns upright and stays there, so the instruction is
            legible before the text is read.

            NO data-motion="keep" HERE, and that is deliberate (corrected
            2026-08-28). That attribute is the reduced-motion ESCAPE HATCH —
            it means "this animation must survive because its DURATION is the
            information", like a countdown ring. This turn is emphasis, not
            duration: the meaning is the phone's upright END STATE, not how long
            it took to get there. So reduced motion should and does collapse it,
            which is exactly what the rule at the foot of PortraitLock.css does.
            Marking it "keep" claimed the opposite and was a no-op besides, since
            that same rule out-specifies the global kill either way. */}
        <svg
          className="portrait-lock__icon"
          viewBox="0 0 120 120"
          aria-hidden="true"
          focusable="false"
        >
          {/* No className: nothing styles it. The rect is painted entirely by
              its own presentation attributes and inherits `color` from the svg,
              so a hook that no rule uses is just a name to grep for later. */}
          <rect
            x="38"
            y="18"
            width="44"
            height="84"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
          />
          <line
            x1="53"
            y1="95"
            x2="67"
            y2="95"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        </svg>

        <h2 className="portrait-lock__title">Rotate Your Device</h2>
        <p className="portrait-lock__body">
          Club Arena Plays In Portrait Only. Turn Your Phone Upright To Return To The Table.
        </p>
        <p className="portrait-lock__note">Your Hands Are Still Live.</p>
      </div>
    </div>
  );
}
