import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';

const exportMocks = vi.hoisted(() => ({
  overview: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock('../../src/components/stats/LeakPanel', () => ({ default: () => null }));
vi.mock('../../src/components/stats/StatsCharts', () => ({
  default: ({ onExportOverview, onExportSessions }: any) => (
    <>
      <button onClick={onExportOverview}>Test Export Stats</button>
      <button onClick={onExportSessions}>Test Export Sessions</button>
    </>
  ),
}));
vi.mock('../../src/components/stats/SessionHistory', () => ({
  default: () => <div>SESSION_WIDGET</div>,
}));
vi.mock('../../src/components/stats/BankrollTracker', () => ({
  default: () => <div>BANKROLL_WIDGET</div>,
}));
vi.mock('../../src/components/stats/AdvancedStatsSummary', () => ({ default: () => null }));
vi.mock('../../src/pages/stats/statsCsvExport', () => ({
  exportStatsOverview: exportMocks.overview,
  exportStatsSessions: exportMocks.sessions,
}));

import AnalysisTab from '../../src/pages/stats/AnalysisTab';

describe('selected-club session coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows unavailable coverage instead of empty session and bankroll widgets', async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <AnalysisTab
          {...({
            overall: { tourney_hands: 0 },
            full: null,
            panelResetKey: 'club-1:all',
            targetUserId: 'user-1',
            rangeKey: 'all',
            rangeLabel: 'All',
            printing: false,
            advancedInitialData: {},
            sessionRows: [],
            sessionsAvailable: false,
            sessionsReason: 'not_captured_in_ca_hand_facts',
            exportContext: {},
            handMode: 'recent',
            setHandMode: vi.fn(),
            hands: [],
            handsLoading: false,
            handsError: false,
            setHandsReload: vi.fn(),
            openHandEvidence: vi.fn(),
          } as any)}
        />
      </Suspense>
    );
    expect(
      await screen.findByText(/Session History Is Unavailable For This Club/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Cumulative Session P\/L Is Unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('SESSION_WIDGET')).not.toBeInTheDocument();
    expect(screen.queryByText('BANKROLL_WIDGET')).not.toBeInTheDocument();
  });

  it('wires selected-club scope and exact metadata into both CSV export clicks', async () => {
    render(
      <Suspense fallback={<div>Loading</div>}>
        <AnalysisTab
          {...({
            overall: {
              tourney_hands: 0,
              vpip: 0.25,
              pfr: 0.18,
              three_bet_percent: 0.07,
              fold_to_three_bet: 0.4,
              cbet_flop: 0.55,
              aggression_factor: 1.8,
              wtsd: 0.3,
              hours_played: 12,
            },
            full: null,
            panelResetKey: 'club-1:7d',
            targetUserId: 'user-1',
            rangeKey: '7d',
            rangeLabel: '7 Days',
            printing: false,
            advancedInitialData: {},
            sessionRows: [
              {
                date: '2026-10-05T12:00:00Z',
                ended: '2026-10-05T13:00:00Z',
                duration_minutes: 60,
                hands_played: 20,
                buy_in: 100,
                cash_out: 125,
                profit_loss: 25,
              },
            ],
            sessionsAvailable: false,
            sessionsReason: 'not_captured_in_ca_hand_facts',
            exportContext: {
              clubName: 'Shark Club',
              timezone: 'America/Chicago',
              asset: 'chips',
              contract: {
                contract_version: 2,
                generated_at: '2026-10-05T13:00:00Z',
                coverage: {
                  analysis_hand_cap: 25_000,
                  analysis_hands_capped: false,
                  lifetime_index_complete: true,
                  rollup_covered_through: '2026-10-05',
                },
                quality: {
                  cash_money_source: 'exact_settlement',
                  club_breakdown_starts_at: '2026-09-01',
                  metric_availability: {
                    three_bet_percent: true,
                    fold_to_three_bet: true,
                    cbet_flop: true,
                    aggression_factor: true,
                    wtsd: true,
                    hours_played: true,
                  },
                },
              },
              tournaments: {
                entries: 3,
                cashes: 1,
                wins: 0,
                best_finish: 2,
                total_buyins: 30,
                total_winnings: 70,
                total_prizes: 50,
                total_bounty_winnings: 20,
                total_bounties: 1,
                net_profit: 40,
                itm_percent: 1 / 3,
                roi: 4 / 3,
              },
              privacyPresentationMode: false,
            },
            handMode: 'recent',
            setHandMode: vi.fn(),
            hands: [],
            handsLoading: false,
            handsError: false,
            setHandsReload: vi.fn(),
            openHandEvidence: vi.fn(),
            clubId: 'club-1',
          } as any)}
        />
      </Suspense>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Test Export Stats' }));
    await waitFor(() => expect(exportMocks.overview).toHaveBeenCalledTimes(1));
    expect(exportMocks.overview.mock.calls[0][0]).toMatchObject({
      vpip: 0.25,
      tournament_entries: 3,
      tournament_total_prizes: 50,
      tournament_total_bounty_winnings: 20,
    });
    expect(exportMocks.overview.mock.calls[0][2]).toMatchObject({
      clubId: 'club-1',
      clubName: 'Shark Club',
      range: 'Last 7 Days',
      timezone: 'America/Chicago',
      asset: 'chips',
      unit: 'chips',
      source: 'exact_settlement',
      privacyPresentationMode: false,
    });
    expect(exportMocks.overview.mock.calls[0][3]).toBe('player_stats_overview_club-1_7d.csv');

    fireEvent.click(screen.getByRole('button', { name: 'Test Export Sessions' }));
    await waitFor(() => expect(exportMocks.sessions).toHaveBeenCalledTimes(1));
    expect(exportMocks.sessions.mock.calls[0][0][0]).toMatchObject({
      duration_minutes: 60,
      hands: 20,
      buy_in: 100,
      cash_out: 125,
      profit: 25,
    });
    expect(exportMocks.sessions.mock.calls[0][1]).toMatchObject({ clubId: 'club-1' });
    expect(exportMocks.sessions.mock.calls[0][2]).toBe('player_session_history_club-1_7d.csv');
  });
});
