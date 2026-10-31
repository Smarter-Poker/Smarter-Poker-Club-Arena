import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import { EMPTY_OVERALL } from '../../src/pages/stats/playerStatsPageModel';
import OverviewTab from '../../src/pages/stats/OverviewTab';
import { playerStyleFromStats } from '../../src/components/stats/playerStyleFromStats';
import { profileStatsFromV2 } from '../../src/utils/profileStats';
import { findLeaks } from '../../src/components/stats/findLeaks';
import AdvancedStatsSummary from '../../src/components/stats/AdvancedStatsSummary';

vi.mock('../../src/components/stats/BenchmarkPanel', () => ({
  default: ({ values }: any) => <pre data-testid="bench-values">{JSON.stringify(values)}</pre>,
}));
vi.mock('../../src/components/stats/NemesisPanel', () => ({ default: () => null }));
vi.mock('../../src/components/stats/StatsShareCard', () => ({ default: () => null }));
afterEach(cleanup);

function overview(available: boolean, cashHands = 100) {
  return render(
    <Suspense fallback={null}>
      <OverviewTab
        {...({
          overall: {
            ...EMPTY_OVERALL,
            total_hands: 300,
            cash_hands: cashHands,
            tourney_hands: 300 - cashHands,
            three_bet_percent: 0.037,
            vpip: 0.28,
            pfr: 0.15,
          },
          metricAvailability: { three_bet_percent: available },
          full: null,
          isOwnProfile: false,
          panelResetKey: 'sample',
          rangeKey: 'all',
          rangeLabel: 'All',
          showdownWinRate: 'Not Yet Measured',
          handsWonPct: 15,
          clubLabel: 'Club',
          windowDays: null,
        } as any)}
      />
    </Suspense>
  );
}

describe('recorded rates remain distinct from unavailable values', () => {
  it('uses measured cash hand time rather than tournament time for cash hourly rate', async () => {
    render(
      <AdvancedStatsSummary
        initialData={{
          total_profit: 100,
          hours_played: 10,
          cash_hours_played: 2,
          metric_availability: { hours_played: true, cash_hours_played: true },
        }}
      />
    );
    const card = screen.getByText('Hourly Rate').closest('[role="button"]') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('+50')).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it('does not substitute measured total hours for missing cash-time coverage', () => {
    render(
      <AdvancedStatsSummary
        initialData={{
          total_profit: 100,
          hours_played: 10,
          cash_hours_played: 0,
          metric_availability: { hours_played: true, cash_hours_played: false },
        }}
      />
    );
    const card = screen.getByText('Hourly Rate').closest('[role="button"]') as HTMLElement;
    expect(within(card).getByText('Not Yet Measured')).toBeInTheDocument();
  });
  it('does not coach from unmeasured advanced rates', () => {
    const result = findLeaks(
      {
        total_hands: 2000,
        vpip: 0.25,
        pfr: 0.2,
        fold_to_three_bet: 0.9,
        aggression_factor: 0.61,
        cbet_flop: 0.99,
      } as any,
      [],
      {}
    );
    expect(result.leaks.map((x) => x.id)).not.toEqual(
      expect.arrayContaining(['folds_to_3bet', 'passive_postflop', 'cbet_too_high'])
    );
    expect(result.leaks.some((x) => /3bet|passive|cbet/.test(x.id))).toBe(false);
  });
  it('does not classify a player from an unqualified aggression denominator', () => {
    expect(
      playerStyleFromStats(
        { total_hands: 1000, vpip: 0.25, pfr: 0.2, aggression_factor: 0.61 },
        false
      )
    ).toBeNull();
  });
  it('retains unavailable rate evidence in the profile normalization', () => {
    const absent = profileStatsFromV2({
      contract_version: 2,
      overall: { total_hands: 100, three_bet_percent: 0 },
    });
    expect(absent.threeBetMeasured).toBe(false);
    const measured = profileStatsFromV2({
      contract_version: 2,
      overall: { total_hands: 100, three_bet_percent: 0.037 },
      quality: { metric_availability: { three_bet_percent: true } },
    });
    expect(measured.threeBetMeasured).toBe(true);
    expect(measured.threeBet).toBeCloseTo(3.7);
  });
  it('never sends an unmeasured three-bet to comparison or coaching', async () => {
    overview(false);
    const values = JSON.parse((await screen.findByTestId('bench-values')).textContent!);
    expect(values).not.toHaveProperty('three_bet');
    expect(values.vpip).toBeCloseTo(28);
  });

  it('converts measured three-bet fractions exactly once', async () => {
    overview(true);
    const values = JSON.parse((await screen.findByTestId('bench-values')).textContent!);
    expect(values.three_bet).toBeCloseTo(3.7);
  });

  it('does not benchmark zero cash performance for tournament-only play', async () => {
    overview(true, 0);
    const values = JSON.parse((await screen.findByTestId('bench-values')).textContent!);
    expect(values).not.toHaveProperty('bb100');
    expect(values).toHaveProperty('three_bet');
  });

  it('shows unavailable advanced rates without numeric zeroes or hourly units', () => {
    render(
      <AdvancedStatsSummary
        initialData={{
          total_hands: 200,
          three_bet_percent: 0,
          cbet_flop: 0,
          aggression_factor: 0,
          hours_played: 0,
          metric_availability: {
            three_bet_percent: false,
            cbet_flop: false,
            aggression_factor: false,
            hours_played: false,
          },
        }}
      />
    );
    for (const label of ['3-Bet %', 'C-Bet Frequency', 'Aggression Factor', 'Hourly Rate']) {
      const card = screen.getByText(label).closest('[role="button"]') as HTMLElement;
      expect(within(card).getByText('Not Yet Measured')).toBeInTheDocument();
      expect(within(card).queryByText('0.0%')).not.toBeInTheDocument();
    }
    expect(screen.queryByText('/hr')).not.toBeInTheDocument();
  });
});
