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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';
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

describe('One open club: the lobby never reads a membership row the arena has no row in', () => {
  const page = readFileSync(join(__dirname, '..', '..', 'src/pages/ClubHomePage.tsx'), 'utf8');

  /* Refusing to ACT on the read was not enough. The fast path's read also
     dereferenced `home.club.id`, and the fast-path payload carries no club row
     for the arena, so every arena load threw inside the try and lost the fast
     path with it: seen live on 2026-09-11 as
     `[ClubHomePage.fastPath] Cannot read properties of undefined (reading
     'id')`. Both reads are skipped outright now, which is also two fewer round
     trips on every refocus. */
  it('skips the fast path membership read before it dereferences the club', () => {
    const guard = page.indexOf('if (automaticMembershipRef.current) {');
    const read = page.indexOf("eq('club_id', home.club.id)");
    expect(guard, 'the fast path no longer guards on the arena').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(guard);
  });

  it('skips the authoritative membership read for an automatic-membership arena', () => {
    expect(page).toMatch(
      /const memberResult = automaticMembershipRef\.current\s*\?\s*\{ data: null, error: null \}/
    );
  });
});

describe('One open club: the arena asks no chip-only feed a question it cannot answer', () => {
  const page = readFileSync(join(__dirname, '..', '..', 'src/pages/ClubHomePage.tsx'), 'utf8');

  /* Both were found on the live arena lobby after CI was green: a realtime
     channel on `club_members`, which the arena has no rows in, failing on
     every load, and the jackpot feeds timing out against a pool that does not
     exist there. Hiding the strip was not enough; the queries behind it also
     had to stop. */
  it('does not subscribe to club_members realtime in the arena', () => {
    /* The whole useMasterBusChannel statement, bound by its own structure:
       a window of N bytes would stop covering the `enabled` line the moment a
       comment grew above it, and would do so silently. */
    const subscription = sliceStatement(page, "table: 'club_members'");
    expect(subscription).toContain('enabled: !!resolvedClubId && !isAutomaticArena');
  });

  /* The third jackpot read hid inside a Promise.all rather than beside the
     two named feeds, which is how it survived the first pass. */
  it('does not read the jackpot pool row in the arena', () => {
    const query = sliceStatement(page, "supabase.from('bbj_pools')");
    expect(query).toBeTruthy();
    const guard = page.indexOf(
      'if (automaticMembershipRef.current) return { data: null, error: null };'
    );
    const read = page.indexOf("supabase.from('bbj_pools')");
    expect(guard, 'the jackpot pool read lost its arena guard').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(guard);
  });

  it('does not start the jackpot feeds in the arena', () => {
    const guard = page.indexOf('if (!automaticMembershipRef.current) {\n        stopBbjPool');
    const pool = page.indexOf('watchBbjPool(resolvedId');
    const mini = page.indexOf('watchBbjMini(resolvedId');
    expect(guard, 'the jackpot feeds are no longer behind the arena guard').toBeGreaterThan(-1);
    expect(pool).toBeGreaterThan(guard);
    expect(mini).toBeGreaterThan(guard);
  });
});

describe('Played with diamonds: the chip jackpot strip stays off the arena lobby', () => {
  const page = readFileSync(join(__dirname, '..', '..', 'src/pages/ClubHomePage.tsx'), 'utf8');

  it('wraps the Bad Beat Jackpot strip in the arena check', () => {
    const wrapper = page.indexOf('{!isAutomaticArena && (');
    const strip = page.indexOf('className="lobby-bbj"');
    expect(wrapper, 'the arena check is gone from the lobby').toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(wrapper);
    expect(strip - wrapper).toBeLessThan(200);
  });

  /* A bare block comment in JSX children position is TEXT, not a comment, and
     this one sat directly above the strip: written that way it would have
     painted its own explanation across every chip club lobby. Caught in review
     on 2026-09-11, pinned here because nothing else would notice. */
  it('comments the strip in JSX form so the note never paints itself', () => {
    const note = page.indexOf('The Bad Beat Jackpot is a chip pool');
    expect(note).toBeGreaterThan(-1);
    expect(page.slice(note - 120, note)).toContain('{/*');
    expect(page).not.toMatch(/\n\s+\/\* The Bad Beat Jackpot is a chip pool/);
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
