import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const USER_ID = '2b1b6a4e-3a5c-4f9f-9c07-9d1f2a7c5e11';
const OTHER_USER_ID = 'f7737c40-ad09-41fa-aacf-b53f021720b6';
const EXPORT_ID = '1d6c7fc3-9438-44d1-befe-aa4abc3992f5';
const UTC_TODAY = new Date().toISOString().slice(0, 10);
const UTC_MONTH_START = `${UTC_TODAY.slice(0, 8)}01`;
const UTC_MONTH_DAYS = (Date.parse(UTC_TODAY) - Date.parse(UTC_MONTH_START)) / 86_400_000 + 1;
const UTC_PREVIOUS_END = new Date(Date.parse(UTC_MONTH_START) - 86_400_000)
  .toISOString()
  .slice(0, 10);
const UTC_PREVIOUS_START = new Date(
  Date.parse(UTC_PREVIOUS_END) - (UTC_MONTH_DAYS - 1) * 86_400_000
)
  .toISOString()
  .slice(0, 10);
const GENERATED_AT = `${UTC_TODAY}T04:00:00.000Z`;
const EXPIRES_AT = `${UTC_TODAY}T04:15:00.000Z`;

const { rpcMock, downloadCsvMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  downloadCsvMock: vi.fn(() => true),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: rpcMock, from: vi.fn() },
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: vi.fn(),
}));

vi.mock('../../src/utils/downloadCsv', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/downloadCsv')>(
    '../../src/utils/downloadCsv'
  );
  return { ...actual, downloadCsv: downloadCsvMock };
});

import RakeSnapshotPanel from '../../src/components/club/RakeSnapshotPanel';

function agentRow(index: number) {
  return {
    agent_user_id: `agent-${index}`,
    name: `Agent ${index}`,
    avatar_url: null,
    role: 'agent',
    commission_rate: 0.45,
    direct_players: 4,
    direct_active: 2,
    direct_rake: index,
    direct_hands: 50,
    network_players: 4,
    network_rake: index,
    sub_agents: 0,
    commission_earned: null,
    commission_outstanding: null,
    commission_settled: null,
    is_unassigned: false,
  };
}

function snapshot(total: number) {
  return {
    scope: 'club',
    scope_label: 'Deep Stack Society',
    club_id: CLUB_ID,
    union_id: null,
    range: { start: UTC_MONTH_START, end: UTC_TODAY, days: UTC_MONTH_DAYS },
    previous_range: {
      start: UTC_PREVIOUS_START,
      end: UTC_PREVIOUS_END,
      days: UTC_MONTH_DAYS,
    },
    summary: {
      games: 12,
      cash_games: 10,
      mtt_games: 2,
      total_winnings: 100,
      cash_winnings: 100,
      mtt_winnings: 0,
      cash_fee: 900,
      mtt_fee: 0,
      fee: 900,
      hands: 500,
    },
    previous: { fee: 800 },
    delta: { fee_pct: 12.5, games_pct: null, fee_abs: 100, winnings_abs: 10 },
    series: [],
    series_bucket: 'day',
    breakdown: [agentRow(1)],
    breakdown_kind: 'agent',
    breakdown_total: 900,
    commission_total: null,
    breakdown_count: total,
    breakdown_offset: 0,
    breakdown_live: true,
    rake_complete_through: null,
    applied_search: null,
    applied_sort: 'rake',
    generated_at: GENERATED_AT,
  };
}

function exportMetadata() {
  return {
    schema_version: 1,
    kind: 'rake',
    scope_type: 'club',
    scope_id: CLUB_ID,
    club_id: CLUB_ID,
    union_id: null,
    agent_user_id: null,
    date_from: UTC_MONTH_START,
    date_to: UTC_TODAY,
    search: null,
    sort: 'rake',
    generated_at: GENERATED_AT,
    scope_label: 'Deep Stack Society',
    breakdown_kind: 'agent',
    breakdown_total: 900,
    commission_total: null,
    contains_admin_commission: false,
  };
}

function exportReceipt(total: number) {
  return {
    export_id: EXPORT_ID,
    status: 'ready',
    kind: 'rake',
    total_rows: total,
    total_amount: 900,
    expires_at: EXPIRES_AT,
    metadata: exportMetadata(),
    metadata_fingerprint: 'rake-fingerprint',
  };
}

function exportPage(rows: unknown[], total: number, offset: number) {
  return {
    kind: 'rake',
    rows,
    total_rows: total,
    next_offset: offset + rows.length,
    has_more: offset + rows.length < total,
    expires_at: EXPIRES_AT,
    metadata: exportMetadata(),
    metadata_fingerprint: 'rake-fingerprint',
  };
}

function installCompleteExport(total = 254) {
  const exportRows = Array.from({ length: total }, (_, index) => agentRow(index + 1));
  rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'ca_rake_snapshot') return Promise.resolve({ data: snapshot(total), error: null });
    if (name === 'ca_rake_export_start') {
      return Promise.resolve({ data: exportReceipt(total), error: null });
    }
    if (name === 'ca_club_data_export_page') {
      const offset = Number(args.p_offset);
      const limit = Number(args.p_limit);
      return Promise.resolve({
        data: exportPage(exportRows.slice(offset, offset + limit), total, offset),
        error: null,
      });
    }
    return Promise.resolve({ data: true, error: null });
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  downloadCsvMock.mockClear();
  downloadCsvMock.mockReturnValue(true);
  sessionStorage.clear();
});

afterEach(cleanup);

