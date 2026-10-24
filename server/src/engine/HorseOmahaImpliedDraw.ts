import type { OmahaDrawInfo } from './HorseEval.js';
/** Physical draw eligibility for implied credit. NLH retains its existing
 * pricing; Omaha must actually draw using its exact-two-hole evaluator. */
export function hasPhysicalImpliedDraw(isOmaha: boolean, draw: OmahaDrawInfo | null): boolean {
  return !isOmaha || (!!draw && (draw.nutty || draw.dominatedFlushDraw || draw.straightOuts > 0));
}
