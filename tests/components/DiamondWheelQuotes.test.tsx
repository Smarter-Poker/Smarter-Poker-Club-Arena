import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: {
    getStateV2: backend.state,
    welcomeState: async () => ({ available: false, enabled: false }),
    dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
    commit: async () => ({ ok: true, commit_id: 'commit', server_seed_hash: 'hash' }),
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
  WheelExperience: () => null,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
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
  localStorage.clear();
});
const state = {
  ok: true,
  contract_version: 2,
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
  it.each(['plinko', 'crash', 'crossing', 'mines'])(
    'opens an existing %s award on its declared game route without a new spin',
    async (game) => {
      backend.state.mockResolvedValue({
        ...state,
        pending_awards: [{ id: 'earned/award?1', game, base_diamonds: 100 }],
      });
      render(<DiamondWheelPage />);
      const open = await screen.findByRole('button', { name: 'Open', exact: true });
      fireEvent.click(open);
      expect(backend.navigate).toHaveBeenCalledWith(
        `/clubs/club-a/${game}?wheelAward=earned%2Faward%3F1`
      );
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
