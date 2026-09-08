/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE SETTLE PATH FOR TOURNAMENT MONEY (chip accounting standard, Lane A2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every chip a tournament pays to a player - a place, a refund, a bubble
 * protection, a late-registration top-up, a final-table chop share, a satellite
 * remainder - leaves through THIS module and through ONE database function,
 * `fn_settle_tournament_obligation`. Nothing else in the engine may call
 * `fn_credit_and_log`, `credit_player_wallet` or `fn_credit_player_wallet_once`
 * for a tournament outcome. `OneSettlePathForTournamentMoney.law.test.ts` pins
 * it at the source level.
 *
 * WHY (docs/CHIP-ACCOUNTING-STANDARD.md, 2.2 and 3.2 step 5). Measured on
 * 2026-09-02: the four MTT variants were overpaid by 5,330 chips in 36 hours
 * across 82 events - 24% of everything they collected - because ELEVEN
 * independent payers each carried their own idempotency key and their own
 * idea of what was owed. Two evidence tables (`wallet_transactions`, what
 * moved; `tournament_payouts`, what the reconciler believes) and any arm that
 * wrote one and not the other caused the next arm to pay again. The late-reg
 * top-up even put the AMOUNT inside its key, so a re-run with a new pool was a
 * brand-new payment rather than a difference.
 *
 * The obligation model replaces all of that with a ledger of what is OWED:
 *
 *   tournament_obligations(tournament_id, kind, place | user_id,
 *                          amount_owed, amount_paid)
 *   UNIQUE (tournament_id, kind, place)    WHERE place IS NOT NULL
 *   UNIQUE (tournament_id, kind, user_id)  WHERE place IS NULL
 *
 * `fn_settle_tournament_obligation` upserts the obligation (owed only ever
 * RISES to `max(owed, amount)`), pays `min(amount, owed - paid)` from the
 * tournament's escrow to the player's club wallet, writes `tournament_payouts`
 * and `wallet_transactions` under a key it derives from the obligation row,
 * and stamps `app.money_path` so the R3 trigger lets the credit through.
 * A replay is `ok: true, paid: 0` - never an error. A second payment of the
 * same place is impossible whatever the caller believes.
 *
 * THE CONTRACT THIS MODULE KEEPS WITH ITS CALLERS:
 *
 *   - It retries ONLY when the RPC could not be reached or threw (a transport
 *     or Postgres error object). It NEVER retries an `ok: false` answer - the
 *     database has already said no, and asking again is how double payments
 *     were born.
 *   - It NEVER throws. A refused settle comes back as `ok: false` with the
 *     `refused_reason`, so a finish path is never stranded mid-loop with the
 *     other places unpaid and the status un-flipped.
 *   - An `escrow_short` refusal is MONEY OWED AND NOT MOVED. It raises a
 *     critical financial alert (`Tournament.escrow_short`) here, once, with
 *     every id needed to settle it by hand - so no caller can forget to.
 */

import { supabase as defaultSupabase } from '../services/supabase.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { reportError } from '../services/errorReporter.js';

/** Mirrors the CHECK constraint on `tournament_obligations.kind` (Lane A). */
export type TournamentObligationKind =
  | 'place'
  | 'bounty'
  | 'bounty_residual'
  | 'mystery_bounty'
  | 'refund'
  | 'seat'
  | 'satellite_remainder'
  | 'bubble_protection'
  | 'final_table_deal'
  | 'late_reg_adjustment';

export const RPC_NAME = 'fn_settle_tournament_obligation' as const;

export interface SettleTournamentObligationInput {
  tournamentId: string;
  kind: TournamentObligationKind;
  /**
   * The finishing place for place-keyed kinds ('place', 'late_reg_adjustment').
   * Omit (or pass null) for user-keyed kinds; the RPC keys those on `userId`.
   */
  place?: number | null;
  /** The player being paid. Required for every kind: it is who receives the chips. */
  userId: string;
  /**
   * What the player is OWED in total for this obligation, in chips (not the
   * difference). The RPC pays only what has not been paid yet, so a late-reg
   * top-up passes the NEW correct prize and the database works out the delta.
   */
  amount: number;
  /** Which engine path is asking, e.g. 'engine.eliminatePlayer'. Recorded on the obligation. */
  source: string;
  /**
   * The `wallet_transactions.description` the player reads, passed through as
   * `p_description` byte for byte. Named `memo` here because the repo's
   * title-case guard (`scripts/ci/check-title-case.mjs`) treats any property
   * called `description` as page copy and would retitle ledger text that the
   * reconciler, the audits and every existing row already spell this way.
   */
  memo?: string | null;
  /** A `ca_manual_adjustments` row id when a human is settling by hand (R6). */
  adjustmentId?: string | null;
}

export interface SettleTournamentObligationResult {
  ok: boolean;
  /** True only when the database confirms the entire recorded obligation is paid. */
  fully_settled?: boolean;
  /** Authoritative outstanding debt; null when no complete status was returned. */
  remaining?: number | null;
  /** Authoritative cumulative obligation totals, not only this request. */
  amount_owed?: number | null;
  amount_paid?: number | null;
  /** Chips moved by THIS call. 0 on a replay. */
  paid: number;
  /** Chips this obligation had already paid before this call. */
  already_paid: number;
  /** Why the database refused, when `ok` is false. 'transport' means it never answered. */
  refused_reason: string | null;
  obligation_id: string | null;
  idempotency_key: string | null;
  /** The last transport error message, when `refused_reason` is 'transport'. */
  transport_error?: string;
}

/** The subset of a Supabase client this module needs, so tests can hand it a stub. */
export interface SettleRpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface SettleTournamentObligationOptions {
  /** How many times to ask when the RPC cannot be reached. Default 3. */
  maxAttempts?: number;
  /** Back-off before attempt N+1, in ms. Default `attempt * 1000`. Tests pass `() => 0`. */
  retryDelayMs?: (attempt: number) => number;
}

/** The reason this module reports when the database never answered. */
export const TRANSPORT_REFUSAL = 'transport' as const;
/** The refusal the standard names: the tournament's escrow cannot cover what is owed. */
export const ESCROW_SHORT = 'escrow_short' as const;

function parseResult(data: unknown): Partial<SettleTournamentObligationResult> {
  let raw: unknown = data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, refused_reason: 'invalid_response' };
  }
  const r = raw as Record<string, unknown>;
  if (r.ok !== true && r.ok !== false) {
    return { ok: false, refused_reason: 'invalid_response' };
  }
  // A successful partial credit is still money owed. Do not derive completion
  // from the requested amount: a replay may name an older, smaller total.
  const money = (value: unknown): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) &&
      n >= 0 &&
      Number.isSafeInteger(Math.round(n * 100)) &&
      Math.round(n * 100) / 100 === n
      ? n
      : null;
  };
  const owed = money(r.amount_owed);
  const totalPaid = money(r.amount_paid);
  const remaining = money(r.remaining);
  const moved = money(r.paid);
  const prior = money(r.already_paid);
  const totalsAgree =
    owed !== null &&
    totalPaid !== null &&
    remaining !== null &&
    moved !== null &&
    prior !== null &&
    totalPaid <= owed &&
    Math.round(totalPaid * 100) === Math.round(moved * 100) + Math.round(prior * 100) &&
    Math.round(remaining * 100) ===
      Math.max(0, Math.round(owed * 100) - Math.round(totalPaid * 100));
  const hasTotals = ['amount_owed', 'amount_paid', 'remaining'].some((key) => key in r);
  const invalidSuccess =
    r.ok === true &&
    (moved === null ||
      prior === null ||
      (hasTotals && !totalsAgree) ||
      (r.fully_settled === true && (!totalsAgree || remaining !== 0)));
  return {
    fully_settled:
      !invalidSuccess &&
      r.ok === true &&
      r.fully_settled === true &&
      totalsAgree &&
      remaining === 0,
    remaining: totalsAgree ? remaining : null,
    amount_owed: totalsAgree ? owed : null,
    amount_paid: totalsAgree ? totalPaid : null,
    ok: r.ok === true && !invalidSuccess,
    paid: moved ?? 0,
    already_paid: prior ?? 0,
    refused_reason: invalidSuccess
      ? 'invalid_response'
      : typeof r.refused_reason === 'string'
        ? r.refused_reason
        : null,
    obligation_id: typeof r.obligation_id === 'string' ? r.obligation_id : null,
    idempotency_key: typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
  };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Settle one tournament obligation. See the module header for the contract.
 *
 * @param client   the Supabase service-role client (injectable for tests)
 * @param input    what is owed, to whom, for which tournament, and why
 * @param options  retry tuning; production callers leave it alone
 */
