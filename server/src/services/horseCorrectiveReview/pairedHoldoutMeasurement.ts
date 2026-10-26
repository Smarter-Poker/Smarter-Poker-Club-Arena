/** Numerical reduction only. Callers own objective/unit, authenticated source,
 * model decisions, predeclared support bound and commitment construction.
 * Retained decisions remain zero deltas in the full population denominator. */
export interface PairedHoldoutMeasurementPlan {
  maximumAbsoluteDelta: number;
  familyWiseAlpha: number;
  familySize: number;
}
export type PairedHoldoutMeasurement =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'measured';
      samples: number;
      changed: number;
      meanGain: number;
      lowerGain: number;
    };
export function measurePairedHoldoutDeltas(
  deltas: readonly number[],
  changed: number,
  plan: PairedHoldoutMeasurementPlan
): PairedHoldoutMeasurement {
  const no = (reason: string): PairedHoldoutMeasurement => ({ status: 'unavailable', reason });
  try {
    if (
      !Array.isArray(deltas) ||
      deltas.length < 2 ||
      deltas.length > 100000 ||
      !Number.isSafeInteger(changed) ||
      changed < 0 ||
      changed > deltas.length ||
      !plan ||
      !Number.isFinite(plan.maximumAbsoluteDelta) ||
      plan.maximumAbsoluteDelta <= 0 ||
      plan.maximumAbsoluteDelta > 1e6 ||
      !Number.isFinite(plan.familyWiseAlpha) ||
      plan.familyWiseAlpha <= 0 ||
      plan.familyWiseAlpha > 0.05 ||
      !Number.isSafeInteger(plan.familySize) ||
      plan.familySize < 1 ||
      plan.familySize > 1e6
    )
      return no('paired_holdout_measurement_invalid');
    let sum = 0;
    let nonzero = 0;
    for (const delta of deltas) {
      if (!Number.isFinite(delta) || Math.abs(delta) > plan.maximumAbsoluteDelta)
        return no('paired_holdout_predeclared_bound_exceeded');
      sum += delta;
      if (delta !== 0) nonzero++;
    }
    // A changed action may have zero utility difference; a retained action
    // cannot have a nonzero delta. The owner supplies the exact change count.
    if (nonzero > changed || !Number.isFinite(sum))
      return no('paired_holdout_change_count_invalid');
    const mean = sum / deltas.length;
    const radius =
      plan.maximumAbsoluteDelta *
      Math.sqrt((2 * Math.log(plan.familySize / plan.familyWiseAlpha)) / deltas.length);
    const lower = mean - radius;
    if (![mean, radius, lower].every(Number.isFinite))
      return no('paired_holdout_measurement_nonfinite');
    return {
      status: 'measured',
      samples: deltas.length,
      changed,
      meanGain: mean,
      lowerGain: lower,
    };
  } catch {
    return no('paired_holdout_measurement_unreadable');
  }
}
