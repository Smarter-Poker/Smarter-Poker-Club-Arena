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
 * ── §1's TWO VARIANTS ARE NOW TRUE OF THE DATABASE TOO (2026-09-07) ─────────
 * When this was first written the spec and production disagreed: §1 allows
 * only `30 | 50`, and live tables were running 35, 40, 60, 65 and 70. Dan:
 * "vpip for action is supposed to be 30% and vpip for madness is 50%. we fixed
 * and updated that a couple days ago."
 *
 * He was right that the DEFAULT was fixed - `fn_cash_template_defaults` has
 * said classic 0 / action 30 / madness 50 since 2026-09-05. What had not
 * happened is that every action and madness game was created the day BEFORE,
 * and a game's `ruleset_snapshot` is written once at creation, so 54 games
 * still carried the old numbers and `fn_cash_apply_ruleset` kept pushing them
 * onto their tables. Migration 20260907190515 backfilled the snapshots and put
 * the rule where it cannot drift again: a BEFORE trigger on `cash_games` that
 * normalises the floor and window to the template on every write.
 *
 * So the guard below is no longer a disagreement with production - it is a
 * second assertion of the same rule, one layer out. It still does what §1
 * asks: development says so loudly, production reports once and prints the
 * configured number rather than rounding it, because telling a player they are
 * failing a rule nobody set is the one outcome worse than an odd-looking
 * badge. See the guard itself for why "loudly" is a console error and not a
 * throw - a throw there took the whole application down, not the badge.
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
    // config mismatch into an error loop (the engine error reporting budget exists
    // because of exactly that shape - CLAUDE.md section 2).
    reportError(
      new Error(
        `VpipRequirementBadge: minimum ${minimumVpip} is not a sanctioned game rule ` +
          `(${ALLOWED_VPIP_REQUIREMENTS.join(' or ')}). Rendering the configured value.`
      ),
      'VpipRequirementBadge.invalidRequirement',
      { minimumVpip }
    );
    /* ── VISIBLE IN DEVELOPMENT, WITHOUT TAKING THE APP WITH IT ─────────────
       Section 1 asks for a visible failure while building. This used to be a
       `throw`, and a throw here does not fail the BADGE - the nearest boundary
       above it is the app-level ErrorBoundary in App.tsx (the table tree is
       rendered by PersistentTableLayer, a sibling of <Routes>, not inside the
       per-page boundary), so one table configured outside {30, 50} blanked the
       entire application in dev. It also double-reported, because the
       boundary's retry remounts the component and `reportedRef` is per
       instance.

       A loud console error is visible to the person who needs to see it and
       costs nobody their felt. The badge still renders the configured number
       either way, which is what a player must see. */
    if (import.meta.env.DEV) {
      console.error(
        `[VpipRequirementBadge] Invalid VPIP requirement: ${minimumVpip}. ` +
          `Only ${ALLOWED_VPIP_REQUIREMENTS.join(' and ')} are sanctioned (spec section 1). ` +
          `Rendering the configured value; check the game's ruleset_snapshot.`
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