export async function settleTournamentObligation(
  client: SettleRpcClient | null | undefined,
  input: SettleTournamentObligationInput,
  options: SettleTournamentObligationOptions = {}
): Promise<SettleTournamentObligationResult> {
  const rpcClient: SettleRpcClient = client ?? (defaultSupabase as unknown as SettleRpcClient);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const delayFor = options.retryDelayMs ?? ((attempt: number) => attempt * 1000);

  const place =
    input.place === undefined || input.place === null || !Number.isFinite(Number(input.place))
      ? null
      : Math.trunc(Number(input.place));
  const amount = Math.round((Number(input.amount) || 0) * 100) / 100;

  const base: SettleTournamentObligationResult = {
    ok: false,
    fully_settled: false,
    remaining: null,
    amount_owed: null,
    amount_paid: null,
    paid: 0,
    already_paid: 0,
    refused_reason: null,
    obligation_id: null,
    idempotency_key: null,
  };

  // Nothing is owed. Not an error and not a call: the RPC would only record a
  // zero obligation, and every caller already guards `amount > 0`.
  if (amount <= 0) {
    return { ...base, ok: true };
  }

  const args = {
    p_tournament_id: input.tournamentId,
    p_kind: input.kind,
    p_place: place,
    p_user_id: input.userId,
    p_amount: amount,
    p_source: input.source,
    p_description: input.memo ?? null,
    p_adjustment_id: input.adjustmentId ?? null,
  };

  let lastTransportError = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let data: unknown = null;
    let error: { message: string } | null = null;
    try {
      const res = await rpcClient.rpc(RPC_NAME, args);
      data = res?.data;
      error = res?.error ?? null;
    } catch (thrown) {
      error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
    }

    if (!error) {
      const result: SettleTournamentObligationResult = { ...base, ...parseResult(data) };
      if (result.ok) return result;

      if (result.refused_reason === 'invalid_response') {
        // The RPC may have committed. An invalid receipt proves neither payment
        // nor nonpayment; never emit the ordinary "was NOT paid" refusal alert.
        reportError(
          new Error(
            'Tournament settlement returned an invalid payment receipt; reconcile the recorded obligation before reporting completion.'
          ),
          'Tournament.settle_obligation_invalid_response'
        );
        return result;
      }

      // The database answered and said NO. Never retried: the answer will not
      // change within this retry loop. A later recovery uses the same obligation.
      result.refused_reason = result.refused_reason ?? 'unknown';
      await raiseRefusalAlert(input, place, amount, result);
      return result;
    }

    lastTransportError = error.message;
    reportError(
      new Error(
        `[Tournament:${input.tournamentId.slice(0, 8)}] settle ${input.kind}` +
          `${place !== null ? ` place ${place}` : ''} for ${input.userId.slice(0, 8)} ` +
          `attempt ${attempt}/${maxAttempts} could not reach ${RPC_NAME}: ${error.message}`
      ),
      'Tournament.settle_obligation_transport'
    );
    if (attempt < maxAttempts) await sleep(delayFor(attempt));
  }

  return {
    ...base,
    ok: false,
    refused_reason: TRANSPORT_REFUSAL,
    transport_error: lastTransportError,
  };
}

