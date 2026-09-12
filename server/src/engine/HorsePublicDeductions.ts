import type { HandConfig } from '../types.js';

/** Public rules at the accepted action, not fees inferred from its later result. */
export type HorsePublicDeductions =
  | Readonly<{
      version: 1;
      status: 'captured';
      rules: 'controller-rake-bbj-v1';
      rake: Readonly<{
        percent: number;
        cap: number;
        noFlopNoDrop: boolean;
        /** Original order retained; the canonical controller selects the tier. */
        playerCountCaps: ReadonlyArray<readonly [number, number]>;
      }>;
      bbj: Readonly<{
        enabled: boolean;
        feeBB: number;
        minPlayersDealt: number;
        /** Jackpot award eligibility only; not a collection threshold. */
        minPotBB: number;
      }> | null;
    }>
  | Readonly<{
      version: 1;
      status: 'unavailable';
      reason: 'invalid_deduction_config' | 'timed_rake_unsupported';
    }>;

/** No prices, private cards or database calls. Unknown rules exclude new model
 * pricing without changing the controller's accepted action or settlement.
 */
export function captureHorsePublicDeductions(config: HandConfig): HorsePublicDeductions {
  const unavailable = (
    reason: 'invalid_deduction_config' | 'timed_rake_unsupported'
  ): HorsePublicDeductions => Object.freeze({ version: 1, status: 'unavailable', reason });
  const r = config.rakeConfig,
    b = config.bbjConfig;
  const amount = (v: number) => Number.isFinite(v) && v >= 0;
  if (
    !r ||
    !amount(r.percent) ||
    r.percent > 100 ||
    !amount(r.cap) ||
    typeof r.noFlopNoDrop !== 'boolean'
  )
    return unavailable('invalid_deduction_config');
  if (r.timedRake !== undefined) return unavailable('timed_rake_unsupported');
  const tiers = r.playerCountCaps ?? [];
  if (
    !Array.isArray(tiers) ||
    tiers.length > 10 ||
    tiers.some(
      (t) => !t || !Number.isInteger(t.players) || t.players < 2 || t.players > 10 || !amount(t.cap)
    )
  )
    return unavailable('invalid_deduction_config');
  if (
    b &&
    (typeof b.enabled !== 'boolean' ||
      !amount(b.feeBB) ||
      !amount(b.minPotBB) ||
      !Number.isInteger(b.minPlayersDealt) ||
      b.minPlayersDealt < 2 ||
      b.minPlayersDealt > 10)
  )
    return unavailable('invalid_deduction_config');
  return Object.freeze({
    version: 1,
    status: 'captured',
    rules: 'controller-rake-bbj-v1',
    rake: Object.freeze({
      percent: r.percent,
      cap: r.cap,
      noFlopNoDrop: r.noFlopNoDrop,
      playerCountCaps: Object.freeze(tiers.map((t) => Object.freeze([t.players, t.cap] as const))),
    }),
    bbj: b
      ? Object.freeze({
          enabled: b.enabled,
          feeBB: b.feeBB,
          minPlayersDealt: b.minPlayersDealt,
          minPotBB: b.minPotBB,
        })
      : null,
  });
}
