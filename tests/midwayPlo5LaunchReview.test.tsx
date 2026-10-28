import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  wake: vi.fn(),
  navigate: vi.fn(),
  emit: vi.fn(),
  user: { id: 'operator' },
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../src/stores/useUserStore', () => ({
  useUserStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ user: mocks.user }),
    { getState: () => ({ user: mocks.user }) }
  ),
}));
vi.mock('../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));
vi.mock('../src/services/MidwayPlo5LaunchService', () => ({
  launchMidwayPlo5: mocks.launch,
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../src/components/cash/CashGameCreateFlow', () => ({
  wakeTableEngine: mocks.wake,
  GAME_CREATED_MEMBERS_ONLY: 'Game Created. Only Club Members Can Watch This Table',
  GAME_CREATED_SEATED_ONLY: 'Game Created. Only Seated Players Can Watch This Table',
  GAME_CREATED_STILL_STARTING: 'Game Created. The Table Is Still Starting',
}));
import MidwayPlo5Launch from '../src/components/cash/MidwayPlo5Launch';
import {
  MIDWAY_PLO5_CLUB_ID,
  MIDWAY_PLO5_LAUNCH_ID,
  MIDWAY_PLO5_LINEUP,
} from '../src/config/midwayPlo5Launch';

describe('the approved launch is an explicit reviewed operator action', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.launch.mockResolvedValue({
      gameId: 'game',
      tableId: 'table',
      replayed: false,
    });
    mocks.wake.mockResolvedValue({ status: 'awake', state: {} });
  });

  it('prints the exact lineup and starts only after the operator clicks, then awaits the normal wake', async () => {
    render(
      <MidwayPlo5Launch
        clubId={MIDWAY_PLO5_CLUB_ID}
        launchId={MIDWAY_PLO5_LAUNCH_ID}
        canBuildHere
      />
    );
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '2/5 PLO5 Madness' })).toBeTruthy();
    expect(screen.getByText(/Four Selected Players To Start/)).toBeTruthy();
    expect(screen.getByText(/Humans May Join Normally/)).toBeTruthy();
    for (const player of MIDWAY_PLO5_LINEUP)
      expect(screen.getByText(new RegExp(player.name))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.wake).toHaveBeenCalledWith('table'));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/table/table'));
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly unavailable message when the guarded creator is not installed', async () => {
    mocks.launch.mockRejectedValue({
      code: 'PGRST202',
      message: 'Could Not Find fn_cash_game_create_horse_arrivals',
    });
    render(
      <MidwayPlo5Launch
        clubId={MIDWAY_PLO5_CLUB_ID}
        launchId={MIDWAY_PLO5_LAUNCH_ID}
        canBuildHere
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('The Approved Launch Is Not Available Yet')
    );
    expect(screen.getByRole('status').textContent).not.toContain('fn_cash_game_create');
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it.each([
    { launchId: 'unknown', clubId: MIDWAY_PLO5_CLUB_ID, canBuildHere: true },
    {
      launchId: MIDWAY_PLO5_LAUNCH_ID,
      clubId: 'wrong-club',
      canBuildHere: true,
    },
    {
      launchId: MIDWAY_PLO5_LAUNCH_ID,
      clubId: MIDWAY_PLO5_CLUB_ID,
      canBuildHere: false,
    },
  ])('refuses an invalid, wrong-club, or unauthorized request without falling back', (props) => {
    render(<MidwayPlo5Launch {...props} />);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
