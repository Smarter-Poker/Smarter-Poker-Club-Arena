export interface SatellitePayoutEvidence {
  id: string;
  tournament_id: string;
  user_id: string;
  source: string;
  amount: number | string;
  recorded_by: string | null;
  metadata: unknown;
}

export type SatelliteAwardKind = 'ticket' | 'cash' | 'unknown';

/** Interpret immutable payout evidence, never standings or today's target state. */
export function recordedSatelliteAwardKind(
  rows: SatellitePayoutEvidence[],
  tournamentId: string,
  targetId: unknown,
  userId: string,
  amount: unknown
): SatelliteAwardKind {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'unknown';
  const exact = rows.filter(
    (row) =>
      row.tournament_id === tournamentId && row.user_id === userId && Number(row.amount) === value
  );
  if (exact.length !== 1) return 'unknown';
  const row = exact[0];
  if (row.source === 'satellite_remainder') return 'cash';
  // The maintained cash writer credits money before recording this row.
  if (row.source === 'satellite_ticket' && row.recorded_by === 'credit_and_log') return 'cash';
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  if (typeof targetId !== 'string' || metadata?.satellite_target_id !== targetId) return 'unknown';
  if (row.source === 'satellite_seat') return 'ticket';
  if (
    row.source === 'satellite_ticket' &&
    metadata?.delivery_kind === 'ticket' &&
    typeof metadata.ticket_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata.ticket_id)
  )
    return 'ticket';
  return 'unknown';
}
