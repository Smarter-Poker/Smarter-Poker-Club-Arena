/**
 * LIGHTNING PHASE 6: /lightning/:clusterId resolves the caller's pool session.
 * Present: the pool session's room opens in the table view (tableId = pool
 * session id). Absent: the Cluster's JOIN LIGHTNING entry, which runs the
 * existing cash join and sends the player to the table's own buy-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const NEXT_CLUSTER = '44444444-4444-4444-8444-444444444444';
const NEXT_ANCHOR = '55555555-5555-4555-8555-555555555555';

const rpc = vi.fn();
const tablesRead = vi.fn();
const metadataRead = vi.fn();
const gameRow = {
  id: CLUSTER,
  club_id: null,
  name: 'NLH 1/2 Action',
  template_name: 'action',
  variant: 'nlh',
  sb: 1,
  bb: 2,
  handedness: 6,
  cluster_mode: 'lightning',
  enabled: true,
};
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      if (table === 'tables') tablesRead();
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = () => metadataRead();
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));

import LightningEntryPage from '../../src/pages/LightningEntryPage';
import {
  fetchMyLightningSession,
  getLightningEntryIntent,
  getLightningPoolSession,
  resetLightningRegistryForTests,
} from '../../src/lightning/lightningSession';

function TableProbe() {
  const { tableId } = useParams();
  const loc = useLocation();
  return <div data-testid="table-route">{`${tableId}|${loc.search}`}</div>;
}

function RouteSwitch() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/lightning/${NEXT_CLUSTER}`)}>Open Next Game</button>;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <RouteSwitch />
      <Routes>
        <Route path="/lightning/:clusterId" element={<LightningEntryPage />} />
        <Route path="/table/:tableId" element={<TableProbe />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  for (const method of Object.values(toast)) method.mockClear();
  resetLightningRegistryForTests();
  rpc.mockReset();
  tablesRead.mockReset();
  metadataRead.mockReset();
  metadataRead.mockResolvedValue({ data: gameRow, error: null });
});
afterEach(cleanup);

describe('the Lightning route', () => {
  it('opens the pool session room when the caller holds one, and never reads a tables row', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'fn_lightning_my_session'
        ? {
            data: {
              pool_session_id: POOL,
              state: 'active',
              cluster_mode: 'lightning',
              stack: 200,
              in_hand: false,
            },
            error: null,
          }
        : { data: null, error: null }
    );
    renderAt(`/lightning/${CLUSTER}`);
    const probe = await screen.findByTestId('table-route');
    expect(probe.textContent?.startsWith(`${POOL}|`)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: CLUSTER });
    expect(getLightningPoolSession(POOL)?.clusterId).toBe(CLUSTER);
    expect(tablesRead).not.toHaveBeenCalled();
  });

  it('shows JOIN LIGHTNING when there is no session, and the join runs the existing door', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_lightning_my_session') {
        return {
          data: { pool_session_id: null, state: null, cluster_mode: 'lightning' },
          error: null,
        };
      }
      if (name === 'fn_cash_game_join') {
        return { data: { ok: true, action: 'seat', table_id: ANCHOR }, error: null };
      }
      return { data: null, error: null };
    });
    renderAt(`/lightning/${CLUSTER}`);
    const join = await screen.findByRole('button', { name: /join lightning/i });
    expect(screen.queryByText(/table \d|seat \d/i)).toBeNull();
    fireEvent.click(join);
    const probe = await screen.findByTestId('table-route');
    expect(probe.textContent).toBe(`${ANCHOR}|`);
    expect(rpc).toHaveBeenCalledWith('fn_cash_game_join', { p_game_id: CLUSTER });
    expect(getLightningEntryIntent(ANCHOR)).toBe(CLUSTER);
  });

  it('says JOIN GAME for a Cluster still running as MUST MOVE', async () => {
    gameRow.cluster_mode = 'must_move';
    rpc.mockResolvedValue({
      data: { pool_session_id: null, cluster_mode: 'must_move' },
      error: null,
    });
    renderAt(`/lightning/${CLUSTER}`);
    expect(await screen.findByRole('button', { name: /join game/i })).toBeTruthy();
    gameRow.cluster_mode = 'lightning';
  });

  it('JOIN GAME on a Cluster leaving Lightning leaves no intent: the table never waits for a pool', async () => {
    gameRow.cluster_mode = 'pending_off';
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_lightning_my_session') {
        return { data: { pool_session_id: null, cluster_mode: 'pending_off' }, error: null };
      }
      if (name === 'fn_cash_game_join') {
        return { data: { ok: true, action: 'seat', table_id: ANCHOR }, error: null };
      }
      return { data: null, error: null };
    });
    try {
      renderAt(`/lightning/${CLUSTER}`);
      const join = await screen.findByRole('button', { name: /join game/i });
      expect(screen.queryByRole('button', { name: /join lightning/i })).toBeNull();
      fireEvent.click(join);
      await screen.findByTestId('table-route');
      expect(getLightningEntryIntent(ANCHOR)).toBeNull();
    } finally {
      gameRow.cluster_mode = 'lightning';
    }
  });

  it('a paused Cluster offers no door and says Game Paused', async () => {
    gameRow.cluster_mode = 'paused';
    rpc.mockResolvedValue({ data: { pool_session_id: null, cluster_mode: 'paused' }, error: null });
    try {
      renderAt(`/lightning/${CLUSTER}`);
      expect(await screen.findByText('Paused')).toBeTruthy();
      expect(screen.getByRole('button', { name: /join/i }).hasAttribute('disabled')).toBe(true);
    } finally {
      gameRow.cluster_mode = 'lightning';
    }
  });

  it('prints no technical loading text while it resolves', async () => {
    let release: (v: unknown) => void = () => {};
    rpc.mockImplementation(() => new Promise((r) => (release = r)));
    renderAt(`/lightning/${CLUSTER}`);
    const page = screen.getByTestId('lightning-entry');
    expect(page.textContent).toBe('');
    release({ data: null, error: null });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /join lightning/i })).toBeTruthy()
    );
  });

  it('refuses a malformed Cluster id without asking the database', () => {
    renderAt('/lightning/not-a-cluster');
    expect(screen.getByText(/game unavailable/i)).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('truthful regular-table entry guidance', () => {
  it.each([6, 9])(
    'explains the %s-max MUST MOVE buy-in without promising Lightning hands',
    async (size) => {
      const previousMode = gameRow.cluster_mode;
      const previousSize = gameRow.handedness;
      gameRow.cluster_mode = 'must_move';
      gameRow.handedness = size;
      rpc.mockImplementation(async (name: string) => {
        if (name === 'fn_lightning_my_session')
          return { data: { pool_session_id: null, cluster_mode: 'must_move' }, error: null };
        if (name === 'fn_cash_game_join')
          return { data: { ok: true, action: 'seat', table_id: ANCHOR }, error: null };
        return { data: null, error: null };
      });
      try {
        renderAt(`/lightning/${CLUSTER}`);
        const join = await screen.findByRole('button', { name: 'Join Game' });
        expect(screen.queryByText(/This Game Uses Regular Tables/)).toBeNull();
        expect(screen.queryByText(/Buy In Once And Play One Stream/)).toBeNull();
        expect(screen.queryByTestId('table-route')).toBeNull();
        expect(rpc.mock.calls.some(([name]) => name === 'fn_lightning_pool_status')).toBe(false);
        fireEvent.click(join);
        expect((await screen.findByTestId('table-route')).textContent).toBe(`${ANCHOR}|`);
        expect(getLightningEntryIntent(ANCHOR)).toBeNull();
      } finally {
        gameRow.cluster_mode = previousMode;
        gameRow.handedness = previousSize;
      }
    }
  );

  it('gives normal buy-in guidance during preparation without claiming the mode is active', async () => {
    const previousMode = gameRow.cluster_mode;
    gameRow.cluster_mode = 'pending_on';
    rpc.mockResolvedValue({
      data: { pool_session_id: null, cluster_mode: 'pending_on' },
      error: null,
    });
    try {
      renderAt(`/lightning/${CLUSTER}`);
      await screen.findByRole('button', { name: 'Join Game' });
      expect(screen.queryByText(/Join Game Opens The Normal Table Buy-In/)).toBeNull();
      expect(screen.queryByText(/Buy In Once And Play One Stream/)).toBeNull();
      expect(screen.queryByTestId('table-route')).toBeNull();
    } finally {
      gameRow.cluster_mode = previousMode;
    }
  });
});

describe('private direct-link entry boundaries', () => {
  it('preserves explicit session refusal as a failed read', async () => {
    const refusal = { ok: false, code: 'NOT_AUTHORIZED', reason: 'membership_required' };
    rpc.mockResolvedValue({ data: refusal, error: null });
    await expect(fetchMyLightningSession(CLUSTER)).rejects.toMatchObject(refusal);
    renderAt(`/lightning/${CLUSTER}`);
    await screen.findByText('Game Unavailable');
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it.each(['missing', 'failed', 'wrong-cluster'])(
    'offers no join for %s metadata without an owned room or seat',
    async (outcome) => {
      metadataRead.mockResolvedValue(
        outcome === 'failed'
          ? { data: null, error: { code: 'PRIVATE_READ_DENIED' } }
          : { data: outcome === 'missing' ? null : { ...gameRow, id: ANCHOR }, error: null }
      );
      rpc.mockResolvedValue({ data: { pool_session_id: null }, error: null });
      renderAt(`/lightning/${CLUSTER}`);
      await screen.findByText('Game Unavailable');
      expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
      expect(screen.queryByTestId('table-route')).toBeNull();
    }
  );

  it('retains legacy owned-room recovery when metadata fails', async () => {
    metadataRead.mockResolvedValue({ data: null, error: { code: 'META_UNREADABLE' } });
    rpc.mockImplementation(async (name) => ({
      data: name === 'fn_lightning_my_session' ? { pool_session_id: POOL, state: 'active' } : null,
      error: null,
    }));
    renderAt(`/lightning/${CLUSTER}`);
    expect((await screen.findByTestId('table-route')).textContent).toBe(`${POOL}|`);
  });

  it('retains a manual owned-seat return when metadata is missing', async () => {
    metadataRead.mockResolvedValue({ data: null, error: null });
    rpc.mockImplementation(async (name) => ({
      data:
        name === 'fn_lightning_my_session'
          ? { pool_session_id: null, seat_table_id: ANCHOR, cluster_mode: 'must_move' }
          : null,
      error: null,
    }));
    renderAt(`/lightning/${CLUSTER}`);
    const view = await screen.findByRole('button', { name: 'View Game' });
    expect(screen.queryByTestId('table-route')).toBeNull();
    fireEvent.click(view);
    expect((await screen.findByTestId('table-route')).textContent).toBe(`${ANCHOR}|`);
  });
});

describe('route ownership of a pending join', () => {
  it.each(['seat', 'waitlisted', 'refused'])(
    'ignores a delayed %s result from the old game while the new join owns the page',
    async (outcome) => {
      let resolveOld: (value: unknown) => void = () => {};
      let resolveNext: (value: unknown) => void = () => {};
      rpc.mockImplementation(async (name, args) => {
        if (name === 'fn_lightning_my_session')
          return { data: { pool_session_id: null }, error: null };
        if (name === 'fn_cash_game_join')
          return await new Promise((resolve) => {
            if (args.p_game_id === CLUSTER) resolveOld = resolve;
            else resolveNext = resolve;
          });
        return { data: null, error: null };
      });
      renderAt(`/lightning/${CLUSTER}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Join Lightning' }));
      await screen.findByRole('button', { name: 'Joining...' });
      metadataRead.mockResolvedValue({ data: { ...gameRow, id: NEXT_CLUSTER }, error: null });
      fireEvent.click(screen.getByRole('button', { name: 'Open Next Game' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Join Lightning' }));
      await screen.findByRole('button', { name: 'Joining...' });
      const prefsBefore = localStorage.getItem('ca.lightning.prefs.v1');
      await act(async () => {
        resolveOld(
          outcome === 'refused'
            ? { data: { ok: false, reason: 'membership_required' }, error: null }
            : {
                data:
                  outcome === 'seat'
                    ? { ok: true, action: 'seat', table_id: ANCHOR }
                    : { ok: true, action: 'waitlisted', position: 1 },
                error: null,
              }
        );
      });
      await waitFor(() =>
        expect(rpc.mock.calls.filter(([name]) => name === 'fn_cash_game_join')).toHaveLength(2)
      );
      expect(screen.queryByTestId('table-route')).toBeNull();
      expect(screen.getByRole('button', { name: 'Joining...' })).toBeTruthy();
      expect(getLightningEntryIntent(ANCHOR)).toBeNull();
      expect(localStorage.getItem('ca.lightning.prefs.v1')).toBe(prefsBefore);
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
      resolveNext({ data: { ok: true, action: 'seat', table_id: NEXT_ANCHOR }, error: null });
      expect((await screen.findByTestId('table-route')).textContent).toBe(`${NEXT_ANCHOR}|`);
      expect(getLightningEntryIntent(NEXT_ANCHOR)).toBe(NEXT_CLUSTER);
      expect(
        rpc.mock.calls
          .filter(([name]) => name === 'fn_cash_game_join')
          .map(([, args]) => args.p_game_id)
      ).toEqual([CLUSTER, NEXT_CLUSTER]);
    }
  );
});

describe('late old-game outcome after navigating away', () => {
  it.each(['seat', 'waitlisted', 'refused'])(
    'does not apply a delayed %s result to the new entry page',
    async (outcome) => {
      let resolveOld: (value: unknown) => void = () => {};
      rpc.mockImplementation(async (name) => {
        if (name === 'fn_lightning_my_session')
          return { data: { pool_session_id: null }, error: null };
        if (name === 'fn_cash_game_join')
          return await new Promise((resolve) => {
            resolveOld = resolve;
          });
        return { data: null, error: null };
      });
      renderAt(`/lightning/${CLUSTER}`);
      fireEvent.click(await screen.findByRole('button', { name: 'Join Lightning' }));
      await screen.findByRole('button', { name: 'Joining...' });
      metadataRead.mockResolvedValue({ data: { ...gameRow, id: NEXT_CLUSTER }, error: null });
      fireEvent.click(screen.getByRole('button', { name: 'Open Next Game' }));
      await waitFor(() =>
        expect(screen.getByTestId('lightning-entry').getAttribute('aria-busy')).toBeNull()
      );
      const prefsBefore = localStorage.getItem('ca.lightning.prefs.v1');
      await act(async () => {
        resolveOld(
          outcome === 'refused'
            ? { data: { ok: false, reason: 'membership_required' }, error: null }
            : {
                data:
                  outcome === 'seat'
                    ? { ok: true, action: 'seat', table_id: ANCHOR }
                    : { ok: true, action: 'waitlisted', position: 1 },
                error: null,
              }
        );
      });
      expect(screen.queryByTestId('table-route')).toBeNull();
      expect(screen.getByRole('button', { name: 'Join Lightning' })).toBeTruthy();
      expect(getLightningEntryIntent(ANCHOR)).toBeNull();
      expect(localStorage.getItem('ca.lightning.prefs.v1')).toBe(prefsBefore);
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
      expect(rpc.mock.calls.filter(([name]) => name === 'fn_cash_game_join')).toHaveLength(1);
    }
  );
});
