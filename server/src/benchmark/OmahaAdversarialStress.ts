/** Explicit synthetic stress tests. Never a calibrated human population or
 * promotion verdict, and never imported by the live decision path. */
import {
  type HumanCalibratedProfile,
  isHumanCalibratedHoldoutSeed,
} from './HumanCalibratedPopulation.js';
import { isPlo4HoldoutSeed } from './Plo4StrengthContract.js';
import { isOmahaVariantHoldoutSeed } from './OmahaVariantStrengthContract.js';
import { isRemainingVariantHoldoutSeed } from './RemainingVariantStrengthContract.js';
import { isJointHoldoutSeed } from './JointStrengthContract.js';
import {
  playPlo4PolicyHand,
  plo4StrengthLeagueProfile,
  withHumanCalibratedOpponents,
} from './Plo4PolicyLeague.js';
import { omahaVariantStrengthLeagueProfile } from './OmahaVariantStrengthLeague.js';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';

export const OMAHA_STRESS_OPPONENTS = ['caller', 'folder', 'raiser', 'passive_value'] as const;
export type OmahaStressOpponent = (typeof OMAHA_STRESS_OPPONENTS)[number];
export interface OmahaStressRequest {
  variant: 'plo4' | 'plo5' | 'plo6';
  opponent: OmahaStressOpponent;
  hands: number;
  seed: number;
  seats: 2 | 6;
  stackBB: 25 | 100 | 200;
}

/** These are deliberate stress extremes, not measurements of people. Zero
 * observed counts prevent them from claiming calibration adequacy. */
export function omahaStressOpponent(opponent: OmahaStressOpponent): HumanCalibratedProfile {
  if (!OMAHA_STRESS_OPPONENTS.includes(opponent)) throw Error('Unknown stress opponent');
  const [fold, raise, bet] = {
    caller: [0, 0, 0],
    folder: [0.9, 0.02, 0.1],
    raiser: [0.02, 0.9, 0.9],
    passive_value: [0.7, 0.02, 0.08],
  }[opponent];
  const response = () => ({ fold, call: 1 - fold - raise, raise, n: 0 });
  return {
    id: `synthetic-omaha-stress-v1-${opponent}`,
    family: 'omaha',
    seatHands: 0,
    preflop: { unopened: response(), freeRaise: raise, facingRaise: response() },
    postflop: {
      flop: { facingBet: response(), checkedToBet: bet, checkedToN: 0 },
      turn: { facingBet: response(), checkedToBet: bet, checkedToN: 0 },
      river: { facingBet: response(), checkedToBet: bet, checkedToN: 0 },
    },
  };
}

export function validateOmahaStressRequest(request: OmahaStressRequest): void {
  if (
    !['plo4', 'plo5', 'plo6'].includes(request.variant) ||
    !OMAHA_STRESS_OPPONENTS.includes(request.opponent) ||
    ![2, 6].includes(request.seats) ||
    ![25, 100, 200].includes(request.stackBB) ||
    !Number.isSafeInteger(request.hands) ||
    request.hands < 1 ||
    request.hands > 1000 ||
    !Number.isSafeInteger(request.seed) ||
    request.seed < 1 ||
    request.seed + request.hands - 1 > 0xffffffff
  )
    throw Error('Invalid bounded stress request');
  for (let i = 0; i < request.hands; i++) {
    const seed = request.seed + i;
    if (
      [
        isPlo4HoldoutSeed,
        isOmahaVariantHoldoutSeed,
        isRemainingVariantHoldoutSeed,
        isJointHoldoutSeed,
        isHumanCalibratedHoldoutSeed,
      ].some((heldOut) => heldOut(seed))
    )
      throw Error('Stress development refuses qualification holdout seeds');
  }
}

export async function runOmahaAdversarialStress(request: OmahaStressRequest) {
  validateOmahaStressRequest(request);
  if (
    process.env.EQUITY_GOVERNOR !== 'off' ||
    equityGovernor.snapshot().enabled ||
    equityGovernor.current() !== 1
  )
    throw Error('Stress requires the full offline equity sample');
  const base =
    request.variant === 'plo4'
      ? plo4StrengthLeagueProfile('p10c-6max-100bb')
      : omahaVariantStrengthLeagueProfile(request.variant, `p11c-${request.variant}-6max-100bb`);
  const opponent = omahaStressOpponent(request.opponent);
  const table = {
    ...withHumanCalibratedOpponents(base),
    id: opponent.id,
    seats: request.seats,
    tableSeats: request.seats,
    stackBB: request.stackBB,
    humanCalibratedProfiles: [opponent],
  };
  let sum = 0,
    squares = 0,
    rake = 0,
    bbj = 0,
    decisions = 0;
  for (let i = 0; i < request.hands; i++) {
    const hero = (i % request.seats) + 1;
    const button = ((i + Math.floor(i / request.seats)) % request.seats) + 1;
    const hand = await playPlo4PolicyHand(
      table,
      request.seed + i,
      button,
      hero,
      'off',
      () => true,
      true
    );
    if (
      !hand.complete ||
      hand.illegalActions ||
      hand.truncated ||
      hand.conservationErrors ||
      hand.cardErrors ||
      !hand.checks ||
      hand.checks.settlementMismatches ||
      hand.checks.deductionMismatches
    )
      throw Error(`Stress hand ${i} failed physical, accounting or execution checks`);
    const net = hand.net[hero - 1] / 2;
    if (!Number.isFinite(net)) throw Error('Stress hand returned no finite hero result');
    sum += net;
    squares += net * net;
    rake += hand.rake;
    bbj += hand.bbj;
    decisions += hand.decisions;
  }
  const n = request.hands;
  const mean = sum / n;
  const stderr = n > 1 ? Math.sqrt(Math.max(0, (squares - (sum * sum) / n) / (n - 1)) / n) : null;
  return {
    version: 'omaha-synthetic-stress-v1',
    evidenceKind: 'synthetic_development_stress',
    qualifiesForPromotion: false,
    decisionPolicy: 'reference_only',
    learningContext: 'fresh_each_hand',
    isHumanPerformanceEvidence: false,
    request: { ...request },
    completedHands: n,
    decisions,
    rakeChips: rake,
    bbjChips: bbj,
    heroNetBb: sum,
    heroBb100: mean * 100,
    standardErrorBb100: stderr === null ? null : stderr * 100,
    normalApproximation99Bb100:
      stderr === null ? null : [(mean - 2.576 * stderr) * 100, (mean + 2.576 * stderr) * 100],
  };
}
