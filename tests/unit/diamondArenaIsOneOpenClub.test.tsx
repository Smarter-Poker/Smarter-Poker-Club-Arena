/**
 * Dan 2026-09-11, verbatim: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB
 * ARENA. (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS
 * AND ITS PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".
 *
 * Two halves of that sentence are pinned here, because each has its own way of
 * quietly coming back.
 *
 * ONE OPEN CLUB. Diamond membership is a platform entitlement with no
 * `club_members` row. Every chip-club guard reads that table, so each one
 * would deny a Diamond player their own arena and send them to a Join page
 * that must never exist for it. The guard has to ask the arena, and the only
 * honest source is the boundary's server-verified context.
 *
 * PLAYED WITH DIAMONDS. Every club wallet row the lobby can draw is a chip
 * ledger. A "Player Wallet 0.00" beside the Diamonds row is a chip balance on
 * a Diamond screen, which the money contract forbids outright.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ArenaAccessContext } from '../../server/src/domain/ArenaContext';

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), navigate: vi.fn() }));

vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: mocks.workspace,
}));
vi.mock('../../src/components/auth/ClubCapabilityGuard', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('../../src/components/arena/ArenaAccessBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import ClubMemberGuard from '../../src/components/auth/ClubMemberGuard';
import { ArenaAccessProvider } from '../../src/components/arena/arenaAccess';
import { clubLobbyWalletRows, clubWalletRows } from '../../src/components/wallet/walletRows';

const diamond: ArenaAccessContext = {
  arena: { id: 'diamond', kind: 'diamond_arena', asset: 'diamonds' },
  member: true,
  automaticMembership: true,
  role: 'player',
  capabilities: { join: false, hierarchy: false, chipWallet: false, diamondTransfers: true },
};
const chip: ArenaAccessContext = {
  arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
  member: true,
  automaticMembership: false,
  role: 'player',
  capabilities: { join: true, hierarchy: true, chipWallet: true, diamondTransfers: false },
};

const DENIED = {
  status: 'denied',
  isMember: false,
  error: null,
  reload: () => undefined,
};

/* A real route, because the guard reads its club from useParams: rendered
   loose under MemoryRouter there is no club id at all, and the guard's own
   "no club, nothing to gate" path would pass every assertion below without
   exercising a single check. */
function guarded(value: ArenaAccessContext | null) {
  return render(
    <MemoryRouter initialEntries={['/clubs/diamond']}>
      <ArenaAccessProvider value={value}>
        <Routes>
          <Route
            path="/clubs/:clubId"
            element={
              <ClubMemberGuard>
                <div>Shared Club Lobby</div>
              </ClubMemberGuard>
            }
          />
        </Routes>
      </ArenaAccessProvider>
    </MemoryRouter>
  );
}

describe('One open club: the chip membership guard never evicts a Diamond player', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspace.mockReturnValue(DENIED);
  });

  /* The guard loads the boundary lazily, so every assertion waits for the
     suspense boundary to resolve. A synchronous queryByText here would read
     the fallback and pass while proving nothing. */
  it('admits an entitlement member the club_members table does not know', async () => {
    guarded(diamond);
    expect(await screen.findByText('Shared Club Lobby')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('still evicts an unjoined chip club viewer to the join page', async () => {
    guarded(chip);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/invite/diamond', { replace: true })
    );
    expect(screen.queryByText('Shared Club Lobby')).toBeNull();
  });

  it('still evicts when no arena context is published at all', async () => {
    guarded(null);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/invite/diamond', { replace: true })
    );
    expect(screen.queryByText('Shared Club Lobby')).toBeNull();
  });
});

describe('Played with diamonds: no chip ledger row belongs on a Diamond surface', () => {
  it('withholds every club wallet row when the arena holds no chip wallet', () => {
    expect(clubLobbyWalletRows('player', { chipWallet: false })).toEqual([]);
    expect(clubLobbyWalletRows('owner', { chipWallet: false })).toEqual([]);
    expect(clubWalletRows('owner', { chipWallet: false, standalone: true })).toEqual([]);
    expect(clubWalletRows('super_agent', { chipWallet: false })).toEqual([]);
  });

  it('leaves every chip club row exactly as it was', () => {
    expect(clubLobbyWalletRows('player')).toEqual(['player_wallet']);
    expect(clubLobbyWalletRows('player', { chipWallet: true })).toEqual(['player_wallet']);
    expect(clubWalletRows('owner', { standalone: true })).toEqual(
      clubWalletRows('owner', { standalone: true, chipWallet: true })
    );
  });
});
