/**
 * THE DIAMONDS CARD GAME ON THE WHEEL PAGE (owner ruling 2026-09-21, R15).
 *
 * The popup itself is pinned by DiamondCardPick.test.tsx. This is the wiring
 * around it, in the three places a pick can be waiting:
 *
 *   (a) ONE SPIN. The wheel lands on Diamonds, the reveal stays up with a
 *       Pick A Card plate, and the three cards open when it is tapped. Nothing
 *       is paid by the spin, so nothing may be shown as paid.
 *   (b) INSIDE A RUN. A pick accumulates exactly as a bonus game does: the
 *       Won So Far tally counts it and the end-of-run summary lists it behind
 *       the same Pick A Card plate, with the games waiting behind the cards.
 *   (c) ON LOAD. `state.pending_cards` puts a persistent card on the page and
 *       blocks the next spin until the pick is made, the way an unplayed bonus
 *       game does.
 *
 * And at every one of them, with the clock under control, two minutes pass and
 * nothing picks a card for the player (R1).
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  runBegin: vi.fn(),
  runEnd: vi.fn(),
  pick: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: {
    getStateV2: backend.state,
    commit: backend.commit,
    spinV2: backend.spin,
    runBegin: backend.runBegin,
    runEnd: backend.runEnd,
    pickDiamondCard: backend.pick,
    welcomeState: async () => ({ available: false, enabled: false }),
    dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
    history: async () => [],
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'player' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: 'club' }),
  useNavigate: () => backend.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'd1000000-0000-4000-8000-000000000003',
}));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: vi.fn() }),
}));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/BonusReplayLibrary', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({ onLanded, spinning, upgraded }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      {upgraded ? 'Land Upgrade Wheel' : 'Land Wheel'}
    </button>
  ),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';

const wheel = receipts.filter((r) => r.kind === 'wheel').map((r) => r.value as any);
const chipsReceipt = wheel.find((r) => r.outcome.kind === 'chips' && !r.welcome)!;
const diamondsReceipt = wheel.find((r) => r.outcome.kind === 'diamonds')!;
const RUN_ID = 'd1000000-0000-4000-8000-000000000a01';
const AWARD = 'd1000000-0000-4000-8000-0000000000c1';
const award = (id = AWARD, risk = 100) => ({
  id,
  spin_id: 'd1000000-0000-4000-8000-0000000000c9',
  risk_diamonds: risk,
});
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: chipsReceipt.segments,
  pending_awards: [],
  pending_cards: [],
  auto_run: null,
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
};
let ticket = 0;
let serial = 0;
/** The fixture receipt, sealed to this attempt's ticket and stake. */
const sealed = (base: any, attempt: any, cards?: unknown) => ({
  ...base,
  spin_id: `d1000000-0000-4000-8000-${String(1000 + ++serial).padStart(12, '0')}`,
  entry_value_diamonds: attempt.entryDiamonds,
  player_cost_diamonds: attempt.entryDiamonds,
  fairness: {
    ...base.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  },
  /* The sealed award rides on the receipt's own Diamonds outcome. What the
     server puts in `amount` for an unpicked award is its own business (D1);
     nothing here reads it, and the client's existing receipt validator still
     wants a positive one, so the fixture's own figure is left alone. */
  outcome: cards ? { ...base.outcome, cards } : base.outcome,
});
const PICKED = {
  ok: true,
  award_id: AWARD,
  picked: 1,
  cards: [300, 50, 200],
  paid_diamonds: 300,
  balances: { diamonds: 10300 },
};

