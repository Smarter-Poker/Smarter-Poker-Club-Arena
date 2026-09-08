/**
 * The tournament finish boundary is a database transaction, not a collection
 * of optimistic client writes.  These helpers keep transport retry separate
 * from a semantic refusal: an unanswered idempotent RPC may be asked again; a
 * database NO is returned immediately and the tournament remains COMPLETING.
 */

export const CLAIM_TOURNAMENT_FINISH_RPC = 'fn_claim_tournament_finish' as const;
export const CERTIFY_TOURNAMENT_FINISH_RPC = 'fn_certify_tournament_finish' as const;

export interface TournamentFinishRpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface TournamentFinishResult {
  ok: boolean;
  certified: boolean;
  reason: string | null;
  winnerUserId: string | null;
  finishKind: string | null;
  status: string | null;
  rowsUpdated: number;
  alreadyCompleted: boolean;
  transportError?: string;
  evidence?: unknown;
}

export interface TournamentFinishRpcOptions {
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

function objectResult(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

function failure(reason: string, transportError?: string): TournamentFinishResult {
  return {
    ok: false,
    certified: false,
    reason,
    winnerUserId: null,
    finishKind: null,
    status: null,
    rowsUpdated: 0,
    alreadyCompleted: false,
    ...(transportError ? { transportError } : {}),
  };
}

async function invoke(
  client: TournamentFinishRpcClient,
  rpc: string,
  args: Record<string, unknown>,
  options: TournamentFinishRpcOptions
): Promise<{ raw: Record<string, unknown> | null; transportError?: string }> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const delayFor = options.retryDelayMs ?? ((attempt: number) => attempt * 250);
  let lastError = 'unknown transport failure';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await client.rpc(rpc, args);
      if (!error) return { raw: objectResult(data) };
      lastError = error.message;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(delayFor(attempt));
  }
  return { raw: null, transportError: lastError };
}

/** Persist one immutable winner while claiming RUNNING -> COMPLETING. */
export async function claimTournamentFinish(
  client: TournamentFinishRpcClient,
  tournamentId: string,
  winnerUserId: string,
  source: string,
  options: TournamentFinishRpcOptions = {}
): Promise<TournamentFinishResult> {
  const response = await invoke(
    client,
    CLAIM_TOURNAMENT_FINISH_RPC,
    {
      p_tournament_id: tournamentId,
      p_winner_user_id: winnerUserId,
      p_source: source,
    },
    options
  );
  if (response.transportError) return failure('transport', response.transportError);
  if (!response.raw) return failure('invalid_response');

  const r = response.raw;
  if (r.ok !== true) {
    return {
      ...failure(typeof r.reason === 'string' ? r.reason : 'claim_refused'),
      winnerUserId: typeof r.winner_user_id === 'string' ? r.winner_user_id : null,
      finishKind: typeof r.finish_kind === 'string' ? r.finish_kind : null,
      status: typeof r.status === 'string' ? r.status : null,
    };
  }
  const canonical = typeof r.winner_user_id === 'string' ? r.winner_user_id : null;
  const status = typeof r.status === 'string' ? r.status : null;
  const resumedCanonical = r.resumed === true && status === 'COMPLETING';
  if (
    !canonical ||
    (canonical !== winnerUserId && !resumedCanonical) ||
    !['COMPLETING', 'COMPLETED'].includes(status ?? '')
  ) {
    return failure('invalid_claim_receipt');
  }
  return {
    ok: true,
    certified: r.already_completed === true,
    reason: null,
    winnerUserId: canonical,
    finishKind: typeof r.finish_kind === 'string' ? r.finish_kind : null,
    status,
    rowsUpdated: 0,
    alreadyCompleted: r.already_completed === true,
  };
}

/**
 * Read the matching certificate written by the format-owned atomic settlement
 * transaction. This compatibility RPC never pays and never changes status; its
 * only valid success is a durable COMPLETED replay with zero rows updated.
 */
export async function certifyTournamentFinish(
  client: TournamentFinishRpcClient,
  tournamentId: string,
  winnerUserId: string,
  source: string,
  options: TournamentFinishRpcOptions = {}
): Promise<TournamentFinishResult> {
  const response = await invoke(
    client,
    CERTIFY_TOURNAMENT_FINISH_RPC,
    {
      p_tournament_id: tournamentId,
      p_winner_user_id: winnerUserId,
      p_source: source,
    },
    options
  );
  if (response.transportError) return failure('transport', response.transportError);
  if (!response.raw) return failure('invalid_response');

  const r = response.raw;
  if (r.ok !== true || r.certified !== true) {
    return {
      ...failure(typeof r.reason === 'string' ? r.reason : 'certification_refused'),
      status: typeof r.status === 'string' ? r.status : null,
      evidence: r.evidence,
    };
  }

  const canonical = typeof r.winner_user_id === 'string' ? r.winner_user_id : null;
  const status = typeof r.status === 'string' ? r.status : null;
  const rowsUpdated = Number(r.rows_updated);
  const alreadyCompleted = r.already_completed === true;
  const exactCertificate = rowsUpdated === 0 && alreadyCompleted;
  if (canonical !== winnerUserId || status !== 'COMPLETED' || !exactCertificate) {
    return failure('invalid_completion_certificate');
  }

  return {
    ok: true,
    certified: true,
    reason: null,
    winnerUserId: canonical,
    finishKind: typeof r.finish_kind === 'string' ? r.finish_kind : null,
    status,
    rowsUpdated,
    alreadyCompleted,
    evidence: r.evidence,
  };
}
