import type { CrashRound } from '../services/DiamondGamesService';

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
  if (
    value.ok !== true ||
    value.round_id !== roundId ||
    !['open', 'cashed', 'crashed'].includes(String(value.status)) ||
    !integer(value.cap_cents) ||
    value.cap_cents < 101 ||
    !proof ||
    typeof proof.server_seed_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.server_seed_hash) ||
    (expected &&
      (value.club_id !== expected.club_id ||
        value.host_id !== expected.host_id ||
        value.bet_diamonds !== expected.bet_diamonds ||
        value.bet_chips !== expected.bet_chips ||
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
    outcome.crash_cents < 100 ||
    proof?.crash_cents !== outcome.crash_cents ||
    typeof proof?.server_seed !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.server_seed) ||
    !integer(proof.roll) ||
    proof.roll < 0 ||
    proof.roll >= 281474976710656 ||
    (value.status === 'crashed' &&
      (outcome.payout_chips !== 0 || outcome.cashout_cents !== null)) ||
    (value.status === 'cashed' &&
      (!integer(outcome.cashout_cents) ||
        outcome.cashout_cents < 101 ||
        outcome.cashout_cents > Math.min(Number(value.cap_cents), Number(outcome.crash_cents))))
  )
    reject();
}
