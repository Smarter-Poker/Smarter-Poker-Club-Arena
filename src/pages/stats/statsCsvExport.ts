import { exportToCSV } from '../../lib/export';

export interface StatsExportMetadata {
  clubId: string | null;
  clubName: string;
  range: string;
  timezone: string;
  asset: string;
  unit: string;
  coverage: string;
  source: string;
  schemaVersion: number | null;
  generatedAt: string | null;
  privacyPresentationMode?: boolean;
}

export interface StatsSessionExportRow {
  date: string;
  ended: string;
  duration_minutes: number;
  hands: number;
  buy_in: number;
  cash_out: number;
  profit: number;
}

const metadataColumns = (metadata: StatsExportMetadata) => ({
  club_id: metadata.privacyPresentationMode ? 'hidden' : (metadata.clubId ?? 'all_clubs'),
  club_name: metadata.privacyPresentationMode ? 'Hidden' : metadata.clubName || 'All Clubs',
  analysis_range: metadata.privacyPresentationMode ? 'Hidden' : metadata.range,
  timezone: metadata.privacyPresentationMode ? 'Hidden' : metadata.timezone,
  asset: metadata.asset,
  unit: metadata.unit,
  coverage: metadata.privacyPresentationMode ? 'Hidden' : metadata.coverage,
  source: metadata.source,
  schema_version: metadata.schemaVersion ?? 'unknown',
  generated_at: metadata.privacyPresentationMode ? 'Hidden' : (metadata.generatedAt ?? ''),
  presentation_mode: metadata.privacyPresentationMode ? 'on' : 'off',
});

export function exportStatsSessions(
  sessions: StatsSessionExportRow[],
  metadata: StatsExportMetadata,
  filename: string
): void {
  const meta = metadataColumns(metadata);
  const rows = [
    {
      record_type: 'metadata',
      ...meta,
      date: '',
      ended: '',
      duration_minutes: '',
      hands: '',
      buy_in: '',
      cash_out: '',
      profit: '',
    },
    ...sessions.map((session) =>
      metadata.privacyPresentationMode
        ? {
            record_type: 'session',
            ...meta,
            date: 'Hidden',
            ended: 'Hidden',
            duration_minutes: 'Hidden',
            hands: 'Hidden',
            buy_in: 'Hidden',
            cash_out: 'Hidden',
            profit: 'Hidden',
          }
        : { record_type: 'session', ...meta, ...session }
    ),
  ];
  exportToCSV(rows, filename, [
    { key: 'record_type', label: 'Record Type' },
    { key: 'club_id', label: 'Club ID' },
    { key: 'club_name', label: 'Club Name' },
    { key: 'analysis_range', label: 'Analysis Range' },
    { key: 'timezone', label: 'Timezone' },
    { key: 'asset', label: 'Asset' },
    { key: 'unit', label: 'Unit' },
    { key: 'coverage', label: 'Coverage' },
    { key: 'source', label: 'Source' },
    { key: 'schema_version', label: 'Schema Version' },
    { key: 'generated_at', label: 'Generated At' },
    { key: 'presentation_mode', label: 'Presentation Mode' },
    { key: 'date', label: 'Started' },
    { key: 'ended', label: 'Ended' },
    { key: 'duration_minutes', label: 'Duration (Min)' },
    { key: 'hands', label: 'Hands' },
    { key: 'buy_in', label: 'Buy In' },
    { key: 'cash_out', label: 'Cash Out' },
    { key: 'profit', label: 'Profit' },
  ]);
}

export function exportStatsOverview(
  stats: Record<string, unknown>,
  rateFields: ReadonlySet<string>,
  metadata: StatsExportMetadata,
  filename: string
): void {
  const rows = [
    ...Object.entries(metadataColumns(metadata)).map(([key, value]) => ({
      stat: `metadata.${key}`,
      value: String(value),
      unit: '',
    })),
    ...Object.entries(stats).map(([key, value]) => {
      if (metadata.privacyPresentationMode) return { stat: key, value: 'Hidden', unit: '' };
      if (rateFields.has(key) && typeof value === 'number')
        return { stat: key, value: (value * 100).toFixed(2), unit: '%' };
      if (typeof value === 'boolean') return { stat: key, value: value ? 'yes' : 'no', unit: '' };
      return { stat: key, value: String(value ?? ''), unit: '' };
    }),
  ];
  exportToCSV(rows, filename, [
    { key: 'stat', label: 'Stat' },
    { key: 'value', label: 'Value' },
    { key: 'unit', label: 'Unit' },
  ]);
}
