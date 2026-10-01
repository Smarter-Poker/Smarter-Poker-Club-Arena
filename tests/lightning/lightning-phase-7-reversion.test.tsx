/**
 * LIGHTNING PHASE 7: LIGHTNING -> MUST_MOVE, THE CLIENT'S HALF (2026-10-02).
 *
 *   1. fn_lightning_my_session's new `seat_table_id`, and the one rule that
 *      turns it into "your seat is at table X": no open pool session, the
 *      Cluster MUST MOVE, a live seat.
 *   2. The room: each 4404 asks the database; the answer naming the seat
 *      shows the MUST MOVE notice with one button to that table. Nothing
 *      moves the player without the button (CLAUDE.md 10.6).
 *   3. The Lightning route on a MUST MOVE Cluster where the caller is seated
 *      offers their table (VIEW GAME), never JOIN LIGHTNING.
 *   4. The lobby through the reversion: LIGHTNING LIVE (THIN) without JOIN
 *      LIGHTNING while pending_off, then MUST MOVE / JOIN GAME.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const SEAT_TABLE = '33333333-3333-4333-8333-333333333333';

const rpc = vi.fn();
const gameRow: Record<string, unknown> = {
  id: CLUSTER,
  club_id: null,
  name: 'NLH 1/2 Classic',
  variant: 'nlh',
  sb: 1,
  bb: 2,
  handedness: 6,
  cluster_mode: 'must_move',
  enabled: true,
};
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'limit']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: gameRow, error: null });
      return chain;
    },
  },
}));
const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));
const warmTable = vi.fn();
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: (...a: unknown[]) => warmTable(...a),
}));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));

import {
  lightningEntryDecision,
  lightningReturnTableId,
  parseLightningMySession,
  resetLightningRegistryForTests,
} from '../../src/lightning/lightningSession';
import {
  LIGHTNING_ENDED_TEXT,
  LIGHTNING_RETURN_LABEL,
  lightningReturnPath,
  useLightningReversion,
} from '../../src/lightning/lightningReversion';
import LightningEndedNotice from '../../src/components/table/LightningEndedNotice';
import LightningEntryPage from '../../src/pages/LightningEntryPage';
import { lightningLobbyBadge, parseLightningLobbyState } from '../../src/lightning/lightningLobby';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';

const ROOT = resolve(__dirname, '../..');
const PAGE = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');

const reverted = {
  pool_session_id: null,
  state: null,
  cluster_mode: 'must_move',
  seat_table_id: SEAT_TABLE,
  seat_number: 4,
};

beforeEach(() => {
  sessionStorage.clear();
  resetLightningRegistryForTests();
  rpc.mockReset();
  reportError.mockReset();
  warmTable.mockReset();
  gameRow.cluster_mode = 'must_move';
});
afterEach(cleanup);

// ─── 1. The seat Lightning hands back ───────────────────────────────────────

describe('1. fn_lightning_my_session names the seat after reversion', () => {
  it('reads seat_table_id and seat_number defensively', () => {
    const s = parseLightningMySession(reverted);
    expect(s.poolSessionId).toBeNull();
    expect(s.seatTableId).toBe(SEAT_TABLE);
    expect(s.seatNumber).toBe(4);
    expect(parseLightningMySession({ ...reverted, seat_table_id: 'nope' }).seatTableId).toBeNull();
    expect(parseLightningMySession(null).seatTableId).toBeNull();
  });

  it('only "no pool session, MUST MOVE, a seat" is a way back', () => {
    expect(lightningReturnTableId(parseLightningMySession(reverted))).toBe(SEAT_TABLE);
    // Still Lightning (the room is still theirs).
    expect(
      lightningReturnTableId(
        parseLightningMySession({ ...reverted, pool_session_id: POOL, state: 'active' })
      )
    ).toBeNull();
    // On the way out, or any other mode: not yet.
    for (const mode of ['pending_off', 'lightning', 'paused'])
      expect(
        lightningReturnTableId(parseLightningMySession({ ...reverted, cluster_mode: mode })),
        mode
      ).toBeNull();
    // MUST MOVE but no seat: the player left or cashed out; nothing to go back to.
    expect(
      lightningReturnTableId(parseLightningMySession({ ...reverted, seat_table_id: null }))
    ).toBeNull();
    expect(lightningReturnTableId(null)).toBeNull();
  });
});

// ─── 2. The room after Lightning ends ───────────────────────────────────────

describe('2. the room turns into the MUST MOVE notice', () => {
  it('asks nothing until the room is closed, then names the seat', async () => {
    rpc.mockResolvedValue({ data: reverted, error: null });
    const { result, rerender } = renderHook(
      ({ closed }: { closed: unknown }) =>
        useLightningReversion({ clusterId: CLUSTER, roomClosed: closed }),
      { initialProps: { closed: null as unknown } }
    );
    expect(rpc).not.toHaveBeenCalled();
    rerender({ closed: { code: 4404 } });
    await waitFor(() => expect(result.current.seatTableId).toBe(SEAT_TABLE));
    expect(rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: CLUSTER });
    // Found once; a later close asks nothing more.
    rerender({ closed: { code: 4404 } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('a close while the Cluster is still Lightning (an engine restart) shows nothing', async () => {
    rpc.mockResolvedValue({
      data: { pool_session_id: POOL, state: 'active', cluster_mode: 'lightning' },
      error: null,
    });
    const { result } = renderHook(() =>
      useLightningReversion({ clusterId: CLUSTER, roomClosed: { code: 4404 } })
    );
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(result.current.seatTableId).toBeNull();
  });

  it('a read that fails is reported and asked again on the next close', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    rpc.mockResolvedValue({ data: reverted, error: null });
    const { result, rerender } = renderHook(
      ({ closed }: { closed: unknown }) =>
        useLightningReversion({ clusterId: CLUSTER, roomClosed: closed }),
      { initialProps: { closed: { code: 4404, n: 1 } as unknown } }
    );
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    expect(result.current.seatTableId).toBeNull();
    rerender({ closed: { code: 4404, n: 2 } });
    await waitFor(() => expect(result.current.seatTableId).toBe(SEAT_TABLE));
  });

  it('not a Lightning room: never asks', async () => {
    renderHook(() => useLightningReversion({ clusterId: null, roomClosed: { code: 4404 } }));
    await Promise.resolve();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('the notice says Lightning has ended, and moves the player only by its button', () => {
    const onViewGame = vi.fn();
    render(<LightningEndedNotice onViewGame={onViewGame} />);
    const notice = screen.getByTestId('lightning-ended');
    expect(notice.textContent).toContain('Must Move');
    expect(notice.textContent).toContain(LIGHTNING_ENDED_TEXT);
    expect(LIGHTNING_ENDED_TEXT).toBe('Lightning Has Ended. Your Seat Is Ready At Your Table.');
    expect(LIGHTNING_RETURN_LABEL).toBe('View Game');
    expect(onViewGame).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View Game' }));
    expect(onViewGame).toHaveBeenCalledTimes(1);
    expect(lightningReturnPath(SEAT_TABLE)).toBe(`/table/${SEAT_TABLE}`);
  });

  it('TablePage: a 4404 on a Lightning room asks, and the notice is mounted in the room', () => {
    expect(PAGE).toMatch(
      /useLightningReversion\(\{\s*clusterId: lightningRoom\?\.clusterId \?\? null,\s*roomClosed: lightningRoom && engineLastError\?\.code === 4404 \? engineLastError : null,\s*\}\)/
    );
    const mount = sliceEnclosingBlock(PAGE, '<LightningEndedNotice');
    expect(mount).toContain('lightningRoom && lightningReversion.seatTableId');
  });

  it('TablePage: the only move to the seat is inside the button handler', () => {
    const sites = PAGE.split('lightningReturnPath(').length - 1;
    expect(sites).toBe(1);
    const handler = sliceEnclosingBlock(PAGE, 'navigate(lightningReturnPath(seatTable)');
    // That block is the body of the notice's button handler, and nothing else.
    expect(PAGE.slice(0, PAGE.indexOf(handler)).trimEnd().endsWith('onViewGame={() =>')).toBe(true);
    // The multi-table view is re-pointed by the same press, never by an effect.
    expect(handler).toContain('onTableInfoUpdate?.({ movedToTableId: seatTable })');
  });

  it('TablePage: the notice replaces the "session has ended" toast rather than repeating it', () => {
    const toastSite = sliceEnclosingBlock(PAGE, "'Your Lightning Session Has Ended'", 0, 2);
    expect(toastSite).toMatch(
      /if \(!lightningReturnRef\.current\) \{\s*heartbeatToastRef\.current\?\.info\?\.\('Your Lightning Session Has Ended'\);/
    );
  });
});

// ─── 3. The Lightning route on a MUST MOVE Cluster ─────────────────────────

function TableProbe() {
  const { tableId } = useParams();
  return <div data-testid="table-route">{tableId}</div>;
}
const renderRoute = () =>
  render(
    <MemoryRouter initialEntries={[`/lightning/${CLUSTER}`]}>
      <Routes>
        <Route path="/lightning/:clusterId" element={<LightningEntryPage />} />
        <Route path="/table/:tableId" element={<TableProbe />} />
      </Routes>
    </MemoryRouter>
  );

describe('3. the Lightning route after reversion', () => {
  it('a seated caller is offered their table (VIEW GAME), never a join, and is not moved', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'fn_lightning_my_session'
        ? { data: reverted, error: null }
        : { data: null, error: null }
    );
    renderRoute();
    const view = await screen.findByRole('button', { name: 'View Game' });
    expect(screen.getByText(LIGHTNING_ENDED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
    expect(screen.queryByTestId('table-route')).toBeNull();
    fireEvent.click(view);
    expect((await screen.findByTestId('table-route')).textContent).toBe(SEAT_TABLE);
    expect(warmTable).toHaveBeenCalledWith(SEAT_TABLE);
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('fn_cash_game_join');
  });

  it('a caller with no seat on the MUST MOVE Cluster still sees JOIN GAME', async () => {
    rpc.mockResolvedValue({ data: { ...reverted, seat_table_id: null }, error: null });
    renderRoute();
    expect(await screen.findByRole('button', { name: /join game/i })).toBeTruthy();
  });

  it('the decision itself', () => {
    expect(lightningEntryDecision(parseLightningMySession(reverted), null)).toEqual({
      kind: 'seat',
      seatTableId: SEAT_TABLE,
    });
    expect(
      lightningEntryDecision(
        parseLightningMySession({ ...reverted, cluster_mode: 'pending_off' }),
        null
      )
    ).toMatchObject({ kind: 'entry', joinLabel: 'Join Game', lightning: false });
  });
});

// ─── 4. The lobby through the reversion ────────────────────────────────────

describe('4. the lobby card through LIGHTNING -> PENDING_OFF -> MUST_MOVE', () => {
  const cardCtx = {
    seatedIds: new Set<string>(),
    waitlistedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    onJoinTable: () => {},
    onViewTable: () => {},
    onWaitlistToggle: () => {},
  } as unknown as LobbyRowContext;
  const row = (mode: string): LobbyTableRow =>
    ({
      id: SEAT_TABLE,
      name: 'NLH 1/2 Main 1',
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      min_buy_in: 80,
      max_buy_in: 400,
      current_players: 5,
      max_players: 6,
      status: 'running',
      cluster_id: CLUSTER,
      role: 'main',
      main_index: 1,
      lifecycle: 'live',
      cluster_must_move: true,
      cluster_players: 5,
      cluster_tables: 1,
      cluster_mode: mode,
      cluster_lightning: parseLightningLobbyState({
        cluster_mode: mode,
        thresholds: { on: 18, off: 12 },
        verdict: { live_eligible: 20 },
      }),
    }) as LobbyTableRow;
  const card = (mode: string) => {
    const e = cashEntry(row(mode));
    const words = e.rules
      .filter((r) => r.label === 'LIGHTNING LIVE' || r.label === 'MUST MOVE')
      .map((r) => (r.detail && r.label === 'LIGHTNING LIVE' ? `${r.label} ${r.detail}` : r.label));
    return { words, door: arenaGameCardActionsForEntry(e, cardCtx).primaryLabel };
  };

  it('each step says what the Cluster is, and offers the door it really has', () => {
    expect(card('lightning')).toEqual({ words: ['LIGHTNING LIVE ACTIVE'], door: 'Join Lightning' });
    expect(card('pending_off')).toEqual({ words: ['LIGHTNING LIVE THIN'], door: 'Join Game' });
    expect(card('must_move')).toEqual({ words: ['MUST MOVE'], door: 'Join Game' });
    expect(
      lightningLobbyBadge({ clusterMode: 'pending_off', state: null, boardPlayers: 4 })
    ).toMatchObject({ label: 'LIGHTNING LIVE', status: 'THIN', joinLightning: false });
  });
});