beforeEach(() => {
  ticket = 0;
  serial = 0;
  backend.state.mockResolvedValue(state);
  backend.commit.mockImplementation(async () => ({
    ok: true,
    commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
    server_seed_hash: 'a'.repeat(64),
  }));
  backend.pick.mockResolvedValue(PICKED);
  backend.runBegin.mockImplementation(async (_club: string, spins: number) => ({
    ok: true,
    run_id: RUN_ID,
    spins,
    spins_done: 0,
  }));
  backend.runEnd.mockImplementation(async (run_id: string) => ({
    ok: true,
    run_id,
    spins_done: 5,
    pending_awards: [],
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
});

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const ready = async () => {
  render(<DiamondWheelPage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
  );
};

describe('a Diamonds spin opens its three cards, and nothing else does', () => {
  it('keeps the reveal up behind a Pick A Card plate and opens the cards on the tap', async () => {
    await ready();
    backend.spin.mockImplementation(async (attempt: any) =>
      sealed(diamondsReceipt, attempt, {
        award_id: AWARD,
        risk_diamonds: attempt.entryDiamonds,
        status: 'pending',
      })
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
    });
    const reveal = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.animationEnd(reveal.querySelector('[data-motion="keep"]')!);
    });
    const plate = screen.getByRole('button', { name: 'Pick A Card' });
    // Two minutes on the reveal: no card is picked and nothing closes it.
    await settle(120_000);
    expect(backend.pick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pick A Card' })).toBeInTheDocument();
    fireEvent.click(plate);
    await settle();
    const cards = screen.getByRole('dialog', { name: 'Diamond Card Pick' });
    expect(within(cards).getByRole('button', { name: 'Card One' })).toBeInTheDocument();
    // Still nothing picked: the player has to tap a card.
    await settle(120_000);
    expect(backend.pick).not.toHaveBeenCalled();
    fireEvent.click(within(cards).getByRole('button', { name: 'Card One' }));
    await settle();
    expect(backend.pick).toHaveBeenCalledWith(AWARD, 1);
    expect(within(cards).getByRole('status')).toHaveTextContent('You Won 300 Diamonds');
    backend.state.mockResolvedValue({ ...state, pending_cards: [] });
    fireEvent.click(within(cards).getByRole('button', { name: 'Continue' }));
    await settle();
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Diamond Card Pick' })).toBeNull();
    /* The spin paid nothing, so the page never says it did: the receipt's own
       Diamonds figure is not a prize until a card is turned over (R15). */
    expect(screen.getByText('You Won A Diamond Card Pick')).toBeInTheDocument();
    expect(screen.queryByText(/You Won 200 Diamonds/)).toBeNull();
  });

  it('shows a waiting pick on load, blocks the next spin, and opens it only on the plate', async () => {
    backend.state.mockResolvedValue({ ...state, pending_cards: [award()] });
    render(<DiamondWheelPage />);
    const plate = await screen.findByRole('button', { name: 'Pick A Card' });
    expect(screen.getByText('You Have A Diamond Card Pick Waiting')).toBeInTheDocument();
    expect(screen.getByText('Diamond Cards, 100 Diamonds Risked')).toBeInTheDocument();
    expect(screen.getByText('Pick Your Diamond Card Before Another Spin')).toBeInTheDocument();
    vi.useFakeTimers();
    await settle(120_000);
    expect(backend.pick).not.toHaveBeenCalled();
    expect(backend.spin).not.toHaveBeenCalled();
    fireEvent.click(plate);
    await settle();
    const cards = screen.getByRole('dialog', { name: 'Diamond Card Pick' });
    fireEvent.click(within(cards).getByRole('button', { name: 'Card Two' }));
    await settle();
    expect(backend.pick).toHaveBeenCalledWith(AWARD, 2);
    // The server recorded card one, so that is the pick the player is shown.
    expect(
      within(cards).getByRole('button', { name: 'Card One, 3x, 300 Diamonds, Your Pick' })
    ).toBeInTheDocument();
    // Closing re-reads the wheel: the pick is gone and the spin plate is live.
    backend.state.mockResolvedValue({ ...state, pending_cards: [] });
    fireEvent.click(within(cards).getByRole('button', { name: 'Continue' }));
    /* Two settles: one for the pick to close, one for the wheel state it asks
       for on the way out. `waitFor` is not used while the clock is faked, it
       polls on a timer nothing is advancing. */
    await settle();
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Diamond Card Pick' })).toBeNull();
    expect(screen.queryByText('You Have A Diamond Card Pick Waiting')).toBeNull();
    expect(screen.queryByText('Pick Your Diamond Card Before Another Spin')).toBeNull();
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
  });

  it('lists two waiting picks and names the first one', async () => {
    backend.state.mockResolvedValue({
      ...state,
      pending_cards: [award(), award('d1000000-0000-4000-8000-0000000000c2', 2500)],
    });
    render(<DiamondWheelPage />);
    expect(await screen.findByText('You Have 2 Diamond Card Picks Waiting')).toBeInTheDocument();
    expect(screen.getByText('Diamond Cards, 100 Diamonds Risked')).toBeInTheDocument();
    expect(
      screen.getByText('Then 1 More. One Card Pays Half, One Pays 2x, One Pays 3x.')
    ).toBeInTheDocument();
  });
});

describe('a run counts its card picks and hands them over one at a time', () => {
  it('tallies them while it turns and offers them on the summary before the games', async () => {
    await ready();
    backend.spin.mockImplementation(async (attempt: any) =>
      serial % 2 === 0
        ? sealed(diamondsReceipt, attempt, {
            award_id: AWARD,
            risk_diamonds: attempt.entryDiamonds,
            status: 'pending',
          })
        : sealed(chipsReceipt, attempt)
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Spin 5' }));
    await settle();
    await settle();
    for (let i = 1; i <= 5; i++) {
      if (i === 5) backend.state.mockResolvedValue({ ...state, pending_cards: [award()] });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
      });
      if (i < 5) expect(screen.getByText(/Won So Far/)).toHaveTextContent(/Card Pick/);
      await settle(1200);
    }
    const summary = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(summary).getByText('1 Diamond Card Pick To Make')).toBeInTheDocument();
    expect(
      within(summary).getByRole('list', { name: 'Diamond Card Picks Won This Run' }).children
    ).toHaveLength(1);
    // Two minutes on the summary picks nothing.
    await settle(120_000);
    expect(backend.pick).not.toHaveBeenCalled();
    fireEvent.click(within(summary).getByRole('button', { name: 'Pick A Card' }));
    await settle();
    const cards = screen.getByRole('dialog', { name: 'Diamond Card Pick' });
    fireEvent.click(within(cards).getByRole('button', { name: 'Card One' }));
    await settle();
    expect(backend.pick).toHaveBeenCalledTimes(1);
    expect(within(cards).getByRole('status')).toHaveTextContent('You Won 300 Diamonds');
    backend.state.mockResolvedValue({ ...state, pending_cards: [] });
    fireEvent.click(within(cards).getByRole('button', { name: 'Continue' }));
    await settle();
    // The summary comes back, one pick shorter, with nothing left to pick.
    const back = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(back).queryByRole('button', { name: 'Pick A Card' })).toBeNull();
    expect(within(back).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });
});
