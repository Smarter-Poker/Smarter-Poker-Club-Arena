/**
 * The tournament's place prizes cross the database in two deliberate steps:
 *
 *  1. prepare commits the complete obligation set without moving money;
 *  2. settle pays every prepared row and marks the event COMPLETED in one
 *     database transaction.
 *
 * If the process disappears between those calls, the obligations are the
 * restart record. If the settle transaction fails, it moves zero chips and a
 * later engine tick reuses the same rows. A lost HTTP response is also safe:
 * replay sees the already-COMPLETED, fully-paid batch and returns success.
 */

export const PREPARE_TOURNAMENT_PLACES_RPC = 'fn_prepare_tournament_place_obligations' as const;
export const SETTLE_TOURNAMENT_PLACES_RPC = 'fn_settle_tournament_places_atomic' as const;

export interface AtomicPlaceSettlementClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface AtomicPlaceSettlementResult {
  ok: boolean;
  paid: number;
  places: number;
  completed: boolean;
  reason: string | null;
  detail: string | null;
  retryable: boolean;
  transport_error?: string;
}

export interface AtomicPlaceSettlementOptions {
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

function parsed(data: unknown): AtomicPlaceSettlementResult {
  const value = objectResult(data);
  return {
    ok: value.ok === true,
    paid: Number(value.paid ?? 0) || 0,
    places: Number(value.places ?? 0) || 0,
    completed: value.completed === true || value.already_completed === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    detail: typeof value.detail === 'string' ? value.detail : null,
    retryable: value.retryable === true,
  };
}

const transportFailure = (message: string): AtomicPlaceSettlementResult => ({
  ok: false,
  paid: 0,
  places: 0,
  completed: false,
  reason: 'transport',
  detail: null,
  retryable: true,
  transport_error: message,
});

async function call(
  client: AtomicPlaceSettlementClient,
  rpc: string,
  tournamentId: string,
  source: string
): Promise<AtomicPlaceSettlementResult> {
  try {
    const { data, error } = await client.rpc(rpc, {
      p_tournament_id: tournamentId,
      p_source: source,
    });
    return error ? transportFailure(error.message) : parsed(data);
  } catch (error) {
    return transportFailure(error instanceof Error ? error.message : String(error));
  }
}

/** Prepare once, then make bounded direct attempts at the same atomic commit. */
export async function settleTournamentPlacesAtomically(
  client: AtomicPlaceSettlementClient,
  tournamentId: string,
  source: string,
  options: AtomicPlaceSettlementOptions = {}
): Promise<AtomicPlaceSettlementResult> {
  const requestedAttempts = Number(options.maxAttempts ?? 3);
  // An invalid override must never turn the loop into zero attempts (NaN) or
  // an unbounded retry (Infinity). Three is the production contract.
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.floor(requestedAttempts))
    : 3;
  const delayFor = options.retryDelayMs ?? ((attempt: number) => attempt * 250);

  let prepared = transportFailure('prepare was not attempted');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    prepared = await call(client, PREPARE_TOURNAMENT_PLACES_RPC, tournamentId, source);
    if (prepared.ok) break;
    if (!prepared.retryable || attempt === maxAttempts) return prepared;
    await sleep(delayFor(attempt));
  }

  let settled = transportFailure('settle was not attempted');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    settled = await call(client, SETTLE_TOURNAMENT_PLACES_RPC, tournamentId, source);
    // Preparation deliberately returns ok without completion. The settlement
    // door is different: its only success is an explicit durable COMPLETED
    // receipt, never a merely successful HTTP response.
    if (settled.ok && !settled.completed) {
      settled.ok = false;
      settled.reason ??= 'completion_not_proven';
    }
    if (settled.ok) return settled;
    if (!settled.retryable || attempt === maxAttempts) return settled;
    await sleep(delayFor(attempt));
  }
  return settled;
}
