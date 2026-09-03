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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: (...args: unknown[]) => confirmMock(...args),
}));
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

/**
 * The shape `detect_collusion_pairs` returns after the same-day correction.
 * Two things changed and both are load-bearing: the second group is `screening`
 * rather than `win_rate`, because it carries every pattern that is not a chip
 * dump and three of the seven rows open on the estate are TIMING_CORRELATION;
 * and `closed_pairs` is reported, so an empty queue reads as "the screen ran
 * and closed itself" instead of "nothing was screened".
 */
const COLLUSION = {
  analyzed_hands: 273794,
  club_players: 41,
  window_days: 30,
  threshold: 0.75,
  cap: 50,
  closed_pairs: 5591,
  chip_dump: {
    total: 1,
    pairs: [
      {
        dumper_id: 'player-a',
        receiver_id: 'player-b',
        pattern_type: 'CHIP_DUMP',
        hands_together: 22,
        score: 91,
        chip_flow_ratio: 0.91,
        severity: 'high',
        evidence: { hands: 22, loser_loss_ratio: 0.88 },
      },
    ],
  },
  screening: {
    total: 2,
    pairs: [
      {
        dumper_id: 'player-c',
        receiver_id: 'player-d',
        pattern_type: 'TIMING_CORRELATION',
        hands_together: 40,
        score: 80,
        chip_flow_ratio: 0.8,
        severity: 'medium',
        evidence: { bb_per_100: 245.5 },
      },
    ],
  },
};

describe('the collusion screen shows the open queue and says what it closed', () => {
  async function openCollusionTab() {
    render(<AntiCheatPage />);
    // The tab strip paints immediately, but the overview load is still in
    // flight. Settle it before clicking, or its resolution lands outside act.
    await waitFor(() => expect(screen.getByText('Open Flags')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText('Collusion'));
    });
  }

  beforeEach(() => {
    confirmMock.mockClear();
    confirmMock.mockResolvedValue(true);
    toastState.success.mockClear();
    toastState.error.mockClear();
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_anti_cheat_stats') return Promise.resolve({ data: STATS, error: null });
      if (name === 'detect_collusion_pairs')
        return Promise.resolve({ data: COLLUSION, error: null });
      if (name === 'fn_ca_dismiss_collusion_pair')
        return Promise.resolve({ data: { ok: true, updated: 3 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('paints both groups and the count the detector already closed', async () => {
    await openCollusionTab();
    await waitFor(() => expect(screen.getByText('Chip Dump Pairs')).toBeTruthy());
    expect(screen.getByText('Chip Dump Pairs').parentElement?.textContent).toContain('1');
    expect(screen.getByText('Other Signals Open').parentElement?.textContent).toContain('2');
    expect(screen.getByText('Already Closed').parentElement?.textContent).toContain('5,591');
    expect(screen.getByText('Hands Analyzed').parentElement?.textContent).toContain('273,794');
  });

  it("names each row's own pattern instead of calling it a win rate outlier", async () => {
    await openCollusionTab();
    await waitFor(() => expect(screen.getByText('TIMING CORRELATION')).toBeTruthy());
    expect(screen.queryByText(/Win Rate Anomal/i)).toBeNull();
  });

  it('clears a pair through the RPC and reports how many rows moved', async () => {
    await openCollusionTab();
    await waitFor(() => expect(screen.getAllByText('Clear').length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(screen.getAllByText('Clear')[0]);
    });
    await waitFor(() =>
      expect(rpcMock.mock.calls.some((call) => call[0] === 'fn_ca_dismiss_collusion_pair')).toBe(
        true
      )
    );
    const call = rpcMock.mock.calls.find((c) => c[0] === 'fn_ca_dismiss_collusion_pair');
    expect((call?.[1] as { p_club_id?: string })?.p_club_id).toBe(CLUB_UUID);
    await waitFor(() =>
      expect(toastState.success).toHaveBeenCalledWith('Cleared 3 Screening Rows.')
    );
  });

  it('does not tell the operator a pair was cleared when nothing moved', async () => {
    // The RPC answers { ok: false } when the pair never played here, and a
    // status the check constraint forbids used to throw a raw violation. Either
    // way the console must not paint a success.
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_anti_cheat_stats') return Promise.resolve({ data: STATS, error: null });
      if (name === 'detect_collusion_pairs')
        return Promise.resolve({ data: COLLUSION, error: null });
      if (name === 'fn_ca_dismiss_collusion_pair')
        return Promise.resolve({
          data: { ok: false, reason: 'pair_did_not_play_here', updated: 0 },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    });
    await openCollusionTab();
    await waitFor(() => expect(screen.getAllByText('Clear').length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(screen.getAllByText('Clear')[0]);
    });
    await waitFor(() => expect(toastState.error).toHaveBeenCalled());
    expect(toastState.success).not.toHaveBeenCalled();
  });
});
