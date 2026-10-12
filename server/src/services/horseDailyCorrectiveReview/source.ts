import {
  DAILY_LIMITS,
  type DailyRequest,
  type DailySelectionRequest,
  type DailySelectionSource,
  type DailySource,
} from './contract.js';
import { parseDailyPage, validateRequest } from './validation.js';
import {
  parseAcceptedSourceRows,
  parseSelectionReceipt,
  validateSelectionRequest,
  validateSourceCoordinates,
  type AcceptedSourceCoordinate,
  type AcceptedSourceRowWithLease,
} from './selection.js';
import { createDailyPrivateRpc } from './transport.js';
type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = typeof fetch;
/** Called only by explicit offline execution. No ambient URL, dotenv, client,
 * subscription, retry, configuration read or network operation on import. */
export function createDailyReviewSource(
  environment: Environment,
  fetcher: Fetcher = fetch
): DailySource {
  const call = createDailyPrivateRpc(environment, fetcher);
  return async (request: DailyRequest) => {
    validateRequest(request);
    const captured = { day: request.day, after: request.after ? { ...request.after } : null };
    try {
      const raw = await call(
        'fn_horse_commitment_review_page',
        {
          p_day: captured.day,
          p_after_played_at: captured.after?.playedAt ?? null,
          p_after_hand_id: captured.after?.handId ?? null,
          p_after_horse_user_id: captured.after?.horseId ?? null,
          p_limit: DAILY_LIMITS.pageRows,
        },
        DAILY_LIMITS.wireBytes
      );
      return parseDailyPage(raw, captured);
    } catch {
      throw Error('daily_source_unavailable');
    }
  };
}
/** fn_horse_commitment_selection_receipt: day state, every immutable pass
 * receipt and one bounded page of gap-only hand coordinates. Read-only. */
export function createDailySelectionSource(
  environment: Environment,
  fetcher: Fetcher = fetch
): DailySelectionSource {
  const call = createDailyPrivateRpc(environment, fetcher);
  return async (request: DailySelectionRequest) => {
    validateSelectionRequest(request);
    const captured = { day: request.day, after: request.after ? { ...request.after } : null };
    try {
      const raw = await call(
        'fn_horse_commitment_selection_receipt',
        {
          p_day: captured.day,
          p_after_played_at: captured.after?.playedAt ?? null,
          p_after_hand_id: captured.after?.handId ?? null,
          p_limit: DAILY_LIMITS.pageRows,
        },
        DAILY_LIMITS.selectionWireBytes
      );
      return parseSelectionReceipt(raw, captured);
    } catch {
      throw Error('daily_selection_unavailable');
    }
  };
}
export type AcceptedSourceRowsReader = (
  hands: readonly AcceptedSourceCoordinate[]
) => Promise<ReadonlyMap<string, AcceptedSourceRowWithLease>>;
/** fn_horse_accepted_source_rows: the raw accepted row ACCEPTED_SOURCE_SELECT
 * describes plus the submission lease generation, one consistent snapshot.
 * Transport failure and a refused reply are distinct fixed errors. */
export function createAcceptedSourceRowsReader(
  environment: Environment,
  fetcher: Fetcher = fetch
): AcceptedSourceRowsReader {
  const call = createDailyPrivateRpc(environment, fetcher);
  return async (hands) => {
    validateSourceCoordinates(hands);
    const captured = hands.map((h) => ({ handId: h.handId, tableId: h.tableId }));
    let raw: unknown;
    try {
      raw = await call(
        'fn_horse_accepted_source_rows',
        { p_hands: captured.map((h) => ({ hand_id: h.handId, table_id: h.tableId })) },
        DAILY_LIMITS.sourceRowWireBytes
      );
    } catch {
      throw Error('accepted_source_unavailable');
    }
    try {
      return parseAcceptedSourceRows(raw, captured);
    } catch {
      throw Error('accepted_source_reply_refused');
    }
  };
}