/**
 * A refusal is money owed and not moved. `escrow_short` is the one the
 * standard names (R1: a tournament cannot pay more than its escrow holds) and
 * it is CRITICAL: the player is owed, the event holds less than it promised,
 * and a human has to fund the escrow or settle by hand. Any other refusal is
 * escalated under its own name so a new reason cannot hide.
 *
 * The context carries a dedupe key: the alert RPC's per-source flood guard is
 * what stops a stuck sweep from filing the same shortfall every five seconds,
 * and this key is what an operator groups on.
 */
async function raiseRefusalAlert(
  input: SettleTournamentObligationInput,
  place: number | null,
  amount: number,
  result: SettleTournamentObligationResult
): Promise<void> {
  const reason = result.refused_reason ?? 'unknown';
  const keyed = place !== null ? `place:${place}` : `user:${input.userId}`;
  const dedupeKey = `${reason}:${input.tournamentId}:${input.kind}:${keyed}`;
  const isEscrowShort = reason === ESCROW_SHORT;
  await raiseFinancialAlert(
    'critical',
    isEscrowShort ? 'Tournament.escrow_short' : 'Tournament.obligation_refused',
    isEscrowShort
      ? `Tournament escrow cannot cover ${amount} chips owed to ${input.userId} (${input.kind}` +
          `${place !== null ? ` place ${place}` : ''}). The player is owed and was NOT paid.`
      : `${RPC_NAME} refused (${reason}): ${amount} chips owed to ${input.userId} ` +
          `(${input.kind}${place !== null ? ` place ${place}` : ''}) were NOT paid.`,
    {
      dedupe_key: dedupeKey,
      tournament_id: input.tournamentId,
      kind: input.kind,
      place,
      user_id: input.userId,
      amount_owed: amount,
      already_paid: result.already_paid,
      refused_reason: reason,
      obligation_id: result.obligation_id,
      source: input.source,
    }
  );
}
