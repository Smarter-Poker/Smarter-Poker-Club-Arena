/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE DIAMOND ARENA HAS NO CHIP BRIDGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Programme rule (docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md): the arena club
 * must never acquire chip balances. Dan 2026-09-11: the Diamond Arena is "ONE
 * OPEN CLUB ... PLAYED WITH DIAMONDS INSTEAD OF CHIPS".
 *
 * Two chip club surfaces were mounted inside the Diamond context anyway. The
 * closed-arena notice in ArenaAccessBoundary carried the Diamonds To Chips
 * button, and the lobby mounted the bust prompt ("Out Of Chips? ... Chip
 * Prizes Paid Into Your Club Wallet"). Both lead to the HOST club's
 * diamonds-to-chips wheel, which pays chip prizes into that club's
 * `club_members.chip_balance`. Both were silent only because the Diamond host
 * club has no wheel configured, which is a database row somebody can add.
 *
 * So the law is stated at the component and at the source. Neither surface
 * renders for the Diamond arena context, and in the two files that mount them
 * the bridge is reachable only behind a predicate that says "not the Diamond
 * arena". Chip clubs keep both, untouched.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  auth: vi.fn(),
  bridge: vi.fn(),
  entry: vi.fn(),
  user: { id: 'player-a' },
  entryRow: null as null | { bust_prompt: boolean; member_chips: number | null; diamonds: number },
}));
vi.mock('../src/services/ArenaContextService', () => ({ getArenaContext: mocks.access }));
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: mocks.auth } },
}));
vi.mock('../src/components/games/DiamondsToChipsButton', () => ({
  default: (props: unknown) => {
    mocks.bridge(props);
    return <div data-testid="chip-bridge">Diamond Spins</div>;
  },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../src/hooks/useDiamondGamesEntry', () => ({
  useDiamondGamesEntry: (clubId: string | null | undefined, enabled = true) => {
    mocks.entry(clubId, enabled);
    return { entry: mocks.entryRow };
  },
}));

import ArenaAccessBoundary from '../src/components/arena/ArenaAccessBoundary';
import { ArenaAccessProvider } from '../src/components/arena/arenaAccess';
import DiamondBustPrompt from '../src/components/games/DiamondBustPrompt';

const at = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const code = (p: string) =>
  at(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const BOUNDARY = 'src/components/arena/ArenaAccessBoundary.tsx';
const LOBBY = 'src/pages/ClubHomePage.tsx';
const PROMPT = 'src/components/games/DiamondBustPrompt.tsx';
const DIAMOND_ARENA_CLUB_ID = '002c2d27-9584-4e52-835a-bb2be148fc81';

const diamond = {
  arena: { id: DIAMOND_ARENA_CLUB_ID, kind: 'diamond_arena', asset: 'diamonds' },
  member: true,
  automaticMembership: true,
  cashGamesEnabled: false,
  role: 'player',
  capabilities: { join: false, hierarchy: false, chipWallet: false, diamondTransfers: true },
} as const;
const chip = {
  arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
  member: true,
  automaticMembership: false,
  role: 'player',
  capabilities: { join: true, hierarchy: true, chipWallet: true, diamondTransfers: false },
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.entryRow = null;
});

