import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubWelcomePackage from '../../src/components/club/ClubWelcomePackage';
import type {
  ClubWelcomePackageResetImpact,
  ClubWelcomePackageState,
} from '../../src/services/ClubWelcomePackageService';

const backend = vi.hoisted(() => ({
  get: vi.fn(),
  getResetImpact: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../src/services/ClubWelcomePackageService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/ClubWelcomePackageService')>();
  return { ...actual, clubWelcomePackageService: backend };
});

vi.mock('../../src/components/games/DiamondSpinsOwnerTerms', () => ({
  default: () => <div>Diamond Agreement Control</div>,
}));

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const GAME_ID = '22222222-2222-4222-8222-222222222222';
const TABLE_ID = '33333333-3333-4333-8333-333333333333';
const SCHEDULE_ID = '44444444-4444-4444-8444-444444444444';

const packageState = (
  overrides: Partial<ClubWelcomePackageState> = {}
): ClubWelcomePackageState => ({
  clubId: CLUB_ID,
  eligible: true,
  status: 'provisioned',
  ownerAcceptanceRequired: true,
  displayTimeZone: 'UTC',
  displayTimeLabel: '7:00 PM UTC',
  items: [
    {
      slotKey: 'classic_nlh_050_100',
      entityKind: 'cash_game',
      entityId: GAME_ID,
      initialTableId: TABLE_ID,
      retiredAt: null,
    },
    {
      slotKey: 'daily_25_freezeout_1900',
      entityKind: 'tournament_schedule',
      entityId: SCHEDULE_ID,
      initialTableId: null,
      retiredAt: null,
    },
  ],
  economics: {
    bbjEnabled: true,
    bbjSeed: 0,
    spinsEnabled: true,
    spinMaxStake: 0,
    spinSeed: 0,
    leaderboardMode: 'display_only',
    leaderboardSeed: 0,
    promoEnabled: false,
    diamondSpinsStatus: 'owner_acceptance_required',
  },
  ...overrides,
});

const safeImpact = (
  overrides: Partial<ClubWelcomePackageResetImpact> = {}
): ClubWelcomePackageResetImpact => ({
  clubId: CLUB_ID,
  authorized: true,
  canReset: true,
  cashGameIds: [GAME_ID],
  tournamentIds: [SCHEDULE_ID],
  blocking: {
    activeSeats: 0,
    openSessions: 0,
    waitingPlayers: 0,
    pendingMoves: 0,
    registeredPlayers: 0,
    runningTournaments: 0,
    executingCommands: 0,
    handHistory: 0,
    resourceActivity: 0,
    economicsPristine: true,
  },
  removable: {
    cashGames: 1,
    tournaments: 1,
    tables: 1,
    schedules: 1,
    bbjSeed: 100,
    spinSeed: 200,
  },
  ...overrides,
});

describe('ClubWelcomePackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.get.mockResolvedValue(packageState());
    backend.getResetImpact.mockResolvedValue(safeImpact());
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('prints only the server-confirmed package state and requires owner acceptance for Diamond Spins', async () => {
    backend.get.mockResolvedValue(
      packageState({
        economics: {
          ...packageState().economics!,
          bbjEnabled: false,
          spinsEnabled: false,
        },
      })
    );

    render(<ClubWelcomePackage clubId={CLUB_ID} clubName="Shark Club" />);

    expect(await screen.findByText('Opening Welcome Package')).toBeInTheDocument();
    expect(screen.getAllByText('Not Enabled')).toHaveLength(2);
    expect(screen.getByText('Owner Acceptance Required')).toBeInTheDocument();
    expect(screen.queryByText('Diamond Spins Enabled')).not.toBeInTheDocument();
    expect(screen.getByText('1 Preloaded')).toBeInTheDocument();
    expect(screen.getByText('Daily 25 Chip Freezeout · 7 PM UTC')).toBeInTheDocument();
  });

  it('is mounted for owners independently of the completed checklist', () => {
    const page = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
    expect(page).toContain('onStateChange={setWelcomePackageState}');
    expect(page.indexOf('<ClubWelcomePackage')).toBeLessThan(
      page.indexOf('{showLaunchChecklist && (')
    );
  });

  it('fails closed when the impact reports an active seat', async () => {
    const user = userEvent.setup();
    backend.getResetImpact.mockResolvedValue(
      safeImpact({ blocking: { ...safeImpact().blocking, activeSeats: 1 } })
    );

    render(<ClubWelcomePackage clubId={CLUB_ID} clubName="Shark Club" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove All Preloaded Games And Start From Zero',
      })
    );

    expect(await screen.findByText('1 Active Seats')).toBeInTheDocument();
    expect(
      screen.getByText(/Exactly 100 Unused BBJ Chips And 200 Unused Spin Chips Return/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/No Chips Are Created Or Destroyed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Any Play, Registration, Hand, Contribution, Payout/i)
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Type Shark Club To Confirm/i), 'Shark Club');
    expect(screen.getByRole('button', { name: 'Start From Zero' })).toBeDisabled();
    expect(backend.remove).not.toHaveBeenCalled();
  });

  it('requires the displayed club name and reuses one operation id across an unknown outcome', async () => {
    const user = userEvent.setup();
    backend.remove.mockRejectedValueOnce(new Error('Connection Lost')).mockResolvedValueOnce({
      replayed: true,
      clubId: CLUB_ID,
      operationId: 'captured-by-assertion',
      removed: {
        cashGameIds: [GAME_ID],
        tournamentIds: [SCHEDULE_ID],
        tableIds: [TABLE_ID],
        scheduleIds: [SCHEDULE_ID],
      },
      returnedToTreasury: { bbj: 100, spin: 200 },
      ownerAcceptanceReceiptsPreserved: true,
      completedAt: '2026-10-01T12:00:00Z',
    });

    render(<ClubWelcomePackage clubId={CLUB_ID} clubName="Shark Club" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove All Preloaded Games And Start From Zero',
      })
    );
    const input = await screen.findByLabelText(/Type Shark Club To Confirm/i);
    await waitFor(() => expect(input).toHaveFocus());
    const submit = screen.getByRole('button', { name: 'Start From Zero' });
    expect(submit).toBeDisabled();
    await user.type(input, 'Shark Club');
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(
      await screen.findByText('Removal Could Not Be Confirmed. Use The Same Action To Check Again')
    ).toBeInTheDocument();
    const firstOperationId = backend.remove.mock.calls[0][1] as string;
    expect(firstOperationId).toMatch(/^[0-9a-f-]{36}$/i);

    await user.click(submit);
    await waitFor(() => expect(backend.remove).toHaveBeenCalledTimes(2));
    expect(backend.remove.mock.calls[1][1]).toBe(firstOperationId);
    expect(await screen.findByText('Preloaded Games Removed')).toBeInTheDocument();
  });
});
