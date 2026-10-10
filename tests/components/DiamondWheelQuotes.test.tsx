vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  refresh: vi.fn(),
  spinV2: vi.fn(),
  spin: vi.fn(),
  runBegin: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', async (importOriginal) => ({
  // The page reads the service's named exports (the unverified-receipt error).
  ...(await importOriginal<typeof import('../../src/services/DiamondWheelService')>()),
  default: {
    getStateV2: backend.state,
    spinV2: backend.spinV2,
    spin: backend.spin,
    runBegin: backend.runBegin,
    welcomeState: async () => ({ available: false, enabled: false }),
    dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
    commit: async () => ({
      ok: true,
      commit_id: 'd1000000-0000-4000-8000-000000000001',
      server_seed_hash: 'a'.repeat(64),
    }),
    history: async () => [],
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: 'club-a' }),
  useNavigate: () => backend.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: backend.refresh }),
}));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/WheelExperience', () => ({
  wheelPrizeTitle: () => '',
  WheelExperience: ({ size }: { size: number }) => <output aria-label="Wheel Width">{size}</output>,
}));
vi.mock('../../src/components/console/SpadeConsole', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/console/SpadeConsole')>()),
  PlateButton: ({ label, disabled, onClick }: any) => (
    <button disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
  SpadeConsole: ({ children, plates }: any) => (
    <section>
      {children}
      {plates && (
        <>
          <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
            {plates.primary.label}
          </button>
          <button disabled={plates.secondary.disabled} onClick={plates.secondary.onClick}>
            {plates.secondary.label}
          </button>
        </>
      )}
    </section>
  ),
}));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const state = {
  ok: true,
  contract_version: 4,
  available: true,
  frozen: false,
  segments: [],
  pending_awards: [],
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
};
describe('the selected wheel stake owns its availability quote', () => {
  it.each([2, 3, 4])(
    'quotes and submits a custom amount through contract %s, preserving one single-spin action',
    async (version) => {
      backend.state.mockImplementation((_club: string, amount: number) =>
        Promise.resolve({
          ...state,
          contract_version: version,
          config: { ...state.config, spin_price_diamonds: amount },
        })
      );
      backend.spinV2.mockReturnValue(new Promise(() => {}));
      render(<DiamondWheelPage />);
      const entry = await screen.findByLabelText('Diamonds To Spin');
      fireEvent.change(entry, { target: { value: '375' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Spin 375', exact: true })).toBeEnabled()
      );
      expect(backend.state).toHaveBeenLastCalledWith('club-a', 375);
      fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
      expect(screen.getByRole('button', { name: 'Auto Spin 5' })).toBeEnabled();
      const spin = screen.getByRole('button', { name: 'Spin 375', exact: true });
      fireEvent.click(spin);
      fireEvent.click(spin);
      await waitFor(() => expect(backend.spinV2).toHaveBeenCalledOnce());
      expect(backend.spinV2).toHaveBeenCalledWith(
        expect.objectContaining({ entryDiamonds: 375, contractVersion: version, mode: 'paid' })
      );
      expect(backend.spin).not.toHaveBeenCalled();
      expect(backend.runBegin).not.toHaveBeenCalled();
      expect(
        JSON.parse(localStorage.getItem('diamond-wheel-pending:v1:player-a:club-a')!)
      ).toMatchObject({ entryDiamonds: 375, contractVersion: version });
    }
  );

  it('shows a version 4 server refusal and lets a lower funded amount reopen play', async () => {
    backend.state.mockImplementation((_club: string, amount: number) =>
      Promise.resolve({
        ...state,
        available: amount === 25,
        reason: amount === 25 ? null : 'The Host Must Fund Every Bonus Before A Spin',
        config: { ...state.config, spin_price_diamonds: amount },
      })
    );
    render(<DiamondWheelPage />);
    expect(await screen.findByText('The Host Must Fund Every Bonus Before A Spin')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '25', exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 25', exact: true })).toBeEnabled()
    );
  });

  it('measures the stage when loading finishes and follows later viewport changes', async () => {
    let width = 1248;
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    let finish!: (value: typeof state) => void;
    backend.state.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = render(<DiamondWheelPage />);
    await waitFor(() => expect(backend.state).toHaveBeenCalled());
    expect(screen.queryByLabelText('Wheel Width')).not.toBeInTheDocument();
    await act(async () => finish(state));
    expect(await screen.findByLabelText('Wheel Width')).toHaveTextContent('1248');
    const controls = screen.getByRole('complementary', { name: 'Diamond Spins Controls' });
    expect(within(controls).getByRole('navigation', { name: 'Spin Entry' })).toBeInTheDocument();
    expect(within(controls).getByLabelText('Diamonds To Spin')).toBeInTheDocument();
    act(() => {
      width = 288;
      resize();
    });
    expect(screen.getByLabelText('Wheel Width')).toHaveTextContent('288');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  /* Owner ruling 2026-09-21, R1: an unfinished award used to open its game page
     by itself on load. It now waits in a visible card until Play Game is tapped,
     and the tap opens the declared game route without a new spin. */
  it.each(['plinko', 'crash', 'crossing', 'mines'])(
    'holds an existing %s award in a Play Game card and opens its declared route only on the tap',
    async (game) => {
      backend.state.mockResolvedValue({
        ...state,
        pending_awards: [
          {
            id: 'earned/award?1',
            game,
            base_diamonds: 100,
            boost_multiplier: 1,
            entry_diamonds: 100,
          },
        ],
      });
      render(<DiamondWheelPage />);
      const play = await screen.findByRole('button', { name: 'Play Game' });
      expect(screen.getByText('You Have A Bonus Game To Play')).toBeInTheDocument();
      expect(screen.getByText('Play Your Bonus Game Before Another Spin')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeDisabled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(backend.navigate).not.toHaveBeenCalled();
      fireEvent.click(play);
      expect(backend.navigate).toHaveBeenCalledWith(
        `/clubs/club-a/${game}?wheelAward=earned%2Faward%3F1`
      );
      expect(screen.queryByText('Your Ready Bonus Games')).not.toBeInTheDocument();
    }
  );

  it('offers the funded new welcome wheel when the historical table is unavailable', async () => {
    backend.state.mockResolvedValue({
      ...state,
      welcome: { available: true, entry_diamonds: 100 },
    });
    render(<DiamondWheelPage />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Welcome Spin', exact: true })).toHaveLength(2)
    );
    for (const button of screen.getAllByRole('button', { name: 'Welcome Spin', exact: true }))
      expect(button).toBeEnabled();
    expect(screen.queryByText('Your Welcome Spin Is Unavailable')).not.toBeInTheDocument();
  });
  it('restores the100quote immediately and ignores a late200refusal', async () => {
    let finish!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      finish = resolve;
    });
    backend.state.mockImplementation((_club: string, entry: number) =>
      entry === 200 ? delayed : Promise.resolve(state)
    );
    render(<DiamondWheelPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Diamonds To Spin'), { target: { value: '200' } });
    await waitFor(() => expect(backend.state).toHaveBeenCalledWith('club-a', 200));
    expect(screen.getByRole('button', { name: 'Spin 200', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Diamonds To Spin'), { target: { value: '100' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
    );
    await act(async () => {
      finish({ ...state, available: false });
      await delayed;
    });
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
    expect(screen.queryByText('The Diamond Wheel Is Paused')).not.toBeInTheDocument();
  });
});
