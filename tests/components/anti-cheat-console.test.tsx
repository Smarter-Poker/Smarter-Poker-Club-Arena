/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ANTI-CHEAT CONSOLE READS THE CLUB IT IS POINTED AT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03, phase 2)
 *
 * The page took the route param and set it straight into `clubId`. Club routes
 * are addressed by slug, and every read here passes clubId into a uuid argument
 * or an .eq on a uuid column, so Postgres answered `22P02 invalid input syntax
 * for type uuid` on every single query and each catch block turned that into an
 * empty state. The console has shown six zeros and the words "Club Is Clean" on
 * every club URL since it shipped, and nothing anywhere went red.
 *
 * There was no test that mounted it. This is that test.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_SLUG = 'deep-stack-society-11192';
const CLUB_UUID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

const rpcMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());
const resolveMock = vi.hoisted(() => vi.fn());
const toastState = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const routeState = vi.hoisted(() => ({ clubId: 'deep-stack-society-11192' }));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useParams: () => ({ clubId: routeState.clubId }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'owner-1' }, isHydrating: false }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (...args: unknown[]) => resolveMock(...args),
  isUUID: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toastState }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: () => () => undefined,
    subscribeDebounced: () => () => undefined,
    getOrCreateChannel: () => ({
      on() {
        return this;
      },
      subscribe: () => undefined,
    }),
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/IntegrityActionService', () => ({
  adminRemovePlayerFromClubTables: vi.fn(async () => ({ removed: 1, failed: 0, firstError: null })),
}));

import AntiCheatPage, { evidenceSummary } from '../../src/pages/AntiCheatPage';

const STATS = {
  open_flags: 5,
  blocks_24h: 2,
  active_sessions: 221,
  by_severity: { high: 4, medium: 1 },
  by_type: { multi_account: 5 },
};

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  resolveMock.mockReset();
  resolveMock.mockResolvedValue(CLUB_UUID);
  rpcMock.mockImplementation((name: string) => {
    if (name === 'get_anti_cheat_stats') return Promise.resolve({ data: STATS, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  fromMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return chain;
  });
});

describe('the console resolves the club before it reads anything', () => {
  it('never sends the route slug into a uuid argument', async () => {
    render(<AntiCheatPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(resolveMock).toHaveBeenCalledWith(CLUB_SLUG);
    for (const call of rpcMock.mock.calls) {
      const args = call[1] as { p_club_id?: string } | undefined;
      if (args?.p_club_id) expect(args.p_club_id).toBe(CLUB_UUID);
    }
  });

  it('paints the readings the function returns rather than six zeros', async () => {
    render(<AntiCheatPage />);
    await waitFor(() => expect(screen.getByText('Open Flags')).toBeTruthy());
    // 5 appears as the open-flag count and again in the severity breakdown, so
    // this asserts the tile itself rather than the first 5 on the page.
    const openFlagTile = screen.getByText('Open Flags').parentElement;
    expect(openFlagTile?.textContent).toContain('5');
    expect(screen.getByText('221')).toBeTruthy();
    expect(screen.getByText('Enforcement (24H)')).toBeTruthy();
    expect(screen.getByText('Players Seated Now')).toBeTruthy();
  });

  it('says a read failed instead of calling the club clean', async () => {
    rpcMock.mockImplementation(() =>
      Promise.resolve({ data: null, error: { code: 'PGRST301', message: 'boom' } })
    );
    render(<AntiCheatPage />);
    await waitFor(() =>
      expect(screen.getByText('The Integrity Readings Could Not Be Loaded')).toBeTruthy()
    );
    expect(screen.queryByText(/Club Is Clean/i)).toBeNull();
  });

  it('names the refusal when the database says this role may not look', async () => {
    rpcMock.mockImplementation(() =>
      Promise.resolve({
        data: null,
        error: { code: '42501', message: 'not authorized for this club' },
      })
    );
    render(<AntiCheatPage />);
    await waitFor(() =>
      expect(
        screen.getByText('Integrity Review Is Restricted To Club Owners And Administrators')
      ).toBeTruthy()
    );
  });
});

describe('the evidence a detector recorded is the evidence that is shown', () => {
  it('reads a chip dump pair', () => {
    expect(
      evidenceSummary({ evidence: { hands: 14, loser_loss_ratio: 0.82, pot_volume: 12345 } })
    ).toBe('Loss Ratio 82% · Pot Volume 12,345');
  });

  it('reads a win rate pair', () => {
    expect(evidenceSummary({ evidence: { bb_per_100: 245.5, direction: 'a_to_b' } })).toBe(
      '245.5 BB Per 100 · Direction a_to_b'
    );
  });

  it('says so when a pair carries nothing, instead of printing a zero', () => {
    // The old table had a Net Chips column that no detector has ever written,
    // so COALESCE made every row read 0.00.
    expect(evidenceSummary({ evidence: {} })).toBe('No Evidence Recorded');
    expect(evidenceSummary({ evidence: null })).toBe('No Evidence Recorded');
  });
});
