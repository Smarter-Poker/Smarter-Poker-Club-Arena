const DAILY_MISSION_REVISION_TABLE = 'daily_challenge_dashboard_revisions';

function containsDailyMissionRevisionTable(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDailyMissionRevisionTable);
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if (record.table === DAILY_MISSION_REVISION_TABLE) return true;
  return Object.values(record).some(containsDailyMissionRevisionTable);
}

function containsDailyMissionPostgresChange(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value[3] === 'postgres_changes' && containsDailyMissionRevisionTable(value[4])) {
      return true;
    }
    return value.some(containsDailyMissionPostgresChange);
  }

  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.event === 'postgres_changes' &&
    containsDailyMissionRevisionTable(record.payload ?? record)
  ) {
    return true;
  }
  return Object.values(record).some(containsDailyMissionPostgresChange);
}

/**
 * Supabase can wrap postgres_changes inside a Phoenix broadcast frame. Match
 * the event value and its target table together so join acknowledgements that
 * merely contain a postgres_changes subscription config are never blocked.
 */
export function isDailyMissionRevisionFrame(message: string | Buffer): boolean {
  try {
    return containsDailyMissionPostgresChange(
      JSON.parse(typeof message === 'string' ? message : message.toString('utf8'))
    );
  } catch {
    return false;
  }
}
