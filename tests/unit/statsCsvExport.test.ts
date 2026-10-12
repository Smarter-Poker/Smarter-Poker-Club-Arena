import { beforeEach, describe, expect, it, vi } from 'vitest';

const exportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/export', () => ({ exportToCSV: exportMock }));

import { exportStatsOverview, exportStatsSessions } from '../../src/pages/stats/statsCsvExport';

const metadata = {
  clubId: 'club-1',
  clubName: 'Friday Club',
  range: 'Last 30 Days',
  timezone: 'America/Chicago',
  asset: 'chips',
  unit: 'chips',
  coverage: '{"analysis_hands_capped":false}',
  source: 'exact_settlement',
  schemaVersion: 2,
  generatedAt: '2026-10-03T12:00:00.000Z',
};

describe('Stats CSV export metadata', () => {
  beforeEach(() => exportMock.mockReset());

  it('exports scope and provenance even when the session result is empty', () => {
    exportStatsSessions([], metadata, 'sessions.csv');
    const [rows, filename, columns] = exportMock.mock.calls[0];
    expect(filename).toBe('sessions.csv');
    expect(rows).toEqual([
      expect.objectContaining({
        record_type: 'metadata',
        club_id: 'club-1',
        club_name: 'Friday Club',
        analysis_range: 'Last 30 Days',
        timezone: 'America/Chicago',
        asset: 'chips',
        unit: 'chips',
        coverage: metadata.coverage,
        source: 'exact_settlement',
        schema_version: 2,
      }),
    ]);
    expect(columns.map((column: { key: string }) => column.key)).toEqual(
      expect.arrayContaining([
        'club_id',
        'analysis_range',
        'timezone',
        'coverage',
        'schema_version',
      ])
    );
  });

  it('prepends metadata to overview values and keeps percentage conversion', () => {
    exportStatsOverview(
      { vpip: 0.25, total_hands: 10 },
      new Set(['vpip']),
      metadata,
      'overview.csv'
    );
    const [rows] = exportMock.mock.calls[0];
    expect(rows).toContainEqual({ stat: 'metadata.club_id', value: 'club-1', unit: '' });
    expect(rows).toContainEqual({ stat: 'metadata.schema_version', value: '2', unit: '' });
    expect(rows).toContainEqual({ stat: 'vpip', value: '25.00', unit: '%' });
  });

  it('masks every exported value when presentation mode is enabled', () => {
    const privateMetadata = { ...metadata, privacyPresentationMode: true };
    exportStatsOverview(
      { vpip: 0.25, total_profit: 500 },
      new Set(['vpip']),
      privateMetadata,
      'private.csv'
    );
    const [overviewRows] = exportMock.mock.calls[0];
    expect(overviewRows).toContainEqual({ stat: 'vpip', value: 'Hidden', unit: '' });
    expect(overviewRows).toContainEqual({ stat: 'total_profit', value: 'Hidden', unit: '' });
    expect(overviewRows).toContainEqual({
      stat: 'metadata.presentation_mode',
      value: 'on',
      unit: '',
    });
    expect(overviewRows).toContainEqual({ stat: 'metadata.club_name', value: 'Hidden', unit: '' });
    expect(overviewRows).toContainEqual({
      stat: 'metadata.generated_at',
      value: 'Hidden',
      unit: '',
    });

    exportStatsSessions(
      [
        {
          date: 'Private Date',
          ended: '',
          duration_minutes: 60,
          hands: 10,
          buy_in: 100,
          cash_out: 200,
          profit: 100,
        },
      ],
      privateMetadata,
      'private-sessions.csv'
    );
    const [sessionRows] = exportMock.mock.calls[1];
    expect(sessionRows[1]).toEqual(
      expect.objectContaining({
        date: 'Hidden',
        hands: 'Hidden',
        buy_in: 'Hidden',
        cash_out: 'Hidden',
        profit: 'Hidden',
      })
    );
  });
});