describe('the closed-arena notice carries no chip bridge', () => {
  it('tells a Diamond player the games are closed and offers no Diamonds To Chips door', async () => {
    mocks.access.mockResolvedValue(diamond);
    render(
      <MemoryRouter initialEntries={[`/clubs/${DIAMOND_ARENA_CLUB_ID}`]}>
        <ArenaAccessBoundary clubKey={DIAMOND_ARENA_CLUB_ID}>
          <div>Shared Club Lobby</div>
        </ArenaAccessBoundary>
      </MemoryRouter>
    );
    expect(await screen.findByText('Shared Club Lobby')).toBeTruthy();
    expect(screen.getByText('Diamond Games Are Not Open For Play Yet.')).toBeTruthy();
    expect(screen.queryByTestId('chip-bridge')).toBeNull();
    expect(mocks.bridge, 'the bridge was mounted with the arena club id').not.toHaveBeenCalled();
  });

  it('never mounted the bridge for a chip club either, so nothing there changes', async () => {
    mocks.access.mockResolvedValue(chip);
    render(
      <MemoryRouter initialEntries={['/clubs/chip']}>
        <ArenaAccessBoundary clubKey="chip">
          <div>Private Chip Lobby</div>
        </ArenaAccessBoundary>
      </MemoryRouter>
    );
    expect(await screen.findByText('Private Chip Lobby')).toBeTruthy();
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it('does not import the bridge at all', () => {
    const src = code(BOUNDARY);
    expect(src).not.toMatch(/DiamondsToChipsButton/);
    expect(src).not.toMatch(/fn_diamond_games_entry|useDiamondGamesEntry/);
  });
});

describe('the bust prompt refuses the Diamond arena', () => {
  const eligible = { bust_prompt: true, member_chips: 0, diamonds: 25 };

  it('renders nothing and reads nothing inside the arena, even when every other condition holds', () => {
    mocks.entryRow = eligible;
    render(
      <MemoryRouter>
        <ArenaAccessProvider value={diamond}>
          <DiamondBustPrompt clubId={DIAMOND_ARENA_CLUB_ID} />
        </ArenaAccessProvider>
      </MemoryRouter>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Chip Prizes Paid Into Your Club Wallet/)).toBeNull();
    /* The entry read is switched off, not merely ignored: `fn_diamond_games_entry`
       must never be asked about the arena club. */
    expect(mocks.entry).toHaveBeenCalledWith(DIAMOND_ARENA_CLUB_ID, false);
  });

  it('still invites a felted chip club member, exactly as before', () => {
    mocks.entryRow = eligible;
    render(
      <MemoryRouter>
        <ArenaAccessProvider value={chip}>
          <DiamondBustPrompt clubId="chip" />
        </ArenaAccessProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeTruthy();
    expect(mocks.entry).toHaveBeenCalledWith('chip', true);
  });

  it('and outside any boundary, where every chip route lives today', () => {
    mocks.entryRow = eligible;
    render(
      <MemoryRouter>
        <DiamondBustPrompt clubId="chip" />
      </MemoryRouter>
    );
    expect(screen.getByRole('dialog', { name: 'Diamond Spins' })).toBeTruthy();
  });
});

describe('at the source, the bridge is reachable only behind a not-the-arena predicate', () => {
  it('the lobby mounts the bust prompt only when the arena is not automatic', () => {
    const src = code(LOBBY);
    const mounts = src.match(/<DiamondBustPrompt\b/g) ?? [];
    expect(mounts, 'the prompt is mounted once').toHaveLength(1);
    const element = sliceBetween(src, '<DiamondBustPrompt', '/>');
    const before = src.slice(Math.max(0, src.indexOf(element) - 40), src.indexOf(element));
    expect(before, 'the mount is not gated on the arena predicate').toMatch(
      /\{!isAutomaticArena &&\s*$/
    );
    /* And the predicate is the server's answer, not a route or a club id. */
    expect(src).toMatch(/const isAutomaticArena = arenaAccess\?\.automaticMembership === true/);
  });

  it('the lobby does not reach the games entry door any other way', () => {
    const src = code(LOBBY);
    expect(src).not.toMatch(/fn_diamond_games_entry|useDiamondGamesEntry|DiamondsToChipsButton/);
  });

  it('the prompt itself asks the boundary and switches its read off inside the arena', () => {
    const src = code(PROMPT);
    expect(src).toMatch(/const inDiamondArena = useAutomaticArenaMembership\(\)/);
    expect(src).toMatch(/useDiamondGamesEntry\(clubId, !inDiamondArena\)/);
    expect(src).toMatch(/!inDiamondArena &&/);
  });

  it('the games entry door is asked from one service, never from the arena files', () => {
    for (const file of [BOUNDARY, LOBBY, PROMPT]) {
      expect(code(file), `${file} names fn_diamond_games_entry`).not.toMatch(
        /fn_diamond_games_entry/
      );
    }
  });
});
