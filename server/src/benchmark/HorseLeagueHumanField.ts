/**
 * Constants for the Horse League's human-field cards (2026-10-24), kept in a
 * module with no runtime dependencies so both the simulator (HorseLeague.ts)
 * and the compute boundary (HorseLeagueComputeWorkerClient.ts, which may only
 * TYPE-import HorseLeague, because HorseLeague imports it) share one source.
 *
 * See LeagueMatchup.opponentPopulation in HorseLeague.ts for the design.
 */

/**
 * Variants a human-field card may deal. NLH only, deliberately. The
 * human-calibrated population has an Omaha profile, but
 * docs/horse-brain-human-population-2026-10-08.md records it as missing the
 * 5-point fidelity criterion at the flop facing-bet node (5.6 points): it is
 * the one family whose fit is marked defective, so no nightly Omaha verdict is
 * built on it. The "other" profile (short deck, Pineapple, fixed limit) rests
 * on 85 human seat-hands. The NLH profile is the only one both fitted within
 * tolerance and backed by a four-figure sample (1,718 seat-hands). Every
 * family, NLH included, is still below the adequacy minimums of the winning
 * contract (humanCalibrationAdequacy), so a human-field row is a development
 * measurement, never a qualification.
 */
export const HUMAN_FIELD_VARIANTS: readonly string[] = Object.freeze(['nlh']);

/** Scenario names of the two absolute per-arm components on a human-field result. */
export const HUMAN_FIELD_COMPONENT_SCENARIOS = Object.freeze([
  'human_field_arm_a',
  'human_field_arm_b',
] as const);

/** Prefix every human-field card's name carries, so a row says what it measured. */
export const HUMAN_FIELD_NAME_PREFIX = 'human_';
