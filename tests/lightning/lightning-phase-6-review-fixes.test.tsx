/**
 * LIGHTNING PHASE 6, REVIEW FIXES (client).
 *
 *   1. Leave, cash out and add-on from a Lightning room go to the anchor seat
 *      fn_lightning_my_session names, and a leave during a live hand says it
 *      is queued until the hand ends.
 *   2. A room opened from a new tab or a shared link is found and registered
 *      before any "not found" can be shown.
 *   3. The JOIN LIGHTNING hand-off keeps asking (with a growing wait) until
 *      the pool session appears, says "Joining Lightning...", and stops on
 *      unmount or cancel.
 *   4. The idle snapshot after a fold: no LIGHTNING FOLD, and "Next Hand..."
 *      on the usual threshold.
 *   5. The lobby: MUST MOVE only for must_move, LIGHTNING LIVE for Lightning,
 *      JOIN LIGHTNING only for lightning, and a closed game for paused,
 *      frozen and dead.
 *
 * TablePage is far too large to mount, so its wiring is pinned at the source,
 * each window bounded by the structure it is about (tests/helpers/sourceWindow).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { sliceMethod } from '../helpers/sourceWindow';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const OTHER_CLUSTER = '55555555-5555-4555-8555-555555555555';
const OCCUPANCY = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';

const rpc = vi.fn();
const fromCalls: string[] = [];
let clusterRows: unknown[] = [];
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      fromCalls.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is']) chain[m] = () => chain;
      chain.limit = () => Promise.resolve({ data: clusterRows, error: null });
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const notifyLeave = vi.fn();
vi.mock('../../src/services/GameServerAPI', () => ({
  notifyServerLeaveOccupancy: (...a: unknown[]) => notifyLeave(...a),
  notifyServerKickOccupancy: vi.fn(),
}));

import {
  LIGHTNING_LEAVE_QUEUED_TEXT,
  fetchLightningAnchorSeat,
  findMyLightningRoom,
  getLightningEntryIntent,
  getLightningPoolSession,
  lightningAnchorSeat,
  lightningClusterIdOfSnapshot,
  lightningEntryDecision,
  parseLightningMySession,
  registerLightningPoolSession,
  resetLightningRegistryForTests,
  setLightningEntryIntent,
} from '../../src/lightning/lightningSession';
import {
  LIGHTNING_HANDOFF_MAX_WAIT_MS,
  LIGHTNING_HANDOFF_POLL_MS,
  LIGHTNING_JOINING_TEXT,
  lightningHandoffDelay,
  useLightningAnchorHandoff,
} from '../../src/lightning/useLightningAnchorHandoff';
import {
  LIGHTNING_NEXT_HAND_NOTICE_MS,
  LIGHTNING_NEXT_HAND_TEXT,
  isLightningIdleSnapshot,
  lightningFoldAvailability,
  lightningHandKey,
  lightningHandOnFelt,
} from '../../src/lightning/lightningHand';
import { lightningCapabilities } from '../../src/lightning/lightningCapabilities';
import {
  clusterModeDisplay,
  lightningLobbyBadge,
  parseLightningLobbyState,
} from '../../src/lightning/lightningLobby';
import { leaveSeatWithIntent } from '../../src/services/SeatLeaveIntent';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import LightningJoining from '../../src/components/table/LightningJoining';
import LightningNextHand from '../../src/components/table/LightningNextHand';

const ROOT = resolve(__dirname, '../..');
const PAGE = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');

const SESSION_WITH_ANCHOR = {
  pool_session_id: POOL,
  state: 'active',
  cluster_mode: 'lightning',
  stack: 200,
  in_hand: true,
  hand_id: 'h-1',
  anchor_table_id: ANCHOR,
  seat_number: 4,
  occupancy_id: OCCUPANCY,
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetLightningRegistryForTests();
  rpc.mockReset();
  notifyLeave.mockReset();
  fromCalls.length = 0;
  clusterRows = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── 1. Leave, cash out and add-on go to the anchor seat ────────────────────

describe('1. a Lightning room leaves and adds on through its anchor seat', () => {
  it('reads the anchor seat from fn_lightning_my_session, and only when every part is known', () => {
    const s = parseLightningMySession(SESSION_WITH_ANCHOR);
    expect(s).toMatchObject({ anchorTableId: ANCHOR, seatNumber: 4, occupancyId: OCCUPANCY });
    expect(lightningAnchorSeat(s)).toEqual({
      anchorTableId: ANCHOR,
      seatNumber: 4,
      occupancyId: OCCUPANCY,
    });
    for (const bad of [
      { anchor_table_id: 'nope' },
      { anchor_table_id: null },
      { seat_number: 0 },
      { seat_number: '2.5' },
      { occupancy_id: 'x' },
      { state: 'closed' },
      { pool_session_id: null },
    ]) {
      expect(
        lightningAnchorSeat(parseLightningMySession({ ...SESSION_WITH_ANCHOR, ...bad }))
      ).toBeNull();
    }
  });

  it('asks the database fresh for the anchor seat of the Cluster', async () => {
    rpc.mockResolvedValue({ data: SESSION_WITH_ANCHOR, error: null });
    await expect(fetchLightningAnchorSeat(CLUSTER)).resolves.toEqual({
      anchorTableId: ANCHOR,
      seatNumber: 4,
      occupancyId: OCCUPANCY,
    });
    expect(rpc).toHaveBeenCalledWith('fn_lightning_my_session', { p_cluster_id: CLUSTER });
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    await expect(fetchLightningAnchorSeat(CLUSTER)).rejects.toBeTruthy();
  });

  it('sends the leave to the anchor table, seat and occupancy, and a live hand defers it', async () => {
    notifyLeave.mockResolvedValue({
      success: true,
      protocol: 'seat-occupancy-v1',
      occupancyId: OCCUPANCY,
      seatNumber: 4,
      immediate: false,
      cashout: null,
    });
    const r = await leaveSeatWithIntent(ANCHOR, USER, { seatNumber: 4, occupancyId: OCCUPANCY });
    expect(notifyLeave).toHaveBeenCalledWith(ANCHOR, 4, OCCUPANCY);
    expect(fromCalls).not.toContain('table_seats');
    expect(r).toMatchObject({ success: true, deferred: true });
    expect(LIGHTNING_LEAVE_QUEUED_TEXT).toMatch(/Queued/);
    expect(LIGHTNING_LEAVE_QUEUED_TEXT).toMatch(/Hand Ends/);
  });

  it('TablePage: the menu leave and the tab X both resolve the anchor seat before cashing out', () => {
    const resolver = sliceMethod(PAGE, 'const resolveLightningLeave = async ()');
    expect(resolver).toContain('fetchMyLightningSession(room.clusterId)');
    expect(resolver).toContain('lightningAnchorSeat(session)');
    expect(resolver).toContain("return 'unreadable';");

    const leave = sliceMethod(PAGE, 'const handleLeaveTable = async () => {');
    expect(leave).toContain('await resolveLightningLeave()');
    expect(leave).toMatch(
      /tableService\.leaveTable\(leaveTableId, lightningLeave\.seatNumber, userId, \{/
    );
    expect(leave).toContain('occupancyId: lightningLeave.occupancyId');
    expect(leave).toMatch(/lightningLeave && result\.deferred[\s\S]*LIGHTNING_LEAVE_QUEUED_TEXT/);
    expect(leave).toContain('tableId: leaveTableId');
    // The resolver runs before the "nothing to cash out" door, which must
    // never let an open pool session leave without its cash out.
    expect(leave.indexOf('await resolveLightningLeave()')).toBeLessThan(
      leave.indexOf('leaveWithoutCashout(liveSeat)')
    );

    const force = sliceMethod(PAGE, 'const handleForceLeaveTable = async () => {');
    expect(force).toContain('await resolveLightningLeave()');
    expect(force).toMatch(
      /tableService\.leaveTable\(forceTableId, forceLightning\.seatNumber, userId, \{/
    );
    expect(force).toContain('tableId: forceTableId');
  });

  it('TablePage: an add-on from a Lightning room is addressed to the anchor table', () => {
    const addOn = sliceMethod(PAGE, 'const handleAddChips = async (');
    expect(addOn).toContain('fetchLightningAnchorSeat(addOnRoom.clusterId)');
    expect(addOn).toContain('GameServerAPI.addChips(addOnTableId, amount, opId)');
    expect(addOn).not.toContain('GameServerAPI.addChips(tableId,');
  });
});

// ─── 2. A room opened from a new tab or a shared link ───────────────────────

describe('2. a pool-session room is found before anything says it does not exist', () => {
  const cluster = (id: string, mode = 'lightning') => ({
    id,
    club_id: null,
    name: 'NLH 1/2 Classic',
    variant: 'nlh',
    sb: 1,
    bb: 2,
    handedness: 6,
    cluster_mode: mode,
    enabled: true,
  });

  it("finds the caller's own room among the Clusters that can hold one, and registers it", async () => {
    clusterRows = [cluster(OTHER_CLUSTER), cluster(CLUSTER, 'pending_off')];
    rpc.mockImplementation(async (_name: string, args: { p_cluster_id: string }) => ({
      data:
        args.p_cluster_id === CLUSTER
          ? { pool_session_id: POOL, state: 'active', cluster_mode: 'pending_off' }
          : { pool_session_id: null },
      error: null,
    }));
    const room = await findMyLightningRoom(POOL);
    expect(room?.clusterId).toBe(CLUSTER);
    expect(room?.meta?.name).toBe('NLH 1/2 Classic');
    expect(getLightningPoolSession(POOL)?.clusterId).toBe(CLUSTER);
    expect(fromCalls).toEqual(['cash_games']);
  });

  it('answers null for an id that is nobody of ours, and asks nothing for a bad id', async () => {
    clusterRows = [cluster(CLUSTER)];
    rpc.mockResolvedValue({ data: { pool_session_id: null }, error: null });
    await expect(findMyLightningRoom(ANCHOR)).resolves.toBeNull();
    expect(getLightningPoolSession(ANCHOR)).toBeNull();
    rpc.mockClear();
    fromCalls.length = 0;
    await expect(findMyLightningRoom('not-a-uuid')).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(fromCalls).toEqual([]);
  });

  it('a room this tab already knows is answered without a read', async () => {
    registerLightningPoolSession({ poolSessionId: POOL, clusterId: CLUSTER, meta: null });
    await expect(findMyLightningRoom(POOL)).resolves.toMatchObject({ clusterId: CLUSTER });
    expect(fromCalls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads the room's Cluster from the engine snapshot", () => {
    expect(lightningClusterIdOfSnapshot({ lightning: { cluster_id: CLUSTER } })).toBe(CLUSTER);
    expect(lightningClusterIdOfSnapshot({ lightning: { cluster_id: 'x' } })).toBeNull();
    expect(lightningClusterIdOfSnapshot({ lightning: null })).toBeNull();
    expect(lightningClusterIdOfSnapshot(null)).toBeNull();
  });

  it('TablePage: the lookup runs before a missing row is reported, and a room never shows the failure', () => {
    const boot = sliceMethod(PAGE, 'async function loadTableInfo() {');
    const lookup = boot.indexOf('findMyLightningRoom(tableId)');
    const failure = boot.indexOf("setTableLoadFailure(error ? 'unreachable' : 'missing')");
    expect(lookup).toBeGreaterThan(0);
    expect(lookup).toBeLessThan(failure);
    expect(PAGE).toContain('{tableLoadFailure && !lightningRoom && (');
    expect(PAGE).toContain('lightningClusterIdOfSnapshot(engineSnapshot)');
  });
});

// ─── 3. The JOIN LIGHTNING hand-off ─────────────────────────────────────────

describe('3. JOIN LIGHTNING keeps waiting, says so, and stops when told', () => {
  const noSession = { data: { pool_session_id: null, cluster_mode: 'lightning' }, error: null };

  it('waits longer each time, never more than the ceiling', () => {
    expect(lightningHandoffDelay(1)).toBe(LIGHTNING_HANDOFF_POLL_MS);
    expect(lightningHandoffDelay(2)).toBeGreaterThan(LIGHTNING_HANDOFF_POLL_MS);
    expect(lightningHandoffDelay(200)).toBe(LIGHTNING_HANDOFF_MAX_WAIT_MS);
  });

  it('keeps asking well past the old forty-ask limit, then follows the pool session', async () => {
    vi.useFakeTimers();
    setLightningEntryIntent(ANCHOR, CLUSTER);
    let asks = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name !== 'fn_lightning_my_session') return { data: null, error: null };
      asks += 1;
      return asks > 60
        ? { data: { pool_session_id: POOL, state: 'active' }, error: null }
        : noSession;
    });
    const follow = vi.fn();
    const { result } = renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.joining).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70 * LIGHTNING_HANDOFF_MAX_WAIT_MS);
    });
    expect(asks).toBe(61);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledWith(POOL);
    expect(result.current.joining).toBe(false);
    expect(getLightningEntryIntent(ANCHOR)).toBeNull();
  });

  it('stops on cancel: no more asks, the intent is forgotten', async () => {
    vi.useFakeTimers();
    setLightningEntryIntent(ANCHOR, CLUSTER);
    rpc.mockResolvedValue(noSession);
    const follow = vi.fn();
    const { result } = renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * LIGHTNING_HANDOFF_POLL_MS);
    });
    expect(result.current.joining).toBe(true);
    act(() => result.current.cancel());
    const asked = rpc.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * LIGHTNING_HANDOFF_MAX_WAIT_MS);
    });
    expect(rpc.mock.calls.length).toBe(asked);
    expect(result.current.joining).toBe(false);
    expect(getLightningEntryIntent(ANCHOR)).toBeNull();
    expect(follow).not.toHaveBeenCalled();
  });

  it('stops on unmount', async () => {
    vi.useFakeTimers();
    setLightningEntryIntent(ANCHOR, CLUSTER);
    rpc.mockResolvedValue(noSession);
    const { unmount } = renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow: vi.fn(),
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_HANDOFF_POLL_MS);
    });
    unmount();
    const asked = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * LIGHTNING_HANDOFF_MAX_WAIT_MS);
    expect(rpc.mock.calls.length).toBe(asked);
  });

  it('stops when the Cluster is not Lightning any more: no pool session is coming', async () => {
    vi.useFakeTimers();
    setLightningEntryIntent(ANCHOR, CLUSTER);
    rpc.mockResolvedValue({
      data: { pool_session_id: null, cluster_mode: 'must_move' },
      error: null,
    });
    const { result } = renderHook(() =>
      useLightningAnchorHandoff({
        tableId: ANCHOR,
        isPoolSession: false,
        heroBoughtIn: true,
        follow: vi.fn(),
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * LIGHTNING_HANDOFF_MAX_WAIT_MS);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.current.joining).toBe(false);
  });

  it('says "Joining Lightning..." with a way to stop waiting', () => {
    const onCancel = vi.fn();
    render(<LightningJoining onCancel={onCancel} />);
    expect(screen.getByTestId('lightning-joining').textContent).toContain(LIGHTNING_JOINING_TEXT);
    expect(LIGHTNING_JOINING_TEXT).toBe('Joining Lightning...');
    fireEvent.click(screen.getByTestId('lightning-joining-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('TablePage: the anchor table shows the joining state instead of a dead felt', () => {
    expect(PAGE).toContain('const lightningHandoff = useLightningAnchorHandoff({');
    expect(PAGE).toMatch(
      /\{lightningHandoff\.joining && !lightningRoom \? \(\s*<LightningJoining onCancel=\{lightningHandoff\.cancel\} \/>/
    );
  });
});

// ─── 4. The idle snapshot after a fold ──────────────────────────────────────

describe('4. the idle snapshot after a fold', () => {
  const IDLE = {
    stage: 'waiting',
    players: [],
    hand_id: null,
    hand_number: 41,
    lightning: { cluster_id: CLUSTER, fast_fold_available: false },
  };
  const LIVE = {
    stage: 'flop',
    players: [{ seat: 1 }],
    hand_id: 'h-42',
    lightning: { fast_fold_available: true },
  };
  const desktop = lightningCapabilities('desktop');

  it('is recognised as no hand on the felt', () => {
    expect(isLightningIdleSnapshot(IDLE)).toBe(true);
    expect(lightningHandKey(IDLE)).toBeNull();
    expect(lightningHandOnFelt(IDLE)).toBe(false);
    expect(isLightningIdleSnapshot({ ...IDLE, stage: 'preflop' })).toBe(true);
    expect(isLightningIdleSnapshot(LIVE)).toBe(false);
    expect(lightningHandOnFelt(LIVE)).toBe(true);
    expect(lightningHandKey(LIVE)).toBe('id:h-42');
  });

  it('LIGHTNING FOLD is off on it, whatever the folded hand left behind', () => {
    const leftover = {
      heroSeated: true,
      handInProgress: true,
      handSettling: false,
      heroStatus: 'active',
    };
    expect(
      lightningFoldAvailability(
        { ...leftover, engineFastFoldAvailable: false, handOnFelt: false },
        desktop
      )
    ).toEqual({ fastFold: false, foldWatch: false });
    expect(
      lightningFoldAvailability(
        { ...leftover, engineFastFoldAvailable: true, handOnFelt: false },
        desktop
      )
    ).toEqual({ fastFold: false, foldWatch: false });
    expect(
      lightningFoldAvailability(
        { ...leftover, engineFastFoldAvailable: null, handOnFelt: false },
        desktop
      )
    ).toEqual({ fastFold: false, foldWatch: false });
    expect(
      lightningFoldAvailability(
        { ...leftover, engineFastFoldAvailable: true, handOnFelt: true },
        desktop
      )
    ).toEqual({ fastFold: true, foldWatch: true });
  });

  it('"Next Hand..." appears on the usual threshold once the hand is gone, and not before', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<LightningNextHand handInProgress />);
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
    rerender(<LightningNextHand handInProgress={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_NEXT_HAND_NOTICE_MS - 100);
    });
    expect(screen.queryByTestId('lightning-next-hand')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByTestId('lightning-next-hand').textContent).toBe(LIGHTNING_NEXT_HAND_TEXT);
  });

  it('TablePage: the controls read the snapshot, and stay mounted (dimmed) between hands', () => {
    expect(PAGE).toContain('lightningHandOnFelt(engineSnapshot as LightningSnapshotFields)');
    expect(PAGE).toContain('handOnFelt: lightningHandLive,');
    expect(PAGE).toMatch(
      /\{lightningRoom && userId && userId !== 'guest' \? \(\s*<LightningFoldBar/
    );
    expect(PAGE).toMatch(
      /<LightningNextHand\s+handInProgress=\{lightningHandLive && tableState\.isHandInProgress\}/
    );
  });
});

// ─── 5. The lobby's words for each Cluster mode ─────────────────────────────

describe('5. the lobby says each Cluster mode truthfully', () => {
  const cardCtx = {
    seatedIds: new Set<string>(),
    waitlistedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    onJoinTable: () => {},
    onViewTable: () => {},
    onWaitlistToggle: () => {},
  } as unknown as LobbyRowContext;
  const actions = (e: ReturnType<typeof cashEntry>) => arenaGameCardActionsForEntry(e, cardCtx);
  const pool = (mode: string) =>
    parseLightningLobbyState({
      cluster_mode: mode,
      thresholds: { on: 18, off: 12 },
      verdict: { live_eligible: 20 },
    });
  const row = (mode: string): LobbyTableRow =>
    ({
      id: ANCHOR,
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
      cluster_lightning: pool(mode),
    }) as LobbyTableRow;
  const modeWords = (e: ReturnType<typeof cashEntry>) =>
    e.rules.map((r) => r.label).filter((l) => l === 'MUST MOVE' || l === 'LIGHTNING LIVE');

  it('the mode table', () => {
    expect(clusterModeDisplay('must_move')).toEqual({
      label: 'MUST MOVE',
      joinLightning: false,
      closedLabel: null,
    });
    expect(clusterModeDisplay('pending_on')).toEqual({
      label: 'MUST MOVE',
      joinLightning: false,
      closedLabel: null,
    });
    expect(clusterModeDisplay('lightning')).toEqual({
      label: 'LIGHTNING LIVE',
      joinLightning: true,
      closedLabel: null,
    });
    for (const m of ['pending_off', 'draining'])
      expect(clusterModeDisplay(m)).toEqual({
        label: 'LIGHTNING LIVE',
        joinLightning: false,
        closedLabel: null,
      });
    for (const m of ['paused', 'frozen'])
      expect(clusterModeDisplay(m)).toEqual({
        label: null,
        joinLightning: false,
        closedLabel: 'Paused',
      });
    expect(clusterModeDisplay('dead')).toEqual({
      label: null,
      joinLightning: false,
      closedLabel: 'Closed',
    });
  });

  it('must_move and pending_on: MUST MOVE and JOIN GAME', () => {
    for (const m of ['must_move', 'pending_on']) {
      const e = cashEntry(row(m));
      expect(modeWords(e), m).toEqual(['MUST MOVE']);
      expect(e.game?.lightning, m).toBeUndefined();
      expect(actions(e).primaryLabel, m).toBe('Join Game');
    }
  });

  it('lightning: LIGHTNING LIVE and JOIN LIGHTNING', () => {
    const e = cashEntry(row('lightning'));
    expect(modeWords(e)).toEqual(['LIGHTNING LIVE']);
    expect(e.game?.lightning).toEqual({ players: 20, status: 'ACTIVE' });
    expect(actions(e).primaryLabel).toBe('Join Lightning');
  });

  it('pending_off and draining: still LIGHTNING LIVE (THIN), but JOIN GAME, never JOIN LIGHTNING', () => {
    for (const m of ['pending_off', 'draining']) {
      const e = cashEntry(row(m));
      expect(modeWords(e), m).toEqual(['LIGHTNING LIVE']);
      expect(e.rules.find((r) => r.label === 'LIGHTNING LIVE')?.detail, m).toBe('THIN');
      expect(e.game?.lightning, m).toBeUndefined();
      expect(actions(e).primaryLabel, m).toBe('Join Game');
      expect(lightningLobbyBadge({ clusterMode: m, state: null, boardPlayers: 3 }).status).toBe(
        'THIN'
      );
    }
  });

  it('paused, frozen and dead: neither mode word nor any join, in the closed-game words', () => {
    for (const [m, word] of [
      ['paused', 'Paused'],
      ['frozen', 'Paused'],
      ['dead', 'Closed'],
    ] as const) {
      const e = cashEntry(row(m));
      expect(modeWords(e), m).toEqual([]);
      expect(e.status, m).toBe('closed');
      expect(e.statusLabel, m).toBe(word);
      expect(e.game?.lightning, m).toBeUndefined();
      const a = actions(e);
      expect(a.primaryLabel, m).toBe(`Game ${word}`);
      expect(a.primaryDisabled, m).toBe(true);
    }
  });

  it('the Lightning route offers JOIN LIGHTNING only while the mode is lightning', () => {
    const none = parseLightningMySession({ pool_session_id: null });
    const meta = (clusterMode: string) => ({
      clusterId: CLUSTER,
      clubId: null,
      name: 'x',
      variant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 6,
      clusterMode,
      enabled: true,
    });
    expect(lightningEntryDecision(none, meta('lightning'))).toMatchObject({
      joinLabel: 'Join Lightning',
    });
    for (const m of ['pending_on', 'pending_off', 'draining', 'must_move'])
      expect(lightningEntryDecision(none, meta(m)), m).toMatchObject({
        joinLabel: 'Join Game',
        lightning: false,
      });
  });
});
