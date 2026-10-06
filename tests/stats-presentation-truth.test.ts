import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import PositionWinRates from '../src/components/stats/PositionWinRates';
import { normalizeFull } from '../src/pages/stats/playerStatsPageModel';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

afterEach(cleanup);

describe('Stats presentation truth', () => {
  it('labels hand-derived session results as cumulative P/L, never authoritative bankroll', () => {
    const source = read('src/components/stats/BankrollTracker.tsx');
    expect(source).toContain('Cumulative Session P/L');
    expect(source).not.toContain('>Bankroll Tracker<');
    expect(source).not.toContain('Bankroll Progression');
    expect(source).not.toContain('name="Bankroll"');
  });

  it('describes the field cohort without claiming it is every player in one club', () => {
    const source = read('src/components/stats/BenchmarkPanel.tsx');
    expect(source).toContain('Every Qualifying Player In The Field');
    expect(source).not.toContain('Every Player In The Club');
  });

  it('uses the shared ordinal formatter for benchmark pills', () => {
    const source = read('src/components/stats/BenchmarkPanel.tsx');
    expect(source).toContain("import { ordinal } from '../../utils/format';");
    expect(source).toContain('ordinal(Math.round(r.percentile))');
    expect(source).not.toContain('`${Math.round(r.percentile)}th`');
    expect(source).toContain("import { titleCase } from '../../utils/titleCase';");
    expect(source).toContain('titleCase(r.readout)');
  });

  it('humanizes tournament variants instead of exposing database enums', () => {
    const source = read('src/pages/stats/TournamentsTab.tsx');
    expect(source).toContain("import { compactChips } from '../../utils/format';");
    expect(source).toContain("import { enumToTitleCase, titleCase } from '../../utils/titleCase';");
    expect(source).toContain('enumToTitleCase(t.variant)');
    expect(source).toContain('enumToTitleCase(t.status)');
    expect(source).toContain('titleCase(t.name)');
    expect(source).not.toContain('t.variant.toUpperCase()');
    expect(source).toContain("' · Mystery Bounty'");
    expect(source).not.toContain("' · MYSTERY BOUNTY'");
    expect(source).toContain('compactChips(tourn.total_buyins)');
    expect(source).toContain('compactChips(tourn.total_winnings)');
    expect(source).toContain('compactChips(num(t.prize))');
    expect(source).toContain('compactChips(num(t.total_won))');
    expect(source).not.toContain('tourn.total_buyins.toLocaleString()');
    expect(source).not.toContain('tourn.total_winnings.toLocaleString()');
    expect(source).not.toContain('num(t.prize).toLocaleString()');
    expect(source).not.toContain('num(t.total_won).toLocaleString()');
  });

  it('wires sample-qualified position rankings to an honest fallback', () => {
    const source = read('src/components/stats/PositionWinRates.tsx');
    expect(source).toContain("import { compactChips } from '../../utils/format';");
    expect(source).toContain('selectPositionCallouts(statsData)');
    expect(source).toContain('calloutEligibleCount < 2');
    expect(source).toContain('More Hands Needed');
    expect(source).toContain('At Least Two Known Positions Need');
    expect(source).toContain('compactChips(hovered.totalProfit)');
    expect(source).toContain('compactChips(row.totalProfit)');
    expect(source).toContain('positionTrendLabel(pos.winRate, pos.handsPlayed)');
    expect(source).toContain('positionRateColor(pos.winRate, pos.handsPlayed)');
    expect(source).toContain('positionProgressPercent(pos.winRate, pos.handsPlayed)');
    expect(source).not.toContain('hovered.totalProfit.toLocaleString()');
    expect(source).not.toContain('row.totalProfit.toLocaleString()');
    expect(source).not.toContain('winRate.toFixed(2)');
  });

  it('uses only approved painted crests after selecting the plate-free spade family', () => {
    for (const path of [
      'src/components/stats/CashIntelligencePanel.tsx',
      'src/components/stats/ExactCashSessionsPanel.tsx',
      'src/components/stats/FinancialReportingPanel.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('family="spade"');
      expect(source).toContain('crest="spade"');
      expect(source).not.toContain('crest="club"');
      expect(source).not.toContain('crest="diamond"');
    }
  });

  it('preserves unmeasured position rates and tournament finalization timestamps', () => {
    const normalized = normalizeFull({
      positions: [{ position: 'BTN', hands_played: 900, bb100: null }],
      recent_tournaments: [
        {
          tournament_id: '11111111-1111-4111-8111-111111111111',
          name: 'nightly bounty',
          ended_at: '2026-10-05T20:30:00Z',
        },
      ],
    });

    expect(normalized.positions[0].bb100).toBeNull();
    expect(normalized.recent_tournaments[0].ended_at).toBe('2026-10-05T20:30:00Z');
  });

  it('preserves position opportunities and drives the per-opportunity 3-bet readout', () => {
    const normalized = normalizeFull({
      positions: [
        {
          position: 'BTN',
          hands_played: 600,
          vpip_count: 120,
          pfr_count: 60,
          three_bet_count: 15,
          three_bet_opps: 30,
          bb100: 2.5,
        },
      ],
    });

    expect(normalized.positions[0].three_bet_opps).toBe(30);

    render(createElement(PositionWinRates, { initialPositions: normalized.positions }));

    expect(screen.getByText(/3-Bet Is Measured Per Opportunity To Re-Raise\./)).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('fails malformed, negative, and fractional position opportunity counts closed', () => {
    const normalized = normalizeFull({
      positions: [
        {
          position: 'BTN',
          hands_played: 600,
          three_bet_count: 15,
          three_bet_opps: 'not-a-count',
        },
        { position: 'CO', hands_played: 600, three_bet_opps: -4 },
        { position: 'HJ', hands_played: 600, three_bet_opps: 4.5 },
        { position: 'LJ', hands_played: 600, three_bet_opps: '2.25' },
      ],
    });

    expect(normalized.positions.map((position) => position.three_bet_opps)).toEqual([0, 0, 0, 0]);
  });

  it('labels mixed 3-bet denominators without claiming every row is per opportunity', () => {
    const normalized = normalizeFull({
      positions: [
        {
          position: 'BTN',
          hands_played: 600,
          three_bet_count: 15,
          three_bet_opps: 30,
        },
        {
          position: 'BB',
          hands_played: 600,
          three_bet_count: 12,
          three_bet_opps: 0,
        },
      ],
    });

    render(createElement(PositionWinRates, { initialPositions: normalized.positions }));

    expect(
      screen.getByText(
        /3-Bet Measurement Varies By Position: Per Opportunity Where Available, Otherwise Per Hand Dealt\./
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/3-Bet Is Measured Per Opportunity To Re-Raise\./)
    ).not.toBeInTheDocument();
  });

  it('fails malformed tournament presentation fields closed', () => {
    const normalized = normalizeFull({
      recent_tournaments: [
        {
          start_time: {},
          ended_at: 'not a date',
          variant: {},
          finish_rank: Number.POSITIVE_INFINITY,
          status: [],
        },
        {
          start_time: ' ',
          finish_rank: 0.5,
          variant: ' ',
          status: '',
        },
        { finish_rank: 3.9 },
      ],
    });

    expect(normalized.recent_tournaments[0]).toMatchObject({
      start_time: null,
      ended_at: null,
      variant: null,
      finish_rank: null,
      status: null,
    });
    expect(normalized.recent_tournaments[1]).toMatchObject({
      start_time: null,
      variant: null,
      finish_rank: null,
      status: null,
    });
    expect(normalized.recent_tournaments[2].finish_rank).toBeNull();
  });

  it('keeps direct Player Stats money compact and rate readouts to one decimal', () => {
    const presentationFiles = [
      'src/pages/stats/StatsHeadlineDeck.tsx',
      'src/pages/stats/OverviewTab.tsx',
      'src/pages/stats/PerformanceTab.tsx',
      'src/pages/stats/ClubScopeConsole.tsx',
      'src/pages/stats/AnalysisTab.tsx',
      'src/components/stats/AdvancedStatsSummary.tsx',
      'src/components/stats/BankrollTracker.tsx',
      'src/components/stats/SessionHistory.tsx',
      'src/components/stats/StatsCharts.tsx',
      'src/components/stats/StatsPositionPiePlot.tsx',
      'src/components/stats/TrophyRoom.tsx',
      'src/components/stats/StatsShareCard.tsx',
      'src/components/stats/NemesisPanel.tsx',
    ];

    for (const path of presentationFiles) {
      const source = read(path);
      expect(source, path).toContain('compactChips');
      expect(source, path).not.toContain('toFixed(2)');
    }

    const headline = read('src/pages/stats/StatsHeadlineDeck.tsx');
    expect(headline).toContain('compactChips(overall.total_profit)');
    expect(headline).not.toContain('overall.total_profit.toLocaleString()');

    const overview = read('src/pages/stats/OverviewTab.tsx');
    expect(overview).toContain('compactChips(v.profit)');
    expect(overview).toContain('compactChips(st.profit)');
    expect(overview).not.toContain('String(v.variant).toUpperCase()');

    const performance = read('src/pages/stats/PerformanceTab.tsx');
    for (const field of [
      'total_profit',
      'total_winnings',
      'total_invested',
      'biggest_pot_won',
      'biggest_hand_loss',
    ]) {
      expect(performance).toContain(`compactChips(overall.${field})`);
      expect(performance).not.toContain(`overall.${field}.toLocaleString()`);
    }

    const comparison = read('src/pages/stats/ClubScopeConsole.tsx');
    expect(comparison).toContain('compactChips(row.profit)');
    expect(comparison).toContain('compactChips(row.rake)');
    expect(comparison).toContain('compactChips(row.tournamentWinnings)');

    const analysis = read('src/pages/stats/AnalysisTab.tsx');
    expect(analysis).toContain('enumToTitleCase(h.variant)');
    expect(analysis).toContain('compactChips(h.profit)');
    expect(analysis).toContain('compactChips(h.pot_size)');
  });

  it('humanizes direct Stats enums and generated trophy detail at render time', () => {
    const brief = read('src/components/stats/statsIntelligenceBrief.ts');
    expect(brief).toContain('enumToTitleCase(bestVariant.variant)');
    expect(brief).toContain('signedChips(recentProfit)');
    expect(brief).not.toContain('signed(recentProfit, 0)');
    expect(brief).not.toContain('bestVariant.variant.toUpperCase()');

    const trophies = read('src/components/stats/TrophyRoom.tsx');
    expect(trophies).toContain('titleCase(m.detail)');
    expect(trophies).toContain('enumToTitleCase(hand.game_variant)');
    expect(trophies).not.toContain('hand.game_variant.toUpperCase()');
  });

  it('uses compact chips, one-decimal BB rates, and only approved console inks in Rake', () => {
    const source = read('src/pages/stats/RakeTab.tsx');
    expect(source).toContain('compactChips(rakeStats.rake_paid)');
    expect(source).toContain('compactChips(rakeStats.rake_per_100)');
    expect(source).toContain('compactChips(rakeStats.avg_rake_per_raked_hand)');
    expect(source).toContain('rakeStats.rake_in_bb.toFixed(1)');
    for (const retired of ['#f59e0b', '#00d4ff', '#8b5cf6', '#22c55e', '#06b6d4', '#4169E1']) {
      expect(source).not.toContain(retired);
    }
    for (const ink of ['#ffd700', '#45adff', '#e4e7ec', '#c8ffd2']) {
      expect(source).toContain(ink);
    }
  });
});
