/**
 * LIGHTNING PHASE 6: /lightning/:clusterId resolves the caller's pool session.
 * Present: the pool session's room opens in the table view (tableId = pool
 * session id). Absent: the Cluster's JOIN LIGHTNING entry, which runs the
 * existing cash join and sends the player to the table's own buy-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

const rpc = vi.fn();
const tablesRead = vi.fn();
const gameRow = {
  id: CLUSTER,
  club_id: null,
  name: 'NLH 1/2 Classic',
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
      chain.maybeSingle = () => Promise.resolve({ data: gameRow, error: null });
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
  getLightningEntryIntent,
  getLightningPoolSession,
  resetLightningRegistryForTests,
} from '../../src/lightning/lightningSession';

function TableProbe() {
  const { tableId } = useParams();
  const loc = useLocation();
  return <div data-testid="table-route">{`${tableId}|${loc.search}`}</div>;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/lightning/:clusterId" element={<LightningEntryPage />} />
        <Route path="/table/:tableId" element={<TableProbe />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  sessionStorage.clear();
  resetLightningRegistryForTests();
  rpc.mockReset();
  tablesRead.mockReset();
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
      expect(await screen.findByText('Game Paused')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
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
