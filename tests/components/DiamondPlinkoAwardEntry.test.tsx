// The real hook returns the release a page's exits call before they leave.
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';
import { PLINKO_DROPS } from '../../src/utils/bonusGameBudget';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  start: vi.fn(),
  latest: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: backend }));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: backend,
  BonusRefusal: class extends Error {},
  parsePlinkoBonus: (v: unknown) => v,
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
  useLocation: () => ({ search: '' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({
  default: ({
    batchPathBits,
    onLanded,
  }: {
    batchPathBits: number[] | null;
    onLanded: () => void;
  }) => (batchPathBits ? <button onClick={onLanded}>Finish Drops</button> : null),
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({
    title,
    detail,
    onOpen,
  }: {
    title: string;
    detail: string;
    onOpen: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      {detail}
      <button onClick={onOpen}>Finish Prize</button>
    </div>
  ),
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
/**
 * ONE TABLE PER STAKE KIND, AND NOBODY PICKS ANYTHING.
 *
 * Diamond Plinko was recalibrated on 2026-09-19: every game is exactly ten
 * drops of a tenth of the entry, the drop value is derived and the risk levels
 * are gone. Two tables remain, named by the server's own quote - Diamond
 * (version 5) for an ordinary award, Super (version 4) for a Super one - and
 * both top out at exactly 20x.
 *
 * The assertions this file used to make ('20 Diamonds Per Drop, 10 Drops',
 * '4 Diamonds Per Drop, 1250 Drops', 'Medium Risk') were the controls that
 * created the defect Dan reported: at one to five diamonds a drop, a
 * 2,500-diamond award was hundreds of drops whose average could only ever be
 * the table's 0.80, so the game could never return more than its entry. They
 * are rewritten, not deleted: what replaces each one is the derived value the
 * player now gets instead of the choice they used to make.
 */
const DIAMOND_TABLE = {
  name: 'Diamond',
  version: 5,
  multipliers_cents: PLINKO_TABLES[5].multipliersCents,
  max_multiplier_cents: 2000,
};
const SUPER_TABLE = {
  name: 'Super',
  version: 4,
  multipliers_cents: PLINKO_TABLES[4].multipliersCents,
  max_multiplier_cents: 2000,
};
const state = {
  available: true,
  frozen: false,
  tables: [DIAMOND_TABLE, SUPER_TABLE],
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500 },
  player: { spendable: 0, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
/** The server's own guarantee for an award, exactly as `parseBonusGuarantee` returns it. */
const quoteFor = (boost: 1 | 2, minimumPayoutChips: number) => ({
  guarantee: boost === 2 ? ('super' as const) : ('standard' as const),
  minimumPayoutChips,
  mode: null,
  plinkoTable: boost === 2 ? 4 : 5,
});
/** A deck bay reads `<dt>label</dt><dd>value</dd>`, so the value is the next element. */
const bay = (label: string) => screen.getByText(label).nextElementSibling;
/** Nothing on this page may offer a drop value, a drop count or a risk level. */
const expectNoChoiceControls = () => {
  expect(screen.queryByRole('button', { name: /Per Drop/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Diamonds Per Drop/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Risk/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Drops$/ })).toBeNull();
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  backend.getState.mockResolvedValue(state);
  backend.latest.mockResolvedValue(null);
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-000000000009',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.start.mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);
describe('Plinko starts only its earned funding', () => {
  it('shows its exact confirmed prize after the final drop and returns to its wheel', async () => {
    backend.awardState.mockResolvedValue({
      enabled: false,
      award: null,
      gameState: null,
      quote: null,
    });
    backend.getState.mockResolvedValue({
      ...state,
      bets: [{ bet_diamonds: 100, cap_cents: 2000, playable: true }],
      player: { ...state.player, spendable: 100 },
    });
    backend.start.mockResolvedValue({
      ...fixtures.receipts.plinko,
      table_version: 5,
      payout_chips: 12.57,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Drops' }));
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: '12.57 Chips' })).toBeInTheDocument();
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Prize' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel',
      { replace: true }
    );
  });
  it('plays a Super award on the Super table with its drop value derived as the tenth', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'plinko',
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
      status: 'pending',
    };
    backend.awardState.mockResolvedValue({
      enabled: true,
      award,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    // Boost 2 is the Super form of the game, everywhere it is named.
    expect(screen.getByRole('heading', { name: 'Super Plinko' })).toBeVisible();
    // Ten drops, and the drop value is 200 / 10. There is nothing to press.
    expect(bay('Per Drop')).toHaveTextContent('20');
    expect(bay('Drops')).toHaveTextContent(String(PLINKO_DROPS));
    expectNoChoiceControls();
    // The Guaranteed bay is the server's own quote, in gold for a Super award.
    expect(bay('Guaranteed')).toHaveTextContent('10.00 Chips');
    expect(bay('Guaranteed')).toHaveAttribute('data-ink', 'gold');
    // The same promise reads in the setup panel and in the line above the board.
    expect(
      screen.getAllByText('Super Plinko Pays At Least 10.00 Chips, Even If Every Drop Lands Low.')
        .length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    // `tableVersion` is the table the quote named, and `budget.denomination` is
    // what DiamondBonusService sends as `p_denom`: the tenth, never a choice.
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tableVersion: 4,
        budget: {
          base: 200,
          doubled: false,
          denomination: 20,
          award: { id: award.id, entryDiamonds: 100, boostMultiplier: 2 },
        },
      }),
      'player-a'
    );
    // An earned entry is quoted by the award read alone: no legacy direct quote.
    expect(backend.getState).not.toHaveBeenCalled();
    expect(backend.latest).not.toHaveBeenCalled();
  });
  it('re-derives the tenth for an ordinary award after Double Down and plays the Diamond table', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'plinko',
      base_diamonds: 2500,
      entry_diamonds: 2500,
      boost_multiplier: 1,
      status: 'pending',
    };
    backend.latest.mockResolvedValue(fixtures.receipts.plinko);
    backend.getState.mockRejectedValue(new Error('Legacy direct entry is unavailable'));
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award,
      gameState: {
        ...state,
        bets: [{ bet_diamonds: doubled ? 5000 : 2500, cap_cents: 2000, playable: true }],
        player: { ...state.player, spendable: 10000 },
      },
      quote: quoteFor(1, doubled ? 50 : 25),
    }));
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Diamond Plinko' })).toBeVisible();
    expect(bay('Per Drop')).toHaveTextContent('250');
    const offer = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
    fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add Diamonds' }));
    await act(async () => {});
    // 5,000 diamonds still plays exactly ten drops, so the drop value moves with it.
    expect(bay('Per Drop')).toHaveTextContent('500');
    expect(bay('Drops')).toHaveTextContent(String(PLINKO_DROPS));
    expect(bay('Guaranteed')).toHaveTextContent('50.00 Chips');
    expect(bay('Guaranteed')).not.toHaveAttribute('data-ink', 'gold');
    expectNoChoiceControls();
    expect(screen.getByText(`10 Drops × 500 Diamonds = 5,000 Diamonds`)).toBeVisible();
    expect(screen.queryByText(/Chips Booked From/)).not.toBeInTheDocument();
    // The offer is answered, so the won game is counting down to its own drop;
    // pressing sooner still works.
    expect(screen.getByRole('button', { name: /^Dropping In \ds$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Dropping In \ds$/ }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tableVersion: 5,
        budget: {
          base: 2500,
          doubled: true,
          denomination: 500,
          award: { id: award.id, entryDiamonds: 2500, boostMultiplier: 1 },
        },
      }),
      'player-a'
    );
    expect(backend.getState).not.toHaveBeenCalled();
    expect(backend.latest).not.toHaveBeenCalled();
  });
  it('refuses an uncovered entry and explains how to remove Double Down', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'plinko',
      base_diamonds: 2500,
      entry_diamonds: 2500,
      boost_multiplier: 1,
      status: 'pending',
    };
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award,
      gameState: {
        ...state,
        tables: [DIAMOND_TABLE],
        bets: [
          { bet_diamonds: doubled ? 5000 : 2500, cap_cents: doubled ? 1000 : 2000, playable: true },
        ],
        player: { ...state.player, spendable: 10000 },
      },
      quote: quoteFor(1, 25),
    }));
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add Diamonds' }));
    await act(async () => {});
    expect(screen.getByText(/This Bonus Does Not Cover A Doubled Entry/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('replays the one held request when a start is uncertain, and debits nothing twice', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'plinko',
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
      status: 'pending',
    };
    backend.awardState.mockResolvedValue({
      enabled: true,
      award,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    backend.start.mockRejectedValueOnce(new Error('The Network Dropped'));
    backend.start.mockResolvedValue({
      ...fixtures.receipts.plinko,
      table_version: 4,
      payout_chips: 3.25,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await act(async () => {});
    // An uncertain start is never retried as a fresh wager, and nobody is
    // asked to check anything: the page replays the held request itself.
    // (The replay can land before the first assertion, so assert the outcome,
    // not the brief "Settling" state in between.)
    expect(screen.queryByRole('button', { name: 'Check Bonus' })).not.toBeInTheDocument();
    const held = backend.start.mock.calls[0][0];
    // The same request, sent again, and the receipt is booked once.
    await waitFor(() => expect(backend.start).toHaveBeenCalledTimes(2));
    expect(backend.start.mock.calls[1][0]).toEqual(held);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument()
    );
    expect(backend.start).toHaveBeenCalledTimes(2);
  });
  it('recovers a redeemed award without admitting a second wager', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: {
        id: '00000000-0000-0000-0000-000000000077',
        game: 'plinko',
        base_diamonds: 200,
        entry_diamonds: 100,
        boost_multiplier: 2,
        status: 'redeemed',
        result: { ...fixtures.receipts.plinko, table_version: 4, payout_chips: 7.5 },
      },
      gameState: null,
      quote: null,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: '7.50 Chips' })).toBeInTheDocument();
    expect(screen.getByText(/10 Drops Completed\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('routes a direct visitor back to the wheel without admitting a new wager', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: null,
      gameState: null,
      quote: null,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Spin The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel'
    );
    expect(backend.start).not.toHaveBeenCalled();
  });
});
