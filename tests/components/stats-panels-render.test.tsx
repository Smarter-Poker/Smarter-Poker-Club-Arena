/**
 * Every new stats panel must actually RENDER.
 *
 * This file exists because the stats page went to the error boundary in
 * production ("Player Stats Encountered An Error") while 2,688 unit tests were
 * green. Every one of those tests exercised a pure function; not one of them
 * ever mounted a component. A render throw is invisible to that kind of suite,
 * and the page is wrapped in an error boundary, so the only symptom is a blank
 * warning screen with no clue in it.
 *
 * These are deliberately shallow: mount with realistic props, assert something
 * recognisable appears. The point is not to test behaviour — that is covered
 * elsewhere — it is to guarantee that no panel can throw during render again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────
// The fact-layer service talks to Supabase. Every panel that uses it must
// tolerate an empty payload, which is also the real state until hands
// accumulate.

vi.mock('../../src/services/StatsFactsService', () => {
  // NOTE: vi.mock factories are HOISTED to the top of the file, so anything
  // they reference must be declared INSIDE them. `emptyEV` used to sit at
  // module scope and the factory closed over it, which threw
  // "Cannot access 'emptyEV' before initialization" at load time — the whole
  // file failed to import, and because the client suite gates the World Hub
  // bundle publish that stopped shipping for everyone.
  const emptyEV = {
    points: [],
    summary: {
      hands: 0,
      all_in_hands: 0,
      net_bb: 0,
      ev_net_bb: 0,
      luck_bb: 0,
      luck_bb_per_100: 0,
      biggest_suckout: 0,
      biggest_beat: 0,
      capped: false,
    },
    generated_at: '',
  };
  const svc = {
    getEVCurve: vi.fn().mockResolvedValue(emptyEV),
    getHandGrid: vi
      .fn()
      .mockResolvedValue({ cells: [], totals: { hands: 0, classes_seen: 0 }, filters: {} }),
    getClassHands: vi.fn().mockResolvedValue({ hand_class: null, hands: [] }),
    getNemesis: vi.fn().mockResolvedValue({
      nemesis: null,
      target: null,
      worst: [],
      best: [],
      min_hands: 25,
      opponents_qualified: 0,
      generated_at: '',
    }),
    getDistribution: vi.fn().mockResolvedValue([
      {
        cohort: 'field',
        metric: 'bb100',
        p10: -52,
        p25: -30,
        p50: -15,
        p75: 0,
        p90: 15,
        sample_size: 571,
      },
      {
        cohort: 'field',
        metric: 'vpip',
        p10: 27,
        p25: 32,
        p50: 38,
        p75: 44,
        p90: 50,
        sample_size: 571,
      },
      {
        cohort: 'field',
        metric: 'pfr',
        p10: 6,
        p25: 9,
        p50: 12,
        p75: 16,
        p90: 21,
        sample_size: 569,
      },
      {
        cohort: 'field',
        metric: 'win_rate',
        p10: 18,
        p25: 20,
        p50: 21,
        p75: 23,
        p90: 25,
        sample_size: 571,
      },
    ]),
  };
  return { __esModule: true, default: svc, StatsFactsService: svc };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import LeakPanel from '../../src/components/stats/LeakPanel';
import BenchmarkPanel from '../../src/components/stats/BenchmarkPanel';
import NemesisPanel from '../../src/components/stats/NemesisPanel';
import TrophyRoom from '../../src/components/stats/TrophyRoom';
import PositionalRadar from '../../src/components/stats/PositionalRadar';
import EVLuckChart from '../../src/components/stats/EVLuckChart';
import HoleCardHeatmap from '../../src/components/stats/HoleCardHeatmap';
import StatsShareCard from '../../src/components/stats/StatsShareCard';

/** A player WITH hands — the path that actually renders every panel. */
const OVERALL = {
  total_hands: 20000,
  cash_hands: 18000,
  tourney_hands: 2000,
  hands_won: 4200,
  hands_lost: 15800,
  vpip: 0.41,
  pfr: 0.09,
  three_bet_percent: 0.02,
  fold_to_three_bet: 0.81,
  cbet_flop: 0.91,
  aggression_factor: 0.7,
  showdowns_total: 1200,
  showdowns_won: 430,
  wtsd: 0.18,
  total_profit: -4200,
  total_winnings: 1000,
  total_invested: 5200,
  biggest_pot_won: 300,
  biggest_hand_loss: -900,
  bb_per_100: -22.5,
  hours_played: 61.5,
  hand_cap: 750,
  hands_capped: false,
};

