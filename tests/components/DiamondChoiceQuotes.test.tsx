vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import { CHOICE_MODE } from '../../src/utils/diamondChoiceMath';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
import upgrades from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  start: vi.fn(),
  rpc: vi.fn(),
  navigate: vi.fn(),
  awardState: vi.fn(),
  verify: vi.fn(),
  act: vi.fn(),
}));
vi.mock('../../src/utils/diamondChoiceMath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/diamondChoiceMath')>()),
  verifyChoiceRoundDetailed: backend.verify,
}));
vi.mock('../../src/services/DiamondChoiceService', () => ({
  DiamondChoiceService: { state: backend.state, act: backend.act },
  parseChoiceRound: (value: unknown) => value,
}));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: { start: backend.start },
  BonusRefusal: class extends Error {},
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: backend.rpc } }));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useLocation: () => ({ search: '' }),
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/components/games/ChoiceScene', () => ({
  default: ({
    phase,
    onSettled,
    onPick,
  }: {
    phase: string;
    onSettled: () => void;
    onPick: (n: number) => void;
  }) => (
    <section aria-label={`Scene ${phase}`}>
      <button onClick={onSettled}>Finish Scene</button>
      <button onClick={() => onPick(0)}>Pick Tile</button>
    </section>
  ),
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: { getStateV2: () => Promise.resolve({ pending_awards: [] }) },
}));
vi.mock('../../src/services/SoundService', () => ({ soundService: { playWin: vi.fn() } }));
/** Screen one of a won game (R9): the offer is answered by the player's own tap. */
const answerOffer = (choice: 'Play Without' | 'Add The Diamonds' = 'Play Without') => {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
  fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
  fireEvent.click(within(offer).getByRole('button', { name: choice }));
};
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    children,
    plates,
  }: {
    children?: ReactNode;
    plates?: {
      primary?: { label: string; disabled?: boolean; onClick?: () => void };
      secondary?: { label: string; disabled?: boolean; onClick?: () => void };
    };
  }) => (
    <section>
      {children}
      {plates?.secondary && (
        <button disabled={plates.secondary.disabled} onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));
vi.mock('../../src/components/console/DeckConsole', () => ({
  DeckConsole: ({
    children,
    primary,
    bays,
  }: {
    children?: ReactNode;
    primary: {
      label: string;
      disabled?: boolean;
      onClick?: () => void;
    };
    bays: Array<{ label: string; disabled?: boolean; onPress?: () => void }>;
  }) => (
    <section>
      {children}
      {bays
        .filter((bay) => bay.onPress)
        .map((bay) => (
          <button key={bay.label} disabled={bay.disabled} onClick={bay.onPress}>
            {bay.label}
          </button>
        ))}
      <button disabled={primary.disabled} onClick={primary.onClick}>
        {primary.label}
      </button>
    </section>
  ),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const state = {
  ok: true,
  available: true,
  frozen: false,
  is_member: true,
  diamonds: 10000,
  member_chips: 0,
  diamonds_per_chip: 100,
  bets: [100],
  open_round: null,
  history: [],
  max_steps: 12,
  prizes: Array(12).fill(1),
  rounds_today: 0,
  daily_limit: 500,
  diamonds_today: 0,
  seconds_until_next: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  backend.awardState
    .mockReset()
    .mockResolvedValue({ enabled: false, award: null, gameState: null });
  backend.state.mockReset().mockResolvedValue(state);
  backend.start.mockReset().mockReturnValue(new Promise(() => {}));
  // The page checks every finished round by itself now, so the verifier always
  // answers unless a test deliberately holds its answer open.
  backend.verify.mockReset().mockResolvedValue({
    seal: true,
    draw: true,
    prizes: true,
    payout: true,
  });
  backend.rpc.mockResolvedValue({
    error: null,
    data: {
      ok: true,
      commit_id: '00000000-0000-0000-0000-000000000009',
      server_seed_hash: 'a'.repeat(64),
    },
  });
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('choice-game entry quotes belong to the selected settings', () => {
  it.each([
    { game: 'crossing' as const, status: 'lost', amount: 0 },
    { game: 'mines' as const, status: 'lost', amount: 0 },
    { game: 'crossing' as const, status: 'cashed', amount: 12.57 },
    { game: 'mines' as const, status: 'cashed', amount: 12.57 },
  ])(
    'shows the confirmed $game $status only after its reveal, then returns to wheel',
    async ({ game, status, amount }) => {
      const active = { ...fixtures.receipts[game], game, status: 'open', picked: [], proof: null };
      const finished = {
        ...fixtures.receipts[game],
        game,
        status,
        picked: [0],
        payout_chips: amount,
      };
      backend.state
        .mockResolvedValueOnce({ ...state, open_round: active })
        .mockResolvedValue({ ...state, history: [finished] });
      backend.act.mockResolvedValue(finished);
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      fireEvent.click(
        screen.getByRole('button', { name: game === 'mines' ? 'Pick Tile' : /^Cross Street/ })
      );
      await act(async () => {});
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
      const receipt = screen.getByRole('dialog', { name: `${amount.toFixed(2)} Chips` });
      expect(receipt).toHaveTextContent(
        amount ? 'Your Prize Is Booked.' : 'No Chips Won This Round.'
      );
      // The receipt stays until the player taps (R1); nothing leaves by itself.
      expect(backend.navigate).not.toHaveBeenCalled();
      fireEvent.animationEnd(receipt.querySelector('[data-motion="keep"]')!);
      fireEvent.click(within(receipt).getByRole('button', { name: 'Back To The Wheel' }));
      expect(backend.navigate).toHaveBeenCalledWith(
        '/clubs/00000000-0000-0000-0000-000000000003/wheel',
        { replace: true }
      );
    }
  );
  it('starts at the highway entrance instead of replaying a historical collision', async () => {
    backend.state.mockResolvedValue({
      ...state,
      history: [{ ...fixtures.receipts.crossing, status: 'lost', picked: [0] }],
    });
    render(<DiamondChoicePage game="crossing" />);
    await act(async () => {});
    expect(screen.getByRole('region', { name: 'Scene idle' })).toBeInTheDocument();
    expect(screen.queryByText(/Your Guaranteed/)).not.toBeInTheDocument();
    expect(screen.getByText('Current Prize').nextElementSibling).toHaveTextContent('0.00');
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each([
    { game: 'mines' as const, picked: [], current: '0.00', next: '2.17' },
    { game: 'mines' as const, picked: [2, 4], current: '5.33', next: '15.20' },
    { game: 'crossing' as const, picked: [], current: '0.00', next: '2.17' },
    { game: 'crossing' as const, picked: [0, 1], current: '5.33', next: '15.20' },
  ])(
    'shows current and next potential prizes for $game after $picked',
    async ({ game, picked, current, next }) => {
      backend.state.mockResolvedValue({
        ...state,
        // The active round owns these quotes. A refreshed lobby quote must not
        // replace either amount while the player decides whether to continue.
        prizes: [999, 999, 999],
        open_round: {
          ...fixtures.receipts.mines,
          game,
          mode: game === 'mines' ? '5' : 'steady',
          status: 'open',
          bet_diamonds: 100,
          max_steps: 3,
          picked,
          prizes: [2.17, 5.33, 15.2],
          proof: null,
        },
      });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.getByText('Current Prize').nextElementSibling).toHaveTextContent(current);
      expect(screen.getByText('Next Prize').nextElementSibling).toHaveTextContent(next);
      expect(screen.queryByText('999.00')).not.toBeInTheDocument();
    }
  );

  it('does not show a previous proof verdict while starting another round', async () => {
    const proof = deferred<Record<string, boolean>>();
    backend.verify.mockReturnValue(proof.promise);
    backend.state
      .mockResolvedValueOnce({
        ...state,
        open_round: { ...fixtures.receipts.mines, status: 'open', picked: [], proof: null },
      })
      .mockResolvedValue({ ...state, history: [fixtures.receipts.mines] });
    backend.act.mockResolvedValue(fixtures.receipts.mines);
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Pick Tile' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Verify Revealed Outcome' }));
    // Twice: the page checks a finished round by itself, and the player can
    // still press to run the same check again.
    expect(backend.verify).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      proof.resolve({ seal: true, draw: true, prizes: true, payout: true });
    });
    expect(
      screen.queryByText('The Revealed Outcome And Chip Prize Match The Sealed Round.')
    ).not.toBeInTheDocument();
  });
  it.each(['mines', 'crossing'] as const)(
    'offers no difficulty for %s: the one setting is quoted and sent, never chosen',
    async (game) => {
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.queryByRole('button', { name: /^Change / })).toBeNull();
      expect(screen.queryByText('Difficulty')).toBeNull();
      expect(screen.queryByText('Mines')).toBeNull();
      expect(backend.state).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000003',
        game,
        CHOICE_MODE[game],
        100
      );
      expect(backend.state.mock.calls.every((call) => call[2] === CHOICE_MODE[game])).toBe(true);
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
      expect(backend.start).toHaveBeenCalledTimes(1);
      expect(backend.start.mock.calls[0][0]).toMatchObject({
        game,
        mode: CHOICE_MODE[game],
        maxSteps: 12,
      });
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'describes the one %s setting in the rules instead of a choice',
    async (game) => {
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(
        screen.getByText(
          game === 'mines'
            ? /6 Mines Hide Among 25 Tiles\. .*A Mine Ends The Round And Pays The Guaranteed Minimum\./
            : /12 Streets Pay 0\.80x Up To 20\.00x\. .*Book The Win After Any Street\. A Hit Ends The Round And Pays The Guaranteed Minimum\./
        )
      ).toBeInTheDocument();
      expect(screen.getByText(/Nobody Picks A Difficulty/)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('Donkey Crossing');
      expect(document.body.textContent).not.toContain('Upgraded');
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'shows the standard half floor as the %s guarantee for ordinary play before Start',
    async (game) => {
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      // 100 diamonds at 100 per chip is a 1.00 chip stake, and ordinary play
      // pays for all of it, so contract 4 keeps HALF. It kept a tenth before.
      expect(screen.getByText('Guaranteed').nextElementSibling).toHaveTextContent('0.50 Chips');
      expect(screen.getByText('Guaranteed').nextElementSibling).not.toHaveAttribute(
        'data-ink',
        'gold'
      );
    }
  );
  it('reads Pending for the guarantee while the award is still being checked', async () => {
    backend.awardState.mockReturnValue(new Promise(() => {}));
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    expect(screen.getByText('Guaranteed').nextElementSibling).toHaveTextContent('Pending');
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
  });
  it('shows an open round its own sealed floor as the guarantee', async () => {
    backend.state.mockResolvedValue({
      ...state,
      open_round: {
        ...fixtures.receipts.mines,
        status: 'open',
        picked: [],
        payout_chips: 0,
        proof: null,
        payout_version: 2,
        minimum_payout_chips: 0.1,
      },
    });
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    expect(screen.getByText('Guaranteed').nextElementSibling).toHaveTextContent('0.10 Chips');
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('does not start a new amount using an earlier entry quote', async () => {
    const next = deferred<typeof state>();
    backend.state.mockImplementation((_club, _game, _mode, amount) =>
      amount === 200 ? next.promise : Promise.resolve(state)
    );
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '200' } });
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    expect(backend.start).not.toHaveBeenCalled();
    await act(async () => {
      next.resolve(state);
    });
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
  });
});

describe('choice games consume wheel-funded entry', () => {
  it.each(['mines', 'crossing'] as const)(
    'keeps the Super %s title when resuming its spent award',
    async (game) => {
      const saved = upgrades.records.find(
        (r) =>
          r.kind === 'start' &&
          r.game === game &&
          (r.value as Record<string, any>).bonus?.boost_multiplier === 2
      )!.value;
      backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
      backend.state.mockResolvedValue({ ...state, open_round: saved });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(
        screen.getByRole('heading', {
          name: game === 'mines' ? 'Super Diamond Mines' : 'Super Donkey Cross',
        })
      ).toBeInTheDocument();
      expect(backend.start).not.toHaveBeenCalled();
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'starts an awarded %s round with its reserved limits and no fresh base charge',
    async (game) => {
      const award = {
        id: '00000000-0000-0000-0000-000000000077',
        game,
        base_diamonds: 200,
        entry_diamonds: 100,
        boost_multiplier: 2,
        status: 'pending',
      };
      backend.state.mockResolvedValue({ ...state, diamonds: 0, max_steps: 0, prizes: [] });
      // The server's own statement: a Super award on a 2.00 chip stake keeps 1.00, the spin.
      const quote = {
        guarantee: 'super',
        minimumPayoutChips: 1,
        mode: CHOICE_MODE[game],
        plinkoTable: 4,
      };
      backend.awardState.mockResolvedValue({
        enabled: true,
        award,
        gameState: { ...state, diamonds: 0, max_steps: 3, prizes: [2.2, 2.7, 3.4] },
        quote,
      });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(
        screen.getByRole('heading', {
          name: game === 'mines' ? 'Super Diamond Mines' : 'Super Donkey Cross',
        })
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('Donkey Crossing');
      expect(document.body.textContent).not.toContain('Upgraded');
      // The guarantee is on the console before Start: the bay, in gold, and the sentence.
      const guaranteed = screen.getByText('Guaranteed').nextElementSibling!;
      expect(guaranteed).toHaveTextContent('1.00 Chips');
      expect(guaranteed).toHaveAttribute('data-ink', 'gold');
      const sentence =
        game === 'mines'
          ? 'Super Diamond Mines Pays At Least 1.00 Chips, Even If You Hit A Mine.'
          : 'Super Donkey Cross Pays At Least 1.00 Chips, Even If You Do Not Make It Across.';
      // The page says it in its one live region, not in a nested status.
      expect(
        Array.from(document.querySelectorAll('[aria-live] p')).some((line) =>
          line.textContent?.includes(sentence)
        )
      ).toBe(true);
      // Screen one (R9): the offer holds Start Round until it is answered by a tap.
      expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
      answerOffer();
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      expect(screen.queryByLabelText('Entry Diamonds')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
      expect(backend.start).toHaveBeenCalledWith(
        expect.objectContaining({
          game,
          mode: CHOICE_MODE[game],
          maxSteps: 3,
          budget: expect.objectContaining({
            base: 200,
            doubled: false,
            award: { id: award.id, entryDiamonds: 100, boostMultiplier: 2 },
          }),
        }),
        'player-a'
      );
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'quotes a standard %s award without the Super title and with its tenth',
    async (game) => {
      const award = {
        id: '00000000-0000-0000-0000-000000000078',
        game,
        base_diamonds: 100,
        entry_diamonds: 100,
        boost_multiplier: 1,
        status: 'pending',
      };
      backend.state.mockResolvedValue({ ...state, diamonds: 0, max_steps: 0, prizes: [] });
      backend.awardState.mockResolvedValue({
        enabled: true,
        award,
        gameState: { ...state, diamonds: 0, max_steps: 3, prizes: [1.1, 1.45, 1.85] },
        quote: {
          guarantee: 'standard',
          minimumPayoutChips: 0.1,
          mode: CHOICE_MODE[game],
          plinkoTable: 5,
        },
      });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(
        screen.getByRole('heading', { name: game === 'mines' ? 'Diamond Mines' : 'Donkey Cross' })
      ).toBeInTheDocument();
      const guaranteed = screen.getByText('Guaranteed').nextElementSibling!;
      expect(guaranteed).toHaveTextContent('0.10 Chips');
      expect(guaranteed).not.toHaveAttribute('data-ink', 'gold');
      expect(
        Array.from(document.querySelectorAll('[aria-live] p')).some((line) =>
          line.textContent?.includes('Pays At Least 0.10 Chips On Any Loss.')
        )
      ).toBe(true);
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'never starts a %s round by itself: two idle minutes on each entry screen start nothing (R1)',
    async (game) => {
      // Dan 2026-09-21, R1: "Games can NEVER auto start." Screen one is the
      // offer and screen two is the Start plate; neither moves on a clock.
      vi.useFakeTimers();
      backend.awardState.mockResolvedValue({
        enabled: true,
        award: {
          id: '00000000-0000-0000-0000-000000000077',
          game,
          base_diamonds: 200,
          entry_diamonds: 100,
          boost_multiplier: 2,
          status: 'pending',
        },
        gameState: { ...state, diamonds: 10000, max_steps: 3, prizes: [2.2, 2.7, 3.4] },
        quote: {
          guarantee: 'super',
          minimumPayoutChips: 1,
          mode: CHOICE_MODE[game],
          plinkoTable: 4,
        },
      });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
      expect(backend.start).not.toHaveBeenCalled();
      expect(backend.navigate).not.toHaveBeenCalled();
      answerOffer();
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(backend.start).not.toHaveBeenCalled();
      expect(backend.navigate).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'refuses a direct new %s round when no award exists',
    async (game) => {
      backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Spin The Wheel' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Buy More' })).toBeEnabled();
      expect(backend.start).not.toHaveBeenCalled();
    }
  );
  it('keeps an older Crossing round playable without a new wheel award', async () => {
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    backend.state.mockResolvedValue({
      ...state,
      diamonds: 0,
      open_round: {
        ...fixtures.receipts.crossing,
        status: 'open',
        picked: [],
        payout_chips: 0,
        proof: null,
      },
    });
    render(<DiamondChoicePage game="crossing" />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: /^Cross Street/ })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
    // The saved round keeps its own road ('steady'); the lobby is still quoted the one setting.
    expect(backend.state.mock.calls.every((call) => call[2] === CHOICE_MODE.crossing)).toBe(true);
    expect(screen.getByRole('heading', { name: 'Donkey Cross' })).toBeInTheDocument();
  });
});