describe('Rake Snapshot exact CSV export', () => {
  it('downloads every prepared row rather than only the interactive first page', async () => {
    installCompleteExport(254);
    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    const exportButton = screen.getByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    expect(exportButton).toHaveAttribute('title', 'Export Complete Snapshot As CSV');
    expect(screen.getByRole('searchbox', { name: 'Search This List' })).toHaveAttribute(
      'maxLength',
      '160'
    );
    fireEvent.click(exportButton);

    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledOnce());
    const [filename, csv, isCurrent] = downloadCsvMock.mock.calls[0] as [
      string,
      string,
      () => boolean,
    ];
    expect(filename).toBe(`rake-snapshot-club-${UTC_MONTH_START}-to-${UTC_TODAY}.csv`);
    expect(csv).toContain(
      'total_rows,breakdown_total,commission_total,contains_admin_commission,complete'
    );
    expect(csv).toContain('agent-254,Agent 254');
    expect(csv.split('\n').filter((line) => line.startsWith('agent-'))).toHaveLength(254);
    expect(isCurrent).toEqual(expect.any(Function));
    expect(screen.getByRole('status', { name: 'Rake Export Status' })).toHaveTextContent(
      'Exported All 254 Rows From The Exact Server Snapshot.'
    );
  });

  it('cancels immediately and never downloads a late preparation', async () => {
    let resolveStart: ((value: unknown) => void) | null = null;
    const pendingStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    rpcMock.mockImplementation((name: string) => {
      if (name === 'ca_rake_snapshot') return Promise.resolve({ data: snapshot(1), error: null });
      if (name === 'ca_rake_export_start') return pendingStart;
      return Promise.resolve({ data: true, error: null });
    });
    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    const exportButton = screen.getByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Export' }));
    expect(screen.getByRole('status', { name: 'Rake Export Status' })).toHaveTextContent(
      'Export Cancelled. No Partial File Was Downloaded.'
    );

    resolveStart?.({ data: exportReceipt(1), error: null });
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('ca_club_data_export_cancel', {
        p_export_id: EXPORT_ID,
      })
    );
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it('invalidates a late export when the authenticated viewer changes', async () => {
    let resolveStart: ((value: unknown) => void) | null = null;
    const pendingStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    rpcMock.mockImplementation((name: string) => {
      if (name === 'ca_rake_snapshot') return Promise.resolve({ data: snapshot(1), error: null });
      if (name === 'ca_rake_export_start') return pendingStart;
      return Promise.resolve({ data: true, error: null });
    });
    const view = render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    const exportButton = screen.getByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    view.rerender(<RakeSnapshotPanel clubId={CLUB_ID} userId={OTHER_USER_ID} scopes={['club']} />);
    expect(screen.getByRole('status', { name: 'Rake Export Status' })).toHaveTextContent(
      'Reporting Access Changed During Export. No Partial File Was Downloaded.'
    );

    resolveStart?.({ data: exportReceipt(1), error: null });
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('ca_club_data_export_cancel', {
        p_export_id: EXPORT_ID,
      })
    );
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it('refuses a native handoff that finishes after the authenticated viewer changes', async () => {
    installCompleteExport(1);
    let finishHandoff: ((value: boolean) => void) | null = null;
    const handoff = new Promise<boolean>((resolve) => {
      finishHandoff = resolve;
    });
    downloadCsvMock.mockReturnValue(handoff as unknown as boolean);
    const view = render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledOnce());
    const guard = downloadCsvMock.mock.calls[0]?.[2] as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);

    view.rerender(<RakeSnapshotPanel clubId={CLUB_ID} userId={OTHER_USER_ID} scopes={['club']} />);
    expect(guard?.()).toBe(false);
    finishHandoff?.(true);

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Rake Export Status' })).toHaveTextContent(
        'Reporting Access Changed During Export. No Partial File Was Downloaded.'
      )
    );
    expect(screen.queryByText('Exported All 1 Row From The Exact Server Snapshot.')).toBeNull();
  });

  it('keeps export disabled when a changed sort fails and the prior snapshot remains painted', async () => {
    let snapshotReads = 0;
    rpcMock.mockImplementation((name: string) => {
      if (name === 'ca_rake_snapshot') {
        snapshotReads += 1;
        if (snapshotReads === 1) return Promise.resolve({ data: snapshot(1), error: null });
        return Promise.resolve({ data: null, error: { message: 'sort read failed' } });
      }
      return Promise.resolve({ data: true, error: null });
    });
    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    const exportButton = screen.getByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort This List' }), {
      target: { value: 'name' },
    });

    await waitFor(() => expect(snapshotReads).toBeGreaterThan(1));
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
    expect(exportButton).toBeDisabled();
    fireEvent.click(exportButton);
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it('reports an expired immutable job without downloading a partial file', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'ca_rake_snapshot') return Promise.resolve({ data: snapshot(1), error: null });
      if (name === 'ca_rake_export_start') {
        return Promise.resolve({ data: exportReceipt(1), error: null });
      }
      if (name === 'ca_club_data_export_page') {
        return Promise.resolve({
          data: null,
          error: { code: '55000', message: 'rake export expired or unavailable' },
        });
      }
      return Promise.resolve({ data: true, error: null });
    });
    render(<RakeSnapshotPanel clubId={CLUB_ID} userId={USER_ID} scopes={['club']} />);

    await screen.findByText('Agent 1');
    const exportButton = screen.getByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);

    expect(
      await screen.findByText(
        'The Prepared Rake Export Expired Or Was No Longer Available. No Partial File Was Downloaded. Try Again.'
      )
    ).toBeInTheDocument();
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});
