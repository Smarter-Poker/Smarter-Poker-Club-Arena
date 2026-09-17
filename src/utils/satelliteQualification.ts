/** Decode the recorded v3 standings shape, never a raw creation label or cap.
 * The settlement owner keeps co-qualifiers unranked; eliminated ticket winners
 * retain their actual finishing position. This supplies no financial authority.
 */
export function isRecordedSatelliteQualifier(
  tournament:
    | {
        id?: unknown;
        status?: unknown;
        format_contract?: unknown;
        satellite_target_id?: unknown;
        satellite_target?: unknown;
      }
    | null
    | undefined,
  entry: { status?: unknown; position?: unknown; chips?: unknown }
): boolean {
  if (!tournament) return false;
  const target = tournament.satellite_target_id ?? tournament.satellite_target;
  return (
    tournament.status === 'COMPLETED' &&
    tournament.format_contract === 'mtt-v2' &&
    typeof target === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target) &&
    target !== tournament.id &&
    (tournament.satellite_target_id == null ||
      tournament.satellite_target == null ||
      tournament.satellite_target_id === tournament.satellite_target) &&
    entry.status === 'winner' &&
    entry.position == null &&
    typeof entry.chips === 'number' &&
    Number.isFinite(entry.chips) &&
    entry.chips > 0
  );
}
