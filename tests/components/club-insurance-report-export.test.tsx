import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  downloadCsv: vi.fn(),
  navigate: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
  mounted: { current: true },
  toast: { error: vi.fn() },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({ clubId: 'shark-club' }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'owner-1' } }),
}));
vi.mock('../../src/hooks/useIsMounted', () => ({
  useIsMounted: () => state.mounted,
}));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('../../src/utils/downloadCsv', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/downloadCsv')>(
    '../../src/utils/downloadCsv'
  );
  return { ...actual, downloadCsv: state.downloadCsv };
});
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: state.reportError }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, plates }: any) => (
    <section>
      {children}
      {plates?.secondary ? (
        <button
          type="button"
          onClick={plates.secondary.onClick}
          disabled={plates.secondary.disabled}
        >
          {plates.secondary.label}
        </button>
      ) : null}
      {plates?.primary ? (
        <button type="button" onClick={plates.primary.onClick} disabled={plates.primary.disabled}>
          {plates.primary.label}
        </button>
      ) : null}
    </section>
  ),
}));

import ClubInsuranceReportPage from '../../src/pages/club/ClubInsuranceReportPage';

describe('ClubInsuranceReportPage export refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mounted.current = true;
    state.downloadCsv.mockReturnValue(false);
    state.rpc.mockResolvedValue({
      data: {
        contract: 'ca_club_insurance_report.v2',
        contract_version: 2,
        club_id: '11111111-1111-4111-8111-111111111111',
        requested_days: 30,
        window_days: 30,
        window_start: '2026-09-05',
        window_end: '2026-10-04',
        bank: 'club',
        totals: {
          offers: 1,
          accepted: 1,
          declined: 0,
          timeouts: 0,
          cashouts: 0,
          take_rate_pct: 100,
          avg_offer_equity: 50,
          avg_offer_pot: 100,
        },
        money: {
          contracts: 1,
          insurance_contracts: 1,
          cashout_contracts: 0,
          bank_in: 10,
          bank_out: 4,
          bank_net: 6,
        },
        days: [
          {
            day: '2026-10-04',
            offers: 1,
            accepted: 1,
            declined: 0,
            timeouts: 0,
            cashouts: 0,
            contracts: 1,
            bank_in: 10,
            bank_out: 4,
            bank_net: 6,
          },
        ],
        generated_at: '2026-10-04T12:00:00.000Z',
      },
      error: null,
    });
  });

  it('tells the player when the browser refuses the CSV download', async () => {
    render(<ClubInsuranceReportPage />);

    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);

    await waitFor(() =>
      expect(state.toast.error).toHaveBeenCalledWith('This Browser Could Not Start The Download')
    );
    expect(state.downloadCsv).toHaveBeenCalledOnce();
    const guard = state.downloadCsv.mock.calls[0]?.[2];
    expect(guard).toEqual(expect.any(Function));
    expect(guard()).toBe(true);
  });

  it('reports an observed native-share rejection and gives the player a retryable failure', async () => {
    state.downloadCsv.mockRejectedValueOnce(new Error('native share refused'));
    render(<ClubInsuranceReportPage />);

    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);

    await waitFor(() => expect(state.reportError).toHaveBeenCalledOnce());
    expect(state.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'ClubInsuranceReportPage.Export_failed'
    );
    expect(state.toast.error).toHaveBeenCalledWith('This Browser Could Not Start The Download');
  });

  it('suppresses a late export failure after the originating view is gone', async () => {
    let rejectExport!: (error: Error) => void;
    state.downloadCsv.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectExport = reject;
      })
    );
    render(<ClubInsuranceReportPage />);

    const exportButton = await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(state.downloadCsv).toHaveBeenCalledOnce());
    state.mounted.current = false;
    await act(async () => rejectExport(new Error('late native refusal')));

    expect(state.reportError).not.toHaveBeenCalled();
    expect(state.toast.error).not.toHaveBeenCalled();
  });
});
