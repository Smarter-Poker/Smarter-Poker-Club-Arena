/** Original failed-request context only. This never retries or changes entry.
 * A transaction refusal rolls back, so its caller is the remaining witness.
 * Keep arbitrary provider messages out of this typed diagnostic channel. */
export function horseEntryCapRefusalContext(
  error: unknown,
  tournamentId: string,
  horseId: string,
  attemptedAt: string
): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !uuid.test(tournamentId) ||
    !uuid.test(horseId) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(attemptedAt) ||
    !Number.isFinite(Date.parse(attemptedAt)) ||
    !error ||
    typeof error !== 'object'
  )
    return null;
  const refusal = error as { code?: unknown; message?: unknown };
  if (refusal.code !== '23514' || typeof refusal.message !== 'string') return null;
  const match =
    /^FOUR TABLE LIMIT: user ([0-9a-f-]{36}) is already committed to ([0-9]{1,10}) games and may not enter another$/.exec(
      refusal.message
    );
  if (!match || match[1] !== horseId) return null;
  const load = Number(match[2]);
  if (!Number.isSafeInteger(load) || load < 4 || load > 2147483647) return null;
  return (
    '[TournamentRecurring] horse_entry_cap_refused ' +
    JSON.stringify({
      version: 1,
      tournamentId,
      horseId,
      sqlstate: '23514',
      load,
      attemptedAt,
    })
  );
}
