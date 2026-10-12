/**
 * Post-launch condition (b) monitoring (winning contract, Amendment Of
 * October 9, 2026: docs/horse-brain-winning-contract-2026-10-08.md).
 *
 * A pack is selected on condition (a) alone. Condition (b), winning after rake
 * against humans, is re-measured by the owner once production has an adequate
 * human population, and it can only WITHDRAW a selected pack. This module is
 * the pure part of that check, used by the owner-triggered script
 * server/src/scripts/conditionBMonitor.ts. Nothing here runs on a schedule,
 * reads a database or changes a selection: a withdrawal is a reviewed change
 * of the pack's `withdrawn` field, which this module only words.
 */
import {
  HUMAN_CALIBRATED_PROFILES,
  HUMAN_CALIBRATION_SOURCE,
  humanCalibratedFamily,
  humanCalibrationAdequacy,
  type HumanCalibrationAdequacy,
} from './HumanCalibratedPopulation.js';
import type { HumanCalibratedCheckSummary } from './HumanCalibratedCheck.js';

/** One committed, unwithdrawn protected release selection. */
export interface SelectedPack {
  readonly phase: 'phase8' | 'phase10' | 'phase11' | 'phase12' | 'phase13';
  readonly variant: string;
  readonly packVersion: string;
  readonly approvalGeneration: number;
}

interface SelectionLike {
  readonly packVersion?: unknown;
  readonly approvalGeneration?: unknown;
  readonly withdrawn?: unknown;
}

/** The selected packs among the given committed selections (null and withdrawn skipped). */
export function selectedPacks(
  committed: readonly {
    phase: SelectedPack['phase'];
    variant: string;
    selection: SelectionLike | null;
  }[]
): SelectedPack[] {
  return committed
    .filter(
      (c) =>
        c.selection !== null &&
        c.selection.withdrawn === null &&
        typeof c.selection.packVersion === 'string'
    )
    .map((c) => ({
      phase: c.phase,
      variant: c.variant,
      packVersion: c.selection!.packVersion as string,
      approvalGeneration: Number(c.selection!.approvalGeneration),
    }));
}

/**
 * Whether the committed calibration is adequate for a pack's family. A
 * tournament pack has no human-calibrated tournament contract yet, so it is
 * unavailable external input whatever the cash calibration says.
 */
export function packCalibrationAdequacy(
  pack: SelectedPack,
  source: { distinctHumans: number; topHumanShare: number } = HUMAN_CALIBRATION_SOURCE
): HumanCalibrationAdequacy {
  const family = humanCalibratedFamily(pack.variant);
  const profile = HUMAN_CALIBRATED_PROFILES.find((p) => p.family === family);
  if (!profile) return { family, adequate: false, reasons: ['no_calibrated_profile'] };
  const adequacy = humanCalibrationAdequacy(profile, source);
  return pack.phase === 'phase8'
    ? {
        ...adequacy,
        adequate: false,
        reasons: [...adequacy.reasons, 'no_human_calibrated_tournament_contract'],
      }
    : adequacy;
}

export type ConditionBAction = 'keep' | 'withdraw' | 'no_decision';

export interface ConditionBVerdict {
  readonly action: ConditionBAction;
  readonly reason: string;
  /** The `withdrawn` value to commit, only when the action is withdraw. */
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

/** The withdrawal reason the amendment names. */
export const CONDITION_B_WITHDRAWAL_REASON = 'condition_b_lost_after_rake';

/**
 * The amendment's rule for one assembled condition (b) summary of a selected
 * pack: withdraw when, on an adequate calibration and a complete run, the
 * candidate's after-rake two-sided 99% lower bound is below zero; keep when it
 * is not; no decision on an inadequate calibration or an incomplete run (a
 * development measurement can neither select nor withdraw).
 */
export function conditionBVerdict(
  summary: Pick<HumanCalibratedCheckSummary, 'adequacy' | 'candidate' | 'conditionB'>,
  nowIso: string
): ConditionBVerdict {
  if (!summary.adequacy.adequate)
    return {
      action: 'no_decision',
      reason: `calibration_inadequate:${summary.adequacy.reasons.join(',')}`,
      withdrawn: null,
    };
  if (summary.conditionB === 'incomplete' || summary.candidate === null)
    return { action: 'no_decision', reason: 'run_incomplete', withdrawn: null };
  const lower = summary.candidate.lower99;
  if (!Number.isFinite(lower))
    return { action: 'no_decision', reason: 'lower_bound_unreadable', withdrawn: null };
  return lower < 0
    ? {
        action: 'withdraw',
        reason: `after_rake_lower_bound_${lower}_below_zero`,
        withdrawn: Object.freeze({ at: nowIso, reason: CONDITION_B_WITHDRAWAL_REASON }),
      }
    : { action: 'keep', reason: `after_rake_lower_bound_${lower}_not_below_zero`, withdrawn: null };
}
