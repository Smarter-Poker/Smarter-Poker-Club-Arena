/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  VPIP REQUIREMENT BADGE — a manufactured plaque with one digital readout
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 3: "VPIP NEEDS TO BE A SIMPLE SQUARE WITH THE MINIMUM
 * GAME REQUIREMENT AND THE USERS CURRENT VPIP INSIDE A SQUARE BOX NEXT TO THE
 * HERO, NOT A LARGE GENERIC RECTANGLE."
 *
 * His closing rule for the whole spec: **Data is dynamic. Design is immutable.**
 *
 * WHY THIS IS CSS AND NOT HIS PNG. Dan's own recommendation, and the spec's
 * section 3 states it as a prohibition: the supplied artwork carries `54%`
 * baked into it, so shipping the raster would freeze the one thing that has to
 * change. The frame, the bevel, the two blue accents and the typography are
 * rebuilt here from his tokens; the number is a real text node. That also
 * makes it razor-sharp at 34px on a 3x phone, which a downsampled 1254px
 * raster would not be.
 *
 * WHAT IS FIXED AND WHAT MOVES (spec §2). Fixed: every frame, both labels, the
 * blue, the geometry, and the MIN row. Dynamic: exactly one field, the current
 * VPIP percentage. Nothing else may become data-driven without Dan approving
 * it - in particular the badge does NOT colour itself green or red by whether
 * the player is passing (spec §25).
 *
 * ── THE ONE PLACE THIS SPEC MEETS PRODUCTION, AND IT DISAGREES ──────────────
 * Spec §1 says the minimum is `30 | 50` and that anything else must "fail
 * visibly in development and log an error rather than silently inventing
 * another display state".
 *
 * Live tables are not all 30 or 50. Dan's own screenshots in the same message
 * show "VPIP 40% MIN", and `fn_cash_vpip_status.required` returns whatever the
 * club configured. So a literal `throw` would take the felt down on every
 * table a club has set to 40.
 *
 * This implements exactly what §1 asks for and no more: DEV throws, so the
 * mismatch is impossible to miss while building; production reports it once
 * and prints the REAL configured number. Printing the truth is not inventing a
 * display state - inventing one would be rounding 40 to "MIN 50%" and telling
 * a player they are failing a rule that does not exist. Which of the two has
 * to move (the component's contract, or the clubs' config) is a product
 * decision, and it is flagged rather than guessed.
 */
import React, { useEffect, useRef } from 'react';
import { reportError } from '../../utils/errorReporter';
import './VpipRequirementBadge.css';

/** The two sanctioned game rules (spec §1). */
export type VpipRequirement = 30 | 50;

export const ALLOWED_VPIP_REQUIREMENTS: readonly number[] = [30, 50];

export interface VpipRequirementBadgeProps {
  /** The game's rule. Fixed for the life of the table (spec §2). */
  minimumVpip: VpipRequirement | number;
  /**
   * The player's authoritative current VPIP, percent. `null` means "never
   * loaded" and prints `--%`, which is NOT the same as 0% - zero is a real
   * statistic a player can hold (spec §22).
   */
  currentVpip: number | null;
  /**
   * Retained so a stale link can be exposed programmatically without the badge
   * changing what it says. Spec §21: a reconnect must never blank the figure.
   */
  status?: 'connected' | 'stale' | 'loading';
}

/**
 * Whole percentages, clamped 0-100 (spec §14).
 *
 * The clamp is DEFENSIVE RENDERING ONLY. It stops a corrupt value drawing
 * outside the window; it does not make the value correct, and the caller is
 * still responsible for reporting bad data rather than letting this hide it.
 */
export function formatVpipValue(currentVpip: number | null | undefined): string {
  if (currentVpip == null || !Number.isFinite(Number(currentVpip))) return '--%';
  const clamped = Math.min(100, Math.max(0, Number(currentVpip)));
  return `${Math.round(clamped)}%`;
}

export function isAllowedVpipRequirement(min: number): min is VpipRequirement {
  return min === 30 || min === 50;
}

function VpipRequirementBadgeInner({
  minimumVpip,
  currentVpip,
  status = 'connected',
}: VpipRequirementBadgeProps): React.ReactElement {
  const reportedRef = useRef(false);

  useEffect(() => {
    if (isAllowedVpipRequirement(minimumVpip) || reportedRef.current) return;
    reportedRef.current = true;
    // Once per mount, not once per render: a live VPIP event must not turn a
    // config mismatch into an error loop (the engine Sentry budget exists
    // because of exactly that shape - CLAUDE.md section 2).
    reportError(
      new Error(
        `VpipRequirementBadge: minimum ${minimumVpip} is not a sanctioned game rule ` +
          `(${ALLOWED_VPIP_REQUIREMENTS.join(' or ')}). Rendering the configured value.`
      ),
      'VpipRequirementBadge.invalidRequirement',
      { minimumVpip }
    );
    if (import.meta.env.DEV) {
      throw new Error(
        `Invalid VPIP requirement: ${minimumVpip}. Only 30 or 50 are supported (spec section 1).`
      );
    }
  }, [minimumVpip]);

  const displayVpip = formatVpipValue(currentVpip);

  return (
    <div
      className="vpipBadge"
      data-min-vpip={minimumVpip}
      data-status={status}
      role="status"
      data-testid="vpip-badge"
      /* Title Cased because it is forward-facing copy and the house rule
         covers every word a player can be shown or read (CLAUDE.md 5.7);
         scripts/ci/check-title-case.mjs reads attributes too. */
      aria-label={`Current VPIP ${displayVpip}. Minimum Required VPIP ${minimumVpip} Percent.`}
    >
      <div className="vpipBadge__face">
        <div className="vpipBadge__title">VPIP</div>

        <div className="vpipBadge__currentFrame">
          <div className="vpipBadge__currentWindow">
            <div className="vpipBadge__blueAccent vpipBadge__blueAccent--top" aria-hidden="true" />
            <div className="vpipBadge__currentLabel">CURRENT</div>
            {/* aria-live on the ONE field that changes. The wrapper carries
                role="status" for the full sentence; this narrows what is
                re-announced to the number, so a reader is not read the
                minimum again every time the percentage ticks. */}
            <div className="vpipBadge__currentValue" aria-live="polite">
              {displayVpip}
            </div>
            <div
              className="vpipBadge__blueAccent vpipBadge__blueAccent--bottom"
              aria-hidden="true"
            />
          </div>
        </div>

        <div className="vpipBadge__minimum">
          <span className="vpipBadge__dash" aria-hidden="true" />
          <span className="vpipBadge__minText">MIN {minimumVpip}%</span>
          <span className="vpipBadge__dash" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised (spec §29): a live VPIP event must not re-render the felt through
 * this component. Its props are three primitives, so the default shallow
 * compare is exactly right.
 */
export const VpipRequirementBadge = React.memo(VpipRequirementBadgeInner);

export default VpipRequirementBadge;
