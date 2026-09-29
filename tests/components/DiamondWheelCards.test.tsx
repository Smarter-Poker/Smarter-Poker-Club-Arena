vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/diamond-spins/wheel-v4-postgres-receipts.json';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  pick: vi.fn(),
  runEnd: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', async (importOriginal) => ({
  // The saved-pick store and the refusal copy are the service's own named
  // exports, and the page uses the real ones: only the doors are mocked.
  ...(await importOriginal<typeof import('../../src/services/DiamondWheelService')>()),
  default: {
    getStateV2: backend.state,
    commit: backend.commit,
    spin: backend.spin,
    pickCard: backend.pick,
    runEnd: backend.runEnd,
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
  useGameFloor: () => ({ floor: null, refresh: backend.refresh }),
}));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({ onLanded, spinning }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      Land Wheel
    </button>
  ),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';
import { CARD_NOT_PICKED } from '../../src/services/DiamondWheelService';

type Entry = { kind: string; value: unknown };
const records = fixture.records as unknown as Entry[];
const by = (kind: string) =>
  JSON.parse(JSON.stringify(records.find((r) => r.kind === kind)!.value));
const cardsSpin = by('wheel-v4-cards');
const cardPick = by('wheel-v4-card-pick');
const AWARD: string = cardPick.award_id;
const CLUB = 'd1000000-0000-4000-8000-000000000003';

/** The pending award exactly as fn_wheel_card_public publishes it. */
const pendingCard = {
  award_id: AWARD,
  risk_diamonds: 100,
  status: 'pending' as const,
  spin_id: cardsSpin.spin_id,
  created_at: '2026-09-22T20:59:25.392995+00:00',
};

const stateWith = (cards: Array<typeof pendingCard>) => ({
  ok: true,
  contract_version: 4 as const,
  available: true,
  frozen: false,
  segments: cardsSpin.segments,
  upgrade_segments: [],
  pending_awards: [],
  pending_cards: cards,
  auto_run: null,
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200, diamonds_per_chip: 100 },
  player: {
    diamonds: 89900,
    spendable: 89900,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
});

let ticket = 0;
const nextTicket = () => ({
  ok: true,
  commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
  server_seed_hash: 'a'.repeat(64),
});

/** The Postgres receipt, resealed to the ticket this attempt actually carried. */
const receiptFor = (attempt: { commitId: string; commitHash: string; clientSeed: string }) => ({
  ...cardsSpin,
  club_id: CLUB,
  fairness: {
    ...cardsSpin.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  },
});

beforeEach(() => {
  ticket = 0;
  backend.state.mockImplementation(async () => stateWith([]));
  backend.commit.mockImplementation(async () => nextTicket());
  backend.spin.mockImplementation(async (clubId: string, commitId: string, clientSeed: string) =>
    receiptFor({ commitId, commitHash: 'a'.repeat(64), clientSeed })
  );
  backend.pick.mockImplementation(async () => ({ ok: true, pick: cardPick }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

const ready = async () => {
  render(<DiamondWheelPage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
  );
};

/** Land the wheel, then press the reveal's own plate. Nothing advances alone. */
const landAndOpen = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
  });
  await act(async () =>
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!)
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pick Your Card' }));
  });
};

const table = () => screen.getByRole('dialog', { name: /Pick A Card|Your Diamond Card/ });

