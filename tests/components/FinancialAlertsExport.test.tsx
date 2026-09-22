/** Actual mounted page, serializer/downloader and account guard. Synthetic read-only responses. UNRUN. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
/* Fixture messages are Title Case because the console prints every alert
   message through titleCase() (Dan 2026-09-14: the first letter of every word
   is capitalised, data included); a raw-cased fixture would not be found. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WEEKLY_ID as ID } from '../helpers/clubWeeklyStatement';
const state = vi.hoisted(() => ({
  userId: null as string | null,
  listeners: new Set<(event: any) => void>(),
  success: vi.fn(),
  error: vi.fn(),
  getRows: vi.fn(),
  getCounts: vi.fn(),
  resolve: vi.fn(),
  csv: '',
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: state.userId ? { id: state.userId } : null }),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !!state.userId,
    authenticated: !!state.userId,
    userId: state.userId,
  }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((name, fn) => {
      if (name === 'AUTH_STATE_CHANGED') state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    }),
    subscribeDebounced: vi.fn(() => () => {}),
    getOrCreateChannel: () => {
      const q: any = { on: () => q, subscribe: () => q };
      return q;
    },
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/components/common/PageSkeleton', () => ({
  default: () => <span>Loading</span>,
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: state.success, error: state.error }),
}));
vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    getUnresolved: state.getRows,
    getUnresolvedCounts: state.getCounts,
    resolve: state.resolve,
  },
}));
import FinancialAlertsPage from '../../src/pages/FinancialAlertsPage';
import { FinancialExportService } from '../../src/services/FinancialExportService';
const row = (id: string, message: string, severity = 'warning') => ({
  id,
  severity,
  source: 'Ledger',
  message,
  createdAt: '2026-09-15T00:00:00Z',
  resolved: false,
  context: {},
});
function signIn(userId: string | null) {
  state.userId = userId;
  for (const listener of state.listeners)
    listener({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  signIn(null);
  signIn(ID.actor);
  state.csv = '';
  state.getRows.mockResolvedValue([]);
  state.getCounts.mockResolvedValue({ total: 0, critical: 0, warning: 0, info: 0 });
  state.resolve.mockResolvedValue(undefined);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:test'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('loaded-alert export scope without monitoring mutation', () => {
  it('labels a capped critical list as loaded records without claiming complete critical coverage', async () => {
    state.getRows.mockResolvedValue([row(ID.invoice, 'Loaded Critical Alert', 'critical')]);
    state.getCounts.mockResolvedValue({ total: 700, critical: 700, warning: 0, info: 0 });
    render(<FinancialAlertsPage />);
    await screen.findByText('Loaded Critical Alert');
    expect(
      screen.getByText(
        'Loaded 1 Alerts; Separate Reads Report 700 Unresolved. This List May Be Incomplete.'
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Every Critical Is Shown/i)).toBeNull();
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('maps exact columns, preserves all-loaded export regardless of selected severity and sanitizes text', async () => {
    state.getRows.mockResolvedValue([
      row(ID.invoice, '=HYPERLINK("x")'),
      row(ID.period, 'Other Loaded Alert', 'critical'),
    ]);
    state.getCounts.mockResolvedValue({ total: 2, critical: 1, warning: 1, info: 0 });
    const serialize = vi.spyOn(FinancialExportService, 'generateCSV');
    render(<FinancialAlertsPage />);
    await screen.findByText('Other Loaded Alert');
    fireEvent.click(screen.getByRole('button', { name: /^Warning/ }));
    fireEvent.click(screen.getByTitle('Export Loaded Alerts CSV'));
    expect(serialize).toHaveBeenCalledTimes(1);
    const [columns, rows] = serialize.mock.calls[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: ID.invoice,
      message: '=HYPERLINK("x")',
      loaded_rows: 2,
      resolved: false,
    });
    const csv = serialize.mock.results[0].value;
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(columns.map((c) => c.key)).toEqual([
      'id',
      'severity',
      'source',
      'message',
      'created_at',
      'resolved',
      'record_scope',
      'loaded_rows',
    ]);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('refuses an absent alert identity at serialization rather than exporting a null substitute', async () => {
    state.getRows.mockResolvedValue([{ ...row(ID.invoice, 'Bad Identity'), id: undefined }]);
    render(<FinancialAlertsPage />);
    await screen.findByText('Bad Identity');
    fireEvent.click(screen.getByTitle('Export Loaded Alerts CSV'));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith('Export unavailable');
  });
  it('shows no-loaded empty state, and a failed refresh removes exportable old rows', async () => {
    render(<FinancialAlertsPage />);
    await screen.findByText('No Loaded Alerts');
    expect(screen.queryByText('All Clear')).toBeNull();
    state.getRows.mockResolvedValue([row(ID.invoice, 'Old Record')]);
    fireEvent.click(screen.getByTitle('Refresh'));
    await screen.findByText('Old Record');
    state.getRows.mockRejectedValue(new Error('unavailable'));
    fireEvent.click(screen.getByTitle('Refresh'));
    await screen.findByRole('alert');
    expect(screen.queryByText('Old Record')).toBeNull();
    expect(screen.queryByTitle('Export Loaded Alerts CSV')).toBeNull();
  });
  it('invalidates a pending read under account ABA without intermediate manual render', async () => {
    const pending = deferred<unknown>();
    state.getRows.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    render(<FinancialAlertsPage />);
    await waitFor(() => expect(state.getRows).toHaveBeenCalledTimes(1));
    act(() => {
      signIn(ID.otherActor);
      signIn(ID.actor);
    });
    await screen.findByText('No Loaded Alerts');
    await act(async () => {
      pending.resolve([row(ID.invoice, 'Late private record')]);
    });
    expect(screen.queryByText('Late private record')).toBeNull();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
  it('does not emit a download or success after canonical identity changes without a React render', async () => {
    state.getRows.mockResolvedValue([row(ID.invoice, 'Loaded Record')]);
    render(<FinancialAlertsPage />);
    await screen.findByText('Loaded Record');
    // No auth event/render: the predicate must inspect current canonical identity.
    state.userId = ID.otherActor;
    fireEvent.click(screen.getByTitle('Export Loaded Alerts CSV'));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });
  it('holds account retirement between serialization and actual click and cleans the Blob URL', async () => {
    state.getRows.mockResolvedValue([row(ID.invoice, 'Loaded Record')]);
    render(<FinancialAlertsPage />);
    await screen.findByText('Loaded Record');
    vi.mocked(URL.createObjectURL).mockImplementation(() => {
      signIn(ID.otherActor);
      signIn(ID.actor);
      return 'blob:retired';
    });
    fireEvent.click(screen.getByTitle('Export Loaded Alerts CSV'));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retired');
    expect(state.success).not.toHaveBeenCalled();
  });
  it('preserves the existing resolve writer and suppresses only stale completion UI', async () => {
    const pending = deferred<void>();
    state.resolve.mockReturnValueOnce(pending.promise);
    state.getRows.mockResolvedValue([row(ID.invoice, 'Resolve Me')]);
    render(<FinancialAlertsPage />);
    await screen.findByText('Resolve Me');
    fireEvent.click(screen.getByRole('button', { name: /Mark Resolved/i }));
    expect(state.resolve).toHaveBeenCalledWith(ID.invoice);
    state.getRows.mockResolvedValue([]);
    act(() => {
      signIn(ID.otherActor);
      signIn(ID.actor);
    });
    await screen.findByText('No Loaded Alerts');
    await act(async () => pending.resolve());
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Resolve Me')).toBeNull();
  });
});
