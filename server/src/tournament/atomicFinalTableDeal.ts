/**
 * One RPC owns the final-table deal's complete financial commit: prior
 * eliminated place entitlements, every live chop share, final standings and
 * COMPLETED. A transport retry calls the same idempotent database function;
 * an explicit refusal is retried only when PostgreSQL says the transaction is
 * retryable.
 */

export const SETTLE_FINAL_TABLE_DEAL_ATOMIC_RPC = 'fn_settle_final_table_deal_atomic' as const;

export interface AtomicFinalTableDealClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface AtomicFinalTableDealPayout {
  user_id: string;
  amount: number;
  rank: number;
}

export interface AtomicFinalTableDealResult {
  ok: boolean;
  paid: number;
  place_paid: number;
  deal_paid: number;
  bubble_paid: number;
  completed: boolean;
  already_completed: boolean;
  players: number;
  deal_table_id: string | null;
  bubble_contract_required: boolean;
  bubble_obligation_id: string | null;
  chip_leader: string | null;
  payouts: AtomicFinalTableDealPayout[];
  reason: string | null;
  detail: string | null;
  retryable: boolean;
  transport_error?: string;
}

export interface AtomicFinalTableDealOptions {
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

function objectResult(data: unknown): Record<string, unknown> {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function payouts(value: unknown): AtomicFinalTableDealPayout[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): AtomicFinalTableDealPayout[] => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const userId = typeof item.user_id === 'string' ? item.user_id : '';
    const amount = Number(item.amount);
    const rank = Number(item.rank);
    if (!userId || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(rank) || rank < 1)
      return [];
    return [{ user_id: userId, amount, rank }];
  });
}

function parsed(data: unknown): AtomicFinalTableDealResult {
  const value = objectResult(data);
  const result: AtomicFinalTableDealResult = {
    ok: value.ok === true,
    paid: Number(value.paid ?? 0) || 0,
    place_paid: Number(value.place_paid ?? 0) || 0,
    deal_paid: Number(value.deal_paid ?? 0) || 0,
    bubble_paid: Number(value.bubble_paid ?? 0) || 0,
    completed: value.completed === true,
    already_completed: value.already_completed === true,
    players: Number(value.players ?? 0) || 0,
    deal_table_id: typeof value.deal_table_id === 'string' ? value.deal_table_id : null,
    bubble_contract_required: value.bubble_contract_required === true,
    bubble_obligation_id:
      typeof value.bubble_obligation_id === 'string' ? value.bubble_obligation_id : null,
    chip_leader: typeof value.chip_leader === 'string' ? value.chip_leader : null,
    payouts: payouts(value.payouts),
    reason: typeof value.reason === 'string' ? value.reason : null,
    detail: typeof value.detail === 'string' ? value.detail : null,
    retryable: value.retryable === true,
  };
  if (result.ok && !result.completed) {
    result.ok = false;
    result.reason ??= 'completion_not_proven';
  }
  return result;
}

const transportFailure = (message: string): AtomicFinalTableDealResult => ({
  ok: false,
  paid: 0,
  place_paid: 0,
  deal_paid: 0,
  bubble_paid: 0,
  completed: false,
  already_completed: false,
  players: 0,
  deal_table_id: null,
  bubble_contract_required: false,
  bubble_obligation_id: null,
  chip_leader: null,
  payouts: [],
  reason: 'transport',
  detail: null,
  retryable: true,
  transport_error: message,
});

/** Make bounded attempts at the same all-or-none database commit. */
export async function settleFinalTableDealAtomically(
  client: AtomicFinalTableDealClient,
  tournamentId: string,
  options: AtomicFinalTableDealOptions = {}
): Promise<AtomicFinalTableDealResult> {
  const requestedAttempts = Number(options.maxAttempts ?? 3);
  // Keep malformed test/config overrides from disabling the only settlement
  // attempt or creating an infinite application retry loop.
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.floor(requestedAttempts))
    : 3;
  const delayFor = options.retryDelayMs ?? ((attempt: number) => attempt * 250);
  let result = transportFailure('atomic deal was not attempted');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await client.rpc(SETTLE_FINAL_TABLE_DEAL_ATOMIC_RPC, {
        p_tournament_id: tournamentId,
      });
      result = error ? transportFailure(error.message) : parsed(data);
    } catch (error) {
      result = transportFailure(error instanceof Error ? error.message : String(error));
    }

    if (result.ok && result.completed) return result;
    if (!result.retryable || attempt === maxAttempts) return result;
    await sleep(delayFor(attempt));
  }

  return result;
}
