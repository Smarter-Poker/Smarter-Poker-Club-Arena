import type { CrashRound } from '../services/DiamondGamesService';
import { validBonusMinimum } from './diamondBonusPayout';
import {
  CRASH_PAYOUT_VERSION,
  crashCashoutFloorCents,
  crashPointFloorCents,
} from './diamondGamesFairness';

/** Read the receipt before normalization can turn absent amounts into zero. */
export function validateCrashSettlement(
  value: Record<string, unknown>,
  roundId: string,
  expected?: CrashRound
) {
  const reject = () => {
    throw new Error('The Crash Result Could Not Be Verified');
  };
  if (value.ok === false && typeof value.error === 'string' && value.error.length) return;
  const proof = value.fairness as Record<string, unknown> | null;
  const outcome = value.outcome as Record<string, unknown> | null;
  const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
  const amount = (n: unknown): n is number =>
    typeof n === 'number' &&
    Number.isFinite(n) &&
    n >= 0 &&
    Math.abs(n * 100 - Math.round(n * 100)) < 1e-8;
  // The floors a receipt was sealed under: 1.00x/1.01x before contract 4, 1.10x/1.11x
  // from it (Dan, 2026-09-21: the ship can never explode until after 1.10x). A
  // contract-4 receipt STATES them, and fn_crash_round_result has stated them on
  // every round since, so on that contract their absence is itself a refusal:
  // silence there is what a round priced by the old rule would look like.
  const version = typeof value.payout_version === 'number' ? value.payout_version : undefined;
  const pointFloor = crashPointFloorCents(version);
  const cashoutFloor = crashCashoutFloorCents(version);
  const statesItsFloors =
    (version ?? 0) >= CRASH_PAYOUT_VERSION
      ? value.cashout_floor_cents === cashoutFloor && value.crash_floor_cents === pointFloor
      : (value.cashout_floor_cents === undefined || value.cashout_floor_cents === cashoutFloor) &&
        (value.crash_floor_cents === undefined || value.crash_floor_cents === pointFloor);
  if (
    value.ok !== true ||
    !validBonusMinimum(value) ||
    value.round_id !== roundId ||
    !['open', 'cashed', 'crashed'].includes(String(value.status)) ||
    !integer(value.cap_cents) ||
    value.cap_cents < cashoutFloor ||
    !statesItsFloors ||
    !proof ||
    typeof proof.server_seed_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.server_seed_hash) ||
    (expected &&
      (value.club_id !== expected.club_id ||
        value.host_id !== expected.host_id ||
        value.bet_diamonds !== expected.bet_diamonds ||
        value.bet_chips !== expected.bet_chips ||
        (value.minimum_payout_chips ?? 0) !== (expected.minimum_payout_chips ?? 0) ||
        value.diamonds_per_chip !== expected.diamonds_per_chip ||
        value.cap_cents !== expected.cap_cents ||
        value.growth_k !== expected.growth_k ||
        value.auto_cashout_cents !== expected.auto_cashout_cents ||
        value.started_at !== expected.started_at ||
        proof.commit_id !== expected.fairness.commit_id ||
        proof.server_seed_hash !== expected.fairness.server_seed_hash ||
        proof.client_seed !== expected.fairness.client_seed ||
        proof.nonce !== expected.fairness.nonce))
  )
    reject();
  if (value.status === 'open') {
    if (
      outcome !== null ||
      proof?.server_seed !== undefined ||
      proof?.roll !== undefined ||
      proof?.crash_cents !== undefined ||
      !integer(value.multiplier_now_cents) ||
      value.multiplier_now_cents < 100 ||
      Number(value.multiplier_now_cents) > Number(value.cap_cents)
    )
      reject();
    return;
  }
  if (
    !outcome ||
    outcome.status !== value.status ||
    !amount(outcome.payout_chips) ||
    !integer(outcome.crash_cents) ||
    outcome.crash_cents < pointFloor ||
    proof?.crash_cents !== outcome.crash_cents ||
    typeof proof?.server_seed !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.server_seed) ||
    !integer(proof.roll) ||
    proof.roll < 0 ||
    proof.roll >= 281474976710656 ||
    (value.status === 'crashed' &&
      (outcome.payout_chips !== (value.minimum_payout_chips ?? 0) ||
        outcome.cashout_cents !== null)) ||
    (value.status === 'cashed' &&
      (!integer(outcome.cashout_cents) ||
        outcome.cashout_cents < cashoutFloor ||
        outcome.cashout_cents > Math.min(Number(value.cap_cents), Number(outcome.crash_cents))))
  )
    reject();
}
