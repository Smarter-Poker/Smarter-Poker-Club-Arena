import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';

vi.mock('../../src/components/stats/LeakPanel', () => ({ default: () => null }));
vi.mock('../../src/components/stats/StatsCharts', () => ({ default: () => null }));
vi.mock('../../src/components/stats/SessionHistory', () => ({
  default: () => <div>SESSION_WIDGET</div>,
}));
vi.mock('../../src/components/stats/BankrollTracker', () => ({
  default: () => <div>BANKROLL_WIDGET</div>,
}));
vi.mock('../../src/components/stats/AdvancedStatsSummary', () => ({ default: () => null }));

import AnalysisTab from '../../src/pages/stats/AnalysisTab';

describe('selected-club session coverage', () => {
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
            dailySeries: [],
            positionPie: [],
            profitChartSummary: '',
            dailyChartSummary: '',
            positionChartSummary: '',
            sessionRows: [],
            sessionsAvailable: false,
            sessionsReason: 'not_captured_in_ca_hand_facts',
            exportSessionsCSV: vi.fn(),
            exportOverviewCSV: vi.fn(),
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
});
