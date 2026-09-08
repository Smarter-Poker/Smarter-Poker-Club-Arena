/**
 * Tournament results enrich an exit card; they never authorize the exit.
 * A stalled transport therefore has a short budget before the caller must
 * continue with the winner/elimination broadcast's durable fallback fields.
 */
export const TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS = 1_500;

export async function awaitTournamentResultEnrichment<T>(
  enrichment: PromiseLike<T>,
  timeoutMs: number = TOURNAMENT_RESULT_ENRICHMENT_TIMEOUT_MS
): Promise<T | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
  });

  try {
    return await Promise.race([Promise.resolve(enrichment).catch(() => undefined), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
