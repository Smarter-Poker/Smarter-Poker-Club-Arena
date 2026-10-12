/**
 * LIGHTNING PHASE 6 (client): the pure rules behind one continuous stream of
 * hands in one room. Capability map, LIGHTNING FOLD / FOLD & WATCH
 * availability and payload, pre-action safety across a hand change, what the
 * felt prints for a pool session, the "Next Hand..." threshold, the lobby
 * card's states, and the route decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import {
  LIGHTNING_CAPABILITY_MAP,
  LIGHTNING_PLATFORMS,
  detectLightningPlatform,
  lightningCapabilities,
} from '../../src/lightning/lightningCapabilities';
import {
  LIGHTNING_NEXT_HAND_NOTICE_MS,
  lightningActionPayload,
  lightningFastFoldFlag,
  lightningFoldAvailability,
  lightningHandId,
  lightningHandKey,
  lightningSnapshotPatch,
  lightningTableSeed,
  nextHandNoticeDue,
  preActionBelongsToHand,
} from '../../src/lightning/lightningHand';
import { sendLightningFold } from '../../src/lightning/lightningActions';
import {
  isLightningMode,
  lightningClusterIdsOf,
  lightningLobbyBadge,
  lightningPoolStatus,
  parseLightningLobbyState,
  withLightningState,
} from '../../src/lightning/lightningLobby';
import {
  clearLightningEntryIntent,
  getLightningEntryIntent,
  getLightningPoolSession,
  hasLightningRoom,
  lightningEntryDecision,
  lightningRoomPath,
  parseLightningClusterMeta,
  parseLightningMySession,
  registerLightningPoolSession,
  resetLightningRegistryForTests,
  setLightningEntryIntent,
  type LightningClusterMeta,
} from '../../src/lightning/lightningSession';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';

const cardCtx = {
  seatedIds: new Set<string>(),
  waitlistedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  onJoinTable: () => {},
  onViewTable: () => {},
  onWaitlistToggle: () => {},
} as unknown as LobbyRowContext;
const joinLabel = (e: ReturnType<typeof cashEntry>) =>
  arenaGameCardActionsForEntry(e, cardCtx).primaryLabel;

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const META: LightningClusterMeta = {
  clusterId: CLUSTER,
  clubId: '44444444-4444-4444-8444-444444444444',
  name: 'nlh 1/2 classic',
  variant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  maxPlayers: 6,
  clusterMode: 'lightning',
  enabled: true,
};

describe('capability map', () => {
  it('has the seven switches on every platform, FOLD & WATCH desktop only by default', () => {
    for (const p of LIGHTNING_PLATFORMS) {
      expect(Object.keys(LIGHTNING_CAPABILITY_MAP[p]).sort()).toEqual(
        [
          'fast_fold',
          'fold_and_watch',
          'hotkeys',
          'multi_table',
          'replay',
          'session_stats',
          'sound',
        ].sort()
      );
      expect(LIGHTNING_CAPABILITY_MAP[p].fast_fold).toBe(true);
    }
    expect(LIGHTNING_CAPABILITY_MAP.desktop.fold_and_watch).toBe(true);
    expect(LIGHTNING_CAPABILITY_MAP.mobile_web.fold_and_watch).toBe(false);
    expect(LIGHTNING_CAPABILITY_MAP.ios.fold_and_watch).toBe(false);
    expect(LIGHTNING_CAPABILITY_MAP.android.fold_and_watch).toBe(false);
  });
  it('detects the platform from plain signals and falls back to the narrower row', () => {
    expect(detectLightningPlatform({ nativePlatform: 'ios' })).toBe('ios');
    expect(detectLightningPlatform({ nativePlatform: 'android' })).toBe('android');
    expect(detectLightningPlatform({ coarsePointer: true, viewportWidth: 1400 })).toBe(
      'mobile_web'
    );
    expect(detectLightningPlatform({ viewportWidth: 375 })).toBe('mobile_web');
    expect(detectLightningPlatform({ viewportWidth: 1400 })).toBe('desktop');
    expect(lightningCapabilities('toaster').fold_and_watch).toBe(false);
    const copy = lightningCapabilities('desktop');
    copy.fast_fold = false;
    expect(LIGHTNING_CAPABILITY_MAP.desktop.fast_fold).toBe(true);
  });
});

describe('LIGHTNING FOLD availability and payload', () => {
  const desktop = lightningCapabilities('desktop');
  const phone = lightningCapabilities('mobile_web');
  const live = {
    heroSeated: true,
    handInProgress: true,
    handSettling: false,
    heroStatus: 'active',
  };
  it('is available whenever folding is, including before the hero acts', () => {
    expect(lightningFoldAvailability(live, desktop)).toEqual({ fastFold: true, foldWatch: true });
    expect(lightningFoldAvailability(live, phone)).toEqual({ fastFold: true, foldWatch: false });
  });
  it('is not available when folding is not', () => {
    for (const bad of [
      { ...live, heroSeated: false },
      { ...live, handInProgress: false },
      { ...live, handSettling: true },
      { ...live, heroStatus: 'folded' },
      { ...live, heroStatus: 'all_in' },
      { ...live, heroStatus: 'sitting_out' },
    ]) {
      expect(lightningFoldAvailability(bad, desktop)).toEqual({
        fastFold: false,
        foldWatch: false,
      });
    }
  });
  it("follows the engine's fast_fold_available flag when the snapshot carries it", () => {
    expect(lightningFastFoldFlag({ lightning: { fast_fold_available: true } })).toBe(true);
    expect(lightningFastFoldFlag({ lightning: { fast_fold_available: false } })).toBe(false);
    expect(lightningFastFoldFlag({ lightning: {} })).toBeNull();
    expect(lightningFastFoldFlag({ hand_number: 3 })).toBeNull();
    // Before the hero's turn with no bet to face: the engine says no, so the button is off.
    expect(lightningFoldAvailability({ ...live, engineFastFoldAvailable: false }, desktop)).toEqual(
      {
        fastFold: false,
        foldWatch: false,
      }
    );
    // The engine says yes: on, and FOLD & WATCH still only where the capability allows.
    const quiet = { ...live, heroStatus: 'folded', engineFastFoldAvailable: true };
    expect(lightningFoldAvailability(quiet, desktop)).toEqual({ fastFold: true, foldWatch: true });
    expect(lightningFoldAvailability(quiet, phone)).toEqual({ fastFold: true, foldWatch: false });
    expect(lightningFoldAvailability({ ...quiet, heroSeated: false }, desktop)).toEqual({
      fastFold: false,
      foldWatch: false,
    });
    // Absent flag: the local rule.
    expect(lightningFoldAvailability({ ...live, engineFastFoldAvailable: null }, desktop)).toEqual({
      fastFold: true,
      foldWatch: true,
    });
  });
  it('posts to the pool session room with the two new action names', async () => {
    expect(lightningActionPayload(POOL, 'fast_fold')).toEqual({
      tableId: POOL,
      action: 'fast_fold',
      amount: 0,
    });
    expect(lightningActionPayload(POOL, 'fold_watch')).toEqual({
      tableId: POOL,
      action: 'fold_watch',
      amount: 0,
    });
    const send = vi.fn(async () => ({ success: true }));
    await sendLightningFold(POOL, 'user-1', 'fast_fold', send);
    expect(send).toHaveBeenCalledWith(POOL, 'user-1', 'fast_fold', 0);
  });
});

describe('pre-action safety across hands', () => {
  it('keys a hand by the engine hand id, else the hand number', () => {
    expect(lightningHandKey({ hand_id: 'h-1', hand_number: 9 })).toBe('id:h-1');
    expect(lightningHandKey({ lightning: { hand_id: 'h-2' } })).toBe('id:h-2');
    expect(lightningHandKey({ hand_number: 9 })).toBe('n:9');
    expect(lightningHandKey({ hand_number: 0 })).toBeNull();
    expect(lightningHandId({ hand_number: 9 })).toBeNull();
  });
  it('an arm survives only on the hand it was made in', () => {
    expect(preActionBelongsToHand('id:h-1', 'id:h-1')).toBe(true);
    expect(preActionBelongsToHand('id:h-1', 'id:h-2')).toBe(false);
    expect(preActionBelongsToHand('id:h-1', null)).toBe(false);
    expect(preActionBelongsToHand(null, 'id:h-1')).toBe(false);
    expect(preActionBelongsToHand(null, null)).toBe(false);
  });
});

describe('a pool session felt is described from the Cluster and the snapshot', () => {
  it('seeds from the Cluster row', () => {
    const seed = lightningTableSeed(META);
    expect(seed.blinds).toBe('1/2');
    expect(seed.gameType).toBe('nlh');
    expect(seed.maxPlayers).toBe(6);
    expect(seed.minBuyIn).toBe(80);
    expect(seed.maxBuyIn).toBe(400);
    expect(seed.isTournament).toBe(false);
    expect(seed.tableName.length).toBeGreaterThan(0);
  });
  it('the snapshot wins with the fields it carries, and nothing else', () => {
    expect(lightningSnapshotPatch({ hand_number: 3 })).toEqual({});
    expect(
      lightningSnapshotPatch({ lightning: { small_blind: 2, big_blind: 5, variant: 'plo4' } })
    ).toEqual({ blinds: '2/5', gameType: 'plo4' });
  });
});

describe('Next Hand...', () => {
  it('says nothing inside the threshold and nothing during a hand', () => {
    expect(
      nextHandNoticeDue({
        handInProgress: false,
        quietSinceMs: 0,
        nowMs: LIGHTNING_NEXT_HAND_NOTICE_MS - 1,
      })
    ).toBe(false);
    expect(
      nextHandNoticeDue({
        handInProgress: false,
        quietSinceMs: 0,
        nowMs: LIGHTNING_NEXT_HAND_NOTICE_MS,
      })
    ).toBe(true);
    expect(nextHandNoticeDue({ handInProgress: true, quietSinceMs: 0, nowMs: 99_999 })).toBe(false);
    expect(nextHandNoticeDue({ handInProgress: false, quietSinceMs: null, nowMs: 99_999 })).toBe(
      false
    );
  });
});

describe('lobby card states', () => {
  const st = (live: number | null, mode = 'lightning') =>
    parseLightningLobbyState({
      cluster_mode: mode,
      thresholds: { on: 18, off: 12 },
      verdict: { live_eligible: live },
    });
  it('maps the pool to BUILDING / ACTIVE / HOT / THIN', () => {
    expect(lightningPoolStatus(null)).toBe('BUILDING');
    expect(lightningPoolStatus(st(null))).toBe('BUILDING');
    expect(lightningPoolStatus(st(12))).toBe('THIN');
    expect(lightningPoolStatus(st(15))).toBe('BUILDING');
    expect(lightningPoolStatus(st(18))).toBe('ACTIVE');
    expect(lightningPoolStatus(st(36))).toBe('HOT');
    expect(lightningPoolStatus(st(30, 'pending_off'))).toBe('THIN');
  });
  it('says LIGHTNING LIVE only in Lightning modes and MUST MOVE otherwise', () => {
    expect(isLightningMode('lightning')).toBe(true);
    expect(isLightningMode('pending_off')).toBe(true);
    expect(isLightningMode('draining')).toBe(true);
    for (const m of ['must_move', 'pending_on', null, undefined])
      expect(isLightningMode(m)).toBe(false);
    expect(lightningLobbyBadge({ clusterMode: 'must_move', state: null, boardPlayers: 4 })).toEqual(
      {
        mode: 'must_move',
        label: 'MUST MOVE',
        players: 4,
        status: null,
        joinLightning: false,
        closedLabel: null,
      }
    );
    expect(
      lightningLobbyBadge({ clusterMode: 'lightning', state: st(20), boardPlayers: 4 })
    ).toEqual({
      mode: 'lightning',
      label: 'LIGHTNING LIVE',
      players: 20,
      status: 'ACTIVE',
      joinLightning: true,
      closedLabel: null,
    });
  });

  const row = (over: Partial<LobbyTableRow>): LobbyTableRow =>
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
      ...over,
    }) as LobbyTableRow;

  it('a must-move card is untouched: MUST MOVE medallion, Join Game, no lightning', () => {
    const e = cashEntry(row({ cluster_mode: 'must_move' }));
    expect(e.rules[0].label).toBe('MUST MOVE');
    expect(e.game?.lightning).toBeUndefined();
    expect(joinLabel(e)).toBe('Join Game');
    const legacy = cashEntry(row({}));
    expect({ ...legacy, raw: null }).toEqual({ ...e, raw: null });
  });
  it('a Lightning card says LIGHTNING LIVE, its pool count and status, and Join Lightning', () => {
    const e = cashEntry(row({ cluster_mode: 'lightning', cluster_lightning: st(40) }));
    expect(e.rules[0]).toMatchObject({
      key: 'lightning_live',
      label: 'LIGHTNING LIVE',
      detail: 'HOT',
    });
    expect(e.players).toBe(40);
    expect(e.capacity).toBe(0);
    expect(e.game?.lightning).toEqual({ players: 40, status: 'HOT' });
    expect(joinLabel(e)).toBe('Join Lightning');
    expect(arenaGameCardActionsForEntry(e, cardCtx).secondaryLabel).toBe('View Game');
  });
  it('the board asks for Lightning state only for Lightning Clusters, and leaves other rows identical', () => {
    const mm = row({ cluster_mode: 'must_move' });
    const lt = row({ id: POOL, cluster_id: POOL, cluster_mode: 'lightning' });
    expect(lightningClusterIdsOf([mm, row({})])).toEqual([]);
    expect(lightningClusterIdsOf([mm, lt, lt])).toEqual([POOL]);
    const out = withLightningState([mm, lt], { [POOL]: st(20) });
    expect(out[0]).toBe(mm);
    expect(out[1].cluster_lightning?.liveEligible).toBe(20);
  });
});

describe('route decision and the pool-session registry', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetLightningRegistryForTests();
  });
  it('reads fn_lightning_my_session defensively', () => {
    const s = parseLightningMySession({
      pool_session_id: POOL,
      state: 'active',
      cluster_mode: 'lightning',
      stack: '200.00',
      in_hand: true,
      hand_id: 'h',
    });
    expect(s).toEqual({
      poolSessionId: POOL,
      state: 'active',
      clusterMode: 'lightning',
      stack: 200,
      inHand: true,
      handId: 'h',
      anchorTableId: null,
      seatNumber: null,
      occupancyId: null,
      seatTableId: null,
    });
    expect(parseLightningMySession(null).poolSessionId).toBeNull();
    expect(parseLightningMySession({ pool_session_id: 'not-a-uuid' }).poolSessionId).toBeNull();
    expect(hasLightningRoom({ ...s, state: 'closed' })).toBe(false);
    expect(
      parseLightningClusterMeta({ id: CLUSTER, sb: '1.00', bb: '2.00', handedness: 9 })?.maxPlayers
    ).toBe(9);
  });
  it('opens the room when a session is present, shows the entry when it is absent', () => {
    const present = parseLightningMySession({ pool_session_id: POOL, state: 'active' });
    expect(lightningEntryDecision(present, META)).toEqual({ kind: 'open', poolSessionId: POOL });
    const absent = parseLightningMySession({ pool_session_id: null, cluster_mode: 'lightning' });
    expect(lightningEntryDecision(absent, null)).toEqual({
      kind: 'entry',
      joinLabel: 'Join Lightning',
      lightning: true,
    });
    expect(lightningEntryDecision(absent, { ...META, clusterMode: 'must_move' })).toEqual({
      kind: 'entry',
      joinLabel: 'Join Game',
      lightning: false,
    });
    expect(lightningRoomPath(POOL, META)).toBe(
      `/table/${POOL}?name=nlh+1%2F2+classic&stakes=1%2F2`
    );
  });
  it('remembers pool-session rooms across a reload, and only real ids', () => {
    expect(getLightningPoolSession(POOL)).toBeNull();
    registerLightningPoolSession({ poolSessionId: POOL, clusterId: CLUSTER, meta: META });
    registerLightningPoolSession({ poolSessionId: 'nope', clusterId: CLUSTER, meta: null });
    resetLightningRegistryForTests();
    expect(getLightningPoolSession(POOL)?.clusterId).toBe(CLUSTER);
    expect(getLightningPoolSession(ANCHOR)).toBeNull();
  });
  it('keeps a JOIN LIGHTNING intent for the anchor table only, and only for a while', () => {
    setLightningEntryIntent(ANCHOR, CLUSTER, 1_000);
    expect(getLightningEntryIntent(ANCHOR, 2_000)).toBe(CLUSTER);
    expect(getLightningEntryIntent(POOL, 2_000)).toBeNull();
    expect(getLightningEntryIntent(ANCHOR, 1_000 + 15 * 60_000)).toBeNull();
    clearLightningEntryIntent(ANCHOR);
    expect(getLightningEntryIntent(ANCHOR, 2_000)).toBeNull();
  });
});