const POSITIONS = [
  {
    position: 'UTG',
    hands_played: 3000,
    vpip_count: 1300,
    pfr_count: 200,
    three_bet_count: 40,
    hands_won: 500,
    total_profit: -900,
    bb100: -30,
  },
  {
    position: 'MP',
    hands_played: 3000,
    vpip_count: 1200,
    pfr_count: 220,
    three_bet_count: 40,
    hands_won: 520,
    total_profit: -400,
    bb100: -12,
  },
  {
    position: 'CO',
    hands_played: 3000,
    vpip_count: 1100,
    pfr_count: 260,
    three_bet_count: 50,
    hands_won: 560,
    total_profit: -200,
    bb100: -6,
  },
  {
    position: 'BTN',
    hands_played: 3000,
    vpip_count: 1000,
    pfr_count: 300,
    three_bet_count: 60,
    hands_won: 700,
    total_profit: 300,
    bb100: 9,
  },
  {
    position: 'SB',
    hands_played: 3000,
    vpip_count: 900,
    pfr_count: 180,
    three_bet_count: 30,
    hands_won: 400,
    total_profit: -700,
    bb100: -22,
  },
  {
    position: 'BB',
    hands_played: 3000,
    vpip_count: 1500,
    pfr_count: 150,
    three_bet_count: 30,
    hands_won: 520,
    total_profit: -1100,
    bb100: -34,
  },
];

const TOURNAMENTS = { entries: 40, cashes: 6, wins: 1, best_finish: 1 };

beforeEach(() => vi.clearAllMocks());

describe('every stats panel mounts without throwing', () => {
  it('LeakPanel', () => {
    render(<LeakPanel overall={OVERALL} positions={POSITIONS} />);
    expect(screen.getAllByText(/What To Work On/i).length).toBeGreaterThan(0);
  });

  it('BenchmarkPanel', async () => {
    render(
      <BenchmarkPanel
        handsPlayed={OVERALL.total_hands}
        days={null}
        values={{
          bb100: OVERALL.bb_per_100,
          win_rate: 21,
          vpip: OVERALL.vpip * 100,
          pfr: OVERALL.pfr * 100,
          three_bet: OVERALL.three_bet_percent * 100,
        }}
      />
    );
    // These panels fetch through the mocked service, so nothing is on
    // screen until that promise resolves. Assert after it does.
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });

  it('NemesisPanel', async () => {
    render(<NemesisPanel userId="u1" days={null} />);
    // These panels fetch through the mocked service, so nothing is on
    // screen until that promise resolves. Assert after it does.
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });

  it('TrophyRoom', () => {
    render(<TrophyRoom overall={OVERALL} tournaments={TOURNAMENTS} />);
    expect(screen.getAllByText(/Your Style/i).length).toBeGreaterThan(0);
  });

  it('PositionalRadar', () => {
    render(<PositionalRadar positions={POSITIONS} />);
    expect(screen.getAllByText(/Positional Shape/i).length).toBeGreaterThan(0);
  });

  it('EVLuckChart', async () => {
    render(<EVLuckChart userId="u1" days={null} />);
    // These panels fetch through the mocked service, so nothing is on
    // screen until that promise resolves. Assert after it does.
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });

  it('HoleCardHeatmap', async () => {
    render(<HoleCardHeatmap userId="u1" days={null} />);
    // These panels fetch through the mocked service, so nothing is on
    // screen until that promise resolves. Assert after it does.
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });

  it('StatsShareCard', () => {
    // jsdom has no canvas backend, so getContext returns null. The component
    // must survive that rather than assuming a context exists.
    render(
      <StatsShareCard
        displayName="A Player With A Very Long Display Name Indeed"
        stats={{
          hands: OVERALL.total_hands,
          bb100: OVERALL.bb_per_100,
          profit: OVERALL.total_profit,
          vpip: OVERALL.vpip * 100,
          pfr: OVERALL.pfr * 100,
          hoursPlayed: OVERALL.hours_played,
        }}
        styleLabel="Calling Station"
        styleColor="#ef4444"
      />
    );
    expect(screen.getAllByText(/Share Your Stats/i).length).toBeGreaterThan(0);
  });
});

describe('panels survive empty and malformed data', () => {
  it('LeakPanel with nothing', () => {
    render(<LeakPanel overall={null} positions={null} />);
    expect(screen.getAllByText(/What To Work On/i).length).toBeGreaterThan(0);
  });

  it('TrophyRoom with nothing', () => {
    render(<TrophyRoom overall={null} tournaments={null} />);
    expect(screen.getAllByText(/Trophy Room/i).length).toBeGreaterThan(0);
  });

  it('PositionalRadar with too few positions', () => {
    render(<PositionalRadar positions={[POSITIONS[0]]} />);
    expect(screen.getAllByText(/Positional Shape/i).length).toBeGreaterThan(0);
  });

  it('BenchmarkPanel with no values at all', () => {
    render(<BenchmarkPanel handsPlayed={0} values={{}} />);
    // Renders nothing rather than throwing.
    expect(document.body).toBeTruthy();
  });
});