describe('the three cards a Diamonds spin deals', () => {
  it('opens face down after the spin, and the card the player picks is the one the server pays', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await waitFor(() => expect(backend.spin).toHaveBeenCalledTimes(1));
    await landAndOpen();
    const open = table();
    // Three real controls, face down, named for a screen reader.
    expect(within(open).getByRole('button', { name: 'Pick Card One' })).toBeEnabled();
    expect(within(open).getByRole('button', { name: 'Pick Card Two' })).toBeEnabled();
    expect(within(open).getByRole('button', { name: 'Pick Card Three' })).toBeEnabled();
    expect(
      within(open).getByText(
        'Your 100 Diamond Entry Is On The Table. One Card Pays Half, One Pays Double, One Pays Triple.'
      )
    ).toBeInTheDocument();
    expect(backend.pick).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(open).getByRole('button', { name: 'Pick Card Two' }));
    });
    expect(backend.pick).toHaveBeenCalledWith(AWARD, 2);
    const revealed = table();
    expect(
      within(revealed).getByRole('button', { name: 'Card Two, 300 Diamonds, Your Card' })
    ).toBeDisabled();
    expect(within(revealed).getByRole('button', { name: 'Card One, 50 Diamonds' })).toBeDisabled();
    expect(
      within(revealed).getByRole('button', { name: 'Card Three, 200 Diamonds' })
    ).toBeDisabled();
  });

  it('announces the outcome once, and leaves focus on a control that is still there', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await waitFor(() => expect(backend.spin).toHaveBeenCalledTimes(1));
    await landAndOpen();
    const open = table();
    // One live region on the table, and the first card holds focus.
    const live = within(open).getAllByRole('status');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent(
      'Three Cards, Face Down. One Pays Half, One Pays 200 And One Pays 300 Diamonds.'
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(open).getByRole('button', { name: 'Pick Card One' })
      )
    );

    await act(async () => {
      fireEvent.click(within(open).getByRole('button', { name: 'Pick Card Two' }));
    });
    const revealed = table();
    expect(within(revealed).getAllByRole('status')).toHaveLength(1);
    expect(within(revealed).getAllByRole('status')[0]).toHaveTextContent(
      'You Picked Card Two And Won 300 Diamonds.'
    );
    // Focus moved onto the plate that replaced the cards, never into nothing.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(revealed).getByRole('button', { name: 'Continue' })
      )
    );
  });

  it('shows that the three values were sealed before the player chose', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await waitFor(() => expect(backend.spin).toHaveBeenCalledTimes(1));
    await landAndOpen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pick Card Two' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check These Cards' }));
    // Real WebCrypto: wait for the verdict rather than counting turns.
    await waitFor(() => expect(backend.toast.success).toHaveBeenCalledWith('These Cards Verify'));
    expect(
      screen.getByText('Verified: The Three Values And Your Card Were Sealed Before You Chose')
    ).toBeInTheDocument();
    expect(screen.getByText(cardPick.fairness.server_seed)).toBeInTheDocument();
  });
});

describe('a card game the server is still holding', () => {
  it('opens on load without a spin, and holds the wheel in the words the server itself uses', async () => {
    backend.state.mockImplementation(async () => stateWith([pendingCard]));
    render(<DiamondWheelPage />);
    await waitFor(() => expect(table()).toBeInTheDocument());
    expect(within(table()).getByRole('button', { name: 'Pick Card One' })).toBeEnabled();
    expect(screen.getByText('Pick Your Diamond Card Before Another Spin')).toBeInTheDocument();
    expect(backend.spin).not.toHaveBeenCalled();
  });

  it('sends a pick whose answer never arrived again, as the same pick and no other', async () => {
    backend.state.mockImplementation(async () => stateWith([pendingCard]));
    backend.pick.mockRejectedValueOnce(new Error('the answer was lost'));
    /* Every clock is fake from the first render: the resend is measured on the
       page's own backoff, never slept through on a real one. */
    vi.useFakeTimers();
    render(<DiamondWheelPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(within(table()).getByRole('button', { name: 'Pick Card Three' }));
    });
    expect(backend.pick).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(backend.pick.mock.calls).toEqual([
      [AWARD, 3],
      [AWARD, 3],
    ]);
  });

  it('is picked up on the next load from the pick this browser saved, not from a fresh choice', async () => {
    backend.state.mockImplementation(async () => stateWith([pendingCard]));
    backend.pick.mockRejectedValue(new Error('the answer was lost'));
    const { unmount } = render(<DiamondWheelPage />);
    await waitFor(() => expect(table()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(within(table()).getByRole('button', { name: 'Pick Card One' }));
    });
    expect(backend.pick).toHaveBeenCalledTimes(1);
    unmount();
    backend.pick.mockReset();
    backend.pick.mockResolvedValue({ ok: true, pick: cardPick });
    render(<DiamondWheelPage />);
    await waitFor(() => expect(backend.pick).toHaveBeenCalledWith(AWARD, 1));
    // The saved slot is cleared once the reveal lands, so a third visit is quiet.
    await waitFor(() =>
      expect(localStorage.getItem(`diamond-wheel-card:v1:player:${CLUB}`)).toBeNull()
    );
  });

  it('never puts a database refusal in front of the player', async () => {
    backend.state.mockImplementation(async () => stateWith([pendingCard]));
    backend.pick.mockResolvedValue({
      ok: false,
      error: 'That Card Game Belongs To Another Player',
    });
    render(<DiamondWheelPage />);
    await waitFor(() => expect(table()).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(within(table()).getByRole('button', { name: 'Pick Card Two' }));
    });
    expect(backend.toast.error).toHaveBeenCalledWith(CARD_NOT_PICKED);
    expect(backend.toast.error).not.toHaveBeenCalledWith(
      'That Card Game Belongs To Another Player'
    );
    expect(localStorage.getItem(`diamond-wheel-card:v1:player:${CLUB}`)).toBeNull();
  });
});
