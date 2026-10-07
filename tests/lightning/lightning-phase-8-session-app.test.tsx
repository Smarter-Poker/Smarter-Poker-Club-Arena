/**
 * LIGHTNING PHASE 8 (client): several Lightning Clusters at once with a
 * decision queue that never moves the view (CLAUDE.md 10.6), the Session
 * panel, the pool health badge, the session summary, Recent Hands and the
 * previous-hand replay, and warm-resume preferences that never spend.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const POOL = '11111111-1111-4111-8111-111111111111';
const POOL_B = '11111111-1111-4111-8111-222222222222';
const POOL_C = '11111111-1111-4111-8111-333333333333';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const CLUSTER_B = '22222222-2222-4222-8222-333333333333';
const CLUSTER_C = '22222222-2222-4222-8222-444444444444';
const HH = '44444444-4444-4444-8444-444444444444';
const HH_2 = '44444444-4444-4444-8444-555555555555';

const rpc = vi.fn();
const gameRow: Record<string, unknown> = {
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
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'limit']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: gameRow, error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));
vi.mock('../../src/components/replay/HandReplay', () => ({
  default: ({ handId }: { handId: string }) => <div data-testid="hand-replay">{handId}</div>,
}));
let serverClock = 1_000_000;
vi.mock('../../src/utils/serverClock', () => ({
  serverNow: () => serverClock,
  noteServerTime: () => undefined,
  recordServerTime: () => undefined,
  clockOffsetMs: () => 0,
  __resetServerClock: () => undefined,
}));

import {
  LIGHTNING_CAPABILITY_MAP,
  LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS,
  lightningDeviceClass,
  lightningMultiTableLimit,
} from '../../src/lightning/lightningCapabilities';
import {
  lightningDeviceFor,
  resetLightningDeviceReportForTests,
  withLightningDevice,
} from '../../src/lightning/lightningDeviceReport';
import {
  lightningDecisions,
  lightningUrgencyByRoom,
  noteLightningUserEvent,
  pruneLightningDecisions,
  resetLightningDecisionsForTests,
} from '../../src/lightning/lightningDecisionQueue';
import {
  parseLightningMySessions,
  parseLightningPoolHealth,
  parseLightningRecentHands,
  parseLightningSessionStats,
  parseLightningSessionSummary,
} from '../../src/lightning/lightningSessionApi';
import {
  LIGHTNING_PREFS_STORAGE_KEY,
  readLightningPrefs,
  writeLightningPrefs,
} from '../../src/lightning/lightningPrefs';
import {
  registerLightningPoolSession,
  resetLightningRegistryForTests,
} from '../../src/lightning/lightningSession';
import { lightningLobbyBadge } from '../../src/lightning/lightningLobby';
import {
  openLightningSessionSummary,
  closeLightningSessionSummary,
} from '../../src/lightning/lightningSummaryStore';
import LightningDecisionQueue from '../../src/components/lightning/LightningDecisionQueue';
import LightningRoomTools from '../../src/components/lightning/LightningRoomTools';
import LightningRecentHands from '../../src/components/lightning/LightningRecentHands';
import { lightningStatRows } from '../../src/components/lightning/LightningStatsGrid';
import { LightningSessionSummaryHost } from '../../src/components/lightning/LightningSessionSummary';
import LightningEndedNotice from '../../src/components/table/LightningEndedNotice';
import LightningEntryPage from '../../src/pages/LightningEntryPage';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const STATS = {
  hands: 120,
  hands_per_hour: 240,
  duration_s: 1800,
  starting_stack: 200,
  current_stack: 260.5,
  net: 60.5,
  bb_per_100: 25.2,
  vpip: 22,
  pfr: 17,
  avg_pot: 14,
  showdowns: 9,
  fast_folds: 70,
  normal_folds: 10,
  fold_and_watch: 3,
  avg_wait_ms: 1500,
  p95_wait_ms: 4200,
  p99_wait_ms: 6000,
  started_at: '2026-10-07T10:00:00Z',
  ended_at: null,
};

const HANDS = [
  {
    hand_id: 'h-2',
    hand_history_id: HH_2,
    hand_number: 2,
    played_at: '2026-10-07T10:02:00Z',
    cluster_id: CLUSTER,
    small_blind: 1,
    big_blind: 2,
    position: 'bb',
    stack_before: 210,
    stack_after: 230,
    net: 20,
    pot: 40,
    fold_type: null,
    showdown: true,
    result: 'won',
  },
  {
    hand_id: 'h-1',
    hand_history_id: null,
    hand_number: 1,
    played_at: '2026-10-07T10:01:00Z',
    cluster_id: CLUSTER,
    small_blind: 1,
    big_blind: 2,
    position: 'co',
    stack_before: 210,
    stack_after: 210,
    net: 0,
    pot: 3,
    fold_type: 'fast',
    showdown: false,
    result: 'folded',
  },
];

function defaultRpc(name: string): { data: unknown; error: null } {
  switch (name) {
    case 'fn_lightning_session_stats':
      return { data: STATS, error: null };
    case 'fn_lightning_session_summary':
      return { data: { ...STATS, ended: true, exit_reason: 'left' }, error: null };
    case 'fn_lightning_pool_status':
      return { data: { cluster_mode: 'lightning', players: 31, status: 'HOT' }, error: null };
    case 'fn_lightning_recent_hands':
      return { data: HANDS, error: null };
    case 'fn_lightning_my_sessions':
      return { data: [], error: null };
    default:
      return { data: null, error: null };
  }
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => defaultRpc(name));
  sessionStorage.clear();
  localStorage.clear();
  resetLightningRegistryForTests();
  resetLightningDecisionsForTests();
  resetLightningDeviceReportForTests('desktop');
  closeLightningSessionSummary();
  serverClock = 1_000_000;
  toast.info.mockReset();
  toast.warning.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const moneyRpcs = () =>
  rpc.mock.calls
    .map(([n]) => String(n))
    .filter((n) => /join|buy|debit|credit|wallet|cash_out|cashout|add_on/i.test(n));

// ─── 1. Device class, limits, and what the socket reports ──────────────────

describe('device class and Cluster limit', () => {
  it('desktop unless held; a held device is a tablet by its shorter side', () => {
    expect(lightningDeviceClass({ viewportWidth: 700, viewportHeight: 900 })).toBe('desktop');
    expect(
      lightningDeviceClass({ coarsePointer: true, viewportWidth: 390, viewportHeight: 844 })
    ).toBe('mobile');
    expect(
      lightningDeviceClass({ coarsePointer: true, viewportWidth: 1024, viewportHeight: 768 })
    ).toBe('tablet');
    expect(
      lightningDeviceClass({ nativePlatform: 'ios', viewportWidth: 834, viewportHeight: 1194 })
    ).toBe('tablet');
    expect(lightningDeviceClass({ nativePlatform: 'android' })).toBe('mobile');
  });
  it('limits default to 4 / 3 / 2 and handhelds may multi-table', () => {
    expect(LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS).toEqual({ desktop: 4, tablet: 3, mobile: 2 });
    expect(lightningMultiTableLimit('toaster')).toBe(2);
    expect(LIGHTNING_CAPABILITY_MAP.mobile_web.multi_table).toBe(true);
    expect(LIGHTNING_CAPABILITY_MAP.ios.multi_table).toBe(true);
  });
  it('only a Lightning room reports the device, on the URL or the SUBSCRIBE', () => {
    resetLightningDeviceReportForTests('tablet');
    const url = 'wss://engine/ws/table/' + POOL + '?v=1';
    expect(withLightningDevice(url, POOL)).toBe(url);
    expect(lightningDeviceFor(POOL)).toBeNull();
    registerLightningPoolSession({ poolSessionId: POOL, clusterId: CLUSTER, meta: null });
    expect(withLightningDevice(url, POOL)).toBe(url + '&p=tablet');
    expect(lightningDeviceFor(POOL)).toBe('tablet');
    expect(lightningDeviceFor(POOL_B)).toBeNull();
    const mux = read('src/services/EngineSocketMux.ts');
    const send = sliceEnclosingBlock(mux, 'const platform = lightningDeviceFor(tableId);');
    expect(send).toContain("{ type: 'SUBSCRIBE', tableId, platform }");
    expect(send).toContain("{ type: 'SUBSCRIBE', tableId }");
    expect(read('src/services/EngineStateClient.ts')).toMatch(
      /withLightningDevice\(\s*engineSocketUrl\(this\.opts\.baseUrl, '\/ws\/table\/' \+ this\.opts\.tableId\),\s*this\.opts\.tableId\s*\)/
    );
  });
});

// ─── 2. The decision queue ─────────────────────────────────────────────────

const decision = (room: string, hand: string, deadline: number, street = 'flop') => ({
  type: 'lightning_decision',
  pool_session_id: room,
  hand_id: hand,
  street,
  time_remaining_ms: deadline - serverClock,
  deadline_at: deadline,
  urgency: 'normal',
});

describe('the decision queue store', () => {
  it('one entry per hand however many rooms announce it, soonest first, retracted once', () => {
    expect(noteLightningUserEvent({ kind: 'hole_cards' })).toBe(false);
    expect(noteLightningUserEvent(decision(POOL, 'a', serverClock + 12_000))).toBe(true);
    expect(noteLightningUserEvent(decision(POOL, 'a', serverClock + 12_000))).toBe(true);
    noteLightningUserEvent(decision(POOL_B, 'b', serverClock + 4_000, 'river'));
    expect(lightningDecisions().map((d) => d.handId)).toEqual(['b', 'a']);
    expect(lightningUrgencyByRoom(lightningDecisions(), serverClock)).toEqual({
      [POOL_B]: 'critical',
      [POOL]: 'normal',
    });
    noteLightningUserEvent({
      type: 'lightning_decision_cleared',
      pool_session_id: POOL_B,
      hand_id: 'b',
    });
    expect(lightningDecisions().map((d) => d.handId)).toEqual(['a']);
    // A retraction lost on a dropped socket: the entry expires on the engine clock.
    pruneLightningDecisions(serverClock + 16_000);
    expect(lightningDecisions()).toEqual([]);
  });

  it('the socket client consumes decision frames before they reach the table state', () => {
    const client = read('src/services/EngineStateClient.ts');
    const branch = sliceEnclosingBlock(client, 'if (noteLightningUserEvent(msg.payload)) return;');
    expect(branch.indexOf('noteLightningUserEvent(msg.payload)')).toBeLessThan(
      branch.indexOf('this.opts.onUserEvent(msg.payload)')
    );
  });
});

describe('the decision queue strip (CLAUDE.md 10.6)', () => {
  it('lists other rooms by time left, and focuses one ONLY on a tap', () => {
    vi.useFakeTimers();
    registerLightningPoolSession({
      poolSessionId: POOL_B,
      clusterId: CLUSTER_B,
      meta: {
        ...(gameRow as never),
        clusterId: CLUSTER_B,
        name: 'PLO 2/5',
        smallBlind: 2,
        bigBlind: 5,
        maxPlayers: 6,
        variant: 'plo',
        clubId: null,
        clusterMode: 'lightning',
        enabled: true,
      },
    });
    noteLightningUserEvent(decision(POOL, 'here', serverClock + 3_000));
    noteLightningUserEvent(decision(POOL_C, 'c', serverClock + 14_000));
    noteLightningUserEvent(decision(POOL_B, 'b', serverClock + 8_000));
    const onFocus = vi.fn();
    render(<LightningDecisionQueue activeRoomId={POOL} onFocus={onFocus} />);
    const items = screen.getAllByTestId('lightning-decision');
    expect(items.map((i) => i.getAttribute('data-room'))).toEqual([POOL_B, POOL_C]);
    expect(items[0].textContent).toContain('PLO 2/5');
    expect(items[0].getAttribute('data-urgency')).toBe('high');
    // The clocks run down to critical and past: nothing focuses anything.
    for (let i = 0; i < 20; i++) {
      serverClock += 1_000;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(onFocus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lightning-decision')).toBeNull();
    act(() => {
      noteLightningUserEvent(decision(POOL_C, 'c2', serverClock + 9_000));
    });
    fireEvent.click(screen.getByTestId('lightning-decision'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(POOL_C);
  });

  it('MultiTablePage moves to a room only from the queue entry handler, as a tab select', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    const handler = sliceEnclosingBlock(multi, 'handleTabSelect(roomId);');
    expect(handler).not.toMatch(/setActiveIndex|useEffect|setTimeout|setInterval/);
    const mount = sliceEnclosingBlock(multi, '<LightningDecisionQueue');
    expect(mount).toContain('onFocus={handleLightningFocus}');
    // The strip component itself never navigates or selects.
    const strip = read('src/components/lightning/LightningDecisionQueue.tsx');
    expect(strip).not.toMatch(/navigate\(|setActiveIndex|handleTabSelect/);
    expect(strip.match(/onFocus\(/g)).toHaveLength(1);
  });
});

// ─── 3. The database answers ───────────────────────────────────────────────

describe('parsing the Lightning session RPCs', () => {
  it('reads every field, and an unknown is null, never a zero', () => {
    const s = parseLightningSessionStats(STATS)!;
    expect(s).toMatchObject({ hands: 120, net: 60.5, vpip: 22, p95WaitMs: 4200, fastFolds: 70 });
    const bare = parseLightningSessionStats({ hands: 3 })!;
    expect(bare.vpip).toBeNull();
    expect(bare.net).toBeNull();
    expect(parseLightningSessionStats({ net: 4 })).toBeNull();
    expect(
      parseLightningSessionSummary([{ ...STATS, ended: true, exit_reason: 'left' }])
    ).toMatchObject({
      ended: true,
      exitReason: 'left',
    });
    expect(
      parseLightningPoolHealth({ status: 'hot', players: '12', cluster_mode: 'lightning' })
    ).toEqual({
      status: 'HOT',
      players: 12,
      clusterMode: 'lightning',
    });
    expect(parseLightningPoolHealth({ status: 'WARM' })).toBeNull();
    const mine = parseLightningMySessions([
      {
        pool_session_id: POOL,
        cluster_id: CLUSTER,
        name: 'A',
        small_blind: 1,
        big_blind: 2,
        stack: 100,
        in_hand: true,
      },
      { pool_session_id: POOL_B, cluster_id: CLUSTER_B, name: 'B', stakes: '2/5' },
      // The migration's shape: stakes as an object.
      { pool_session_id: POOL_C, cluster_id: CLUSTER_C, name: 'C', stakes: { sb: 0.5, bb: 1 } },
      { pool_session_id: 'nope', cluster_id: CLUSTER },
    ]);
    expect(mine.map((m) => [m.stakes, m.bigBlind, m.inHand])).toEqual([
      ['1/2', 2, true],
      ['2/5', 5, false],
      ['0.5/1', 1, false],
    ]);
    const hands = parseLightningRecentHands(HANDS);
    expect(hands.map((h) => [h.handHistoryId, h.foldType])).toEqual([
      [HH_2, null],
      [null, 'fast'],
    ]);
  });

  it('the stat rows: VPIP and PFR only when known, LIGHTNING FOLD by name, waits in the room only', () => {
    const s = parseLightningSessionStats(STATS)!;
    const session = lightningStatRows(s, 'session').map((r) => r.label);
    expect(session).toEqual([
      'Hands',
      'Duration',
      'Hands / Hour',
      'Starting Stack',
      'Current Stack',
      'Net',
      'BB / 100',
      'VPIP',
      'PFR',
      'Showdowns',
      'LIGHTNING FOLD',
      'Average Wait',
      'P95 Wait',
    ]);
    const summary = lightningStatRows({ ...s, vpip: null, pfr: null }, 'summary').map(
      (r) => r.label
    );
    expect(summary).toContain('Ending Stack');
    expect(summary).not.toContain('VPIP');
    expect(summary).not.toContain('P95 Wait');
  });

  it('the lobby card prefers the pool status the database names', () => {
    const badge = lightningLobbyBadge({
      clusterMode: 'lightning',
      state: {
        clusterMode: 'lightning',
        liveEligible: 3,
        onThreshold: 10,
        offThreshold: 2,
        poolStatus: 'HOT',
        poolPlayers: 40,
      },
      boardPlayers: 0,
    });
    expect(badge.status).toBe('HOT');
    expect(badge.players).toBe(40);
  });
});

// ─── 4. The room's tools ───────────────────────────────────────────────────

const callsTo = (fn: string) => rpc.mock.calls.filter(([n]) => n === fn);

describe('the Lightning room tools', () => {
  it('Session reads once per new hand while open, never between hands, and is remembered', async () => {
    const view = render(
      <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey="id:h1" visible />
    );
    expect((await screen.findByTestId('lightning-pool-badge')).getAttribute('data-status')).toBe(
      'HOT'
    );
    expect(callsTo('fn_lightning_session_stats')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('lightning-session-toggle'));
    await screen.findByTestId('lightning-stats-session');
    expect(callsTo('fn_lightning_session_stats')).toEqual([
      ['fn_lightning_session_stats', { p_pool_session_id: POOL }],
    ]);
    expect(readLightningPrefs().statsVisible).toBe(true);
    // Between hands (null key) nothing is read; the next hand reads once.
    view.rerender(
      <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey={null} visible />
    );
    view.rerender(
      <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey="id:h2" visible />
    );
    await waitFor(() => expect(callsTo('fn_lightning_session_stats')).toHaveLength(2));
    expect(screen.getByText('LIGHTNING FOLD')).toBeTruthy();
    expect(screen.getByText('P95 Wait')).toBeTruthy();
    expect(moneyRpcs()).toEqual([]);
  });

  it('Previous Hand opens the existing replay for the last hand of this session', async () => {
    render(<LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey={null} visible />);
    fireEvent.click(screen.getByTestId('lightning-previous-hand'));
    expect((await screen.findByTestId('hand-replay')).textContent).toBe(HH_2);
    expect(callsTo('fn_lightning_recent_hands')[0][1]).toEqual({
      p_limit: 1,
      p_pool_session_id: POOL,
    });
    fireEvent.click(screen.getByTestId('lightning-replay-close'));
    expect(screen.queryByTestId('hand-replay')).toBeNull();
  });

  it('the pool badge is not polled while the room is off screen', async () => {
    render(
      <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey={null} visible={false} />
    );
    await Promise.resolve();
    expect(callsTo('fn_lightning_pool_status')).toHaveLength(0);
  });
});

describe('Recent Hands', () => {
  it('lists the session, toggles to all Lightning, and opens only written hands', async () => {
    render(<LightningRecentHands poolSessionId={POOL} />);
    const rows = await screen.findAllByTestId('lightning-recent-row');
    expect(callsTo('fn_lightning_recent_hands')[0][1]).toEqual({
      p_limit: 50,
      p_pool_session_id: POOL,
    });
    expect(rows[1].textContent).toContain('LIGHTNING FOLD');
    expect(rows[1].textContent).toContain('Replay Not Ready');
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    expect(rows[0].textContent).toContain('BB');
    expect(rows[0].textContent).toContain('210 to 230');
    fireEvent.click(rows[0]);
    expect((await screen.findByTestId('hand-replay')).textContent).toBe(HH_2);
    fireEvent.click(screen.getByTestId('lightning-recent-all'));
    await waitFor(() =>
      expect(callsTo('fn_lightning_recent_hands').at(-1)?.[1]).toEqual({
        p_limit: 50,
        p_pool_session_id: null,
      })
    );
  });
});

// ─── 5. The session summary ────────────────────────────────────────────────

function LobbyProbe() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

describe('the session summary', () => {
  it('opens over the lobby, VIEW SESSION shows its hands, PLAY AGAIN only goes to the entry', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LightningSessionSummaryHost />
        <Routes>
          <Route path="*" element={<LobbyProbe />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByTestId('lightning-summary-host')).toBeNull();
    act(() =>
      openLightningSessionSummary({
        poolSessionId: POOL,
        clusterId: CLUSTER,
        name: 'NLH 1/2 Classic',
      })
    );
    await screen.findByTestId('lightning-stats-summary');
    expect(callsTo('fn_lightning_session_summary')[0][1]).toEqual({ p_pool_session_id: POOL });
    expect(screen.getByText('Ending Stack')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'VIEW SESSION' }));
    await screen.findAllByTestId('lightning-recent-row');
    expect(callsTo('fn_lightning_recent_hands')[0][1]).toEqual({
      p_limit: 50,
      p_pool_session_id: POOL,
    });
    fireEvent.click(screen.getByRole('button', { name: 'PLAY AGAIN' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(`/lightning/${CLUSTER}`)
    );
    expect(screen.queryByTestId('lightning-summary-host')).toBeNull();
    expect(moneyRpcs()).toEqual([]);
    expect(readLightningPrefs().lastClusterId).toBe(CLUSTER);
  });

  it('the reversion notice carries the summary, with VIEW SESSION and no PLAY AGAIN', async () => {
    render(
      <LightningEndedNotice
        onViewGame={vi.fn()}
        session={{ poolSessionId: POOL, clusterId: CLUSTER, name: 'NLH 1/2 Classic' }}
      />
    );
    await screen.findByTestId('lightning-stats-summary');
    expect(screen.getByTestId('lightning-summary-view-session')).toBeTruthy();
    expect(screen.queryByTestId('lightning-summary-play-again')).toBeNull();
  });

  it('TablePage: both leave doors of a Lightning room open the Lightning summary', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page.match(/openLightningSessionSummary\(\{/g)).toHaveLength(2);
    expect(page).toMatch(
      /const lightningSummaryRoom = lightningLeave \? lightningRoomRef\.current : null;/
    );
    expect(page).toMatch(
      /const forceSummaryRoom = forceLightning \? lightningRoomRef\.current : null;/
    );
    const tools = sliceEnclosingBlock(page, '<LightningRoomTools');
    expect(tools).toContain('!lightningReversion.seatTableId');
  });
});

// ─── 6. Warm resume and the entry ──────────────────────────────────────────

describe('warm resume preferences', () => {
  it('cleans what it reads and survives a storage that throws', () => {
    localStorage.setItem(
      LIGHTNING_PREFS_STORAGE_KEY,
      JSON.stringify({
        lastClusterId: 'not-a-uuid',
        tableCount: 9,
        statsVisible: 'yes',
        preferFoldWatch: true,
      })
    );
    expect(readLightningPrefs()).toMatchObject({
      lastClusterId: null,
      tableCount: 1,
      statsVisible: false,
      preferFoldWatch: true,
    });
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLightningPrefs().statsVisible).toBe(false);
    expect(writeLightningPrefs({ statsVisible: true }).statsVisible).toBe(true);
    spy.mockRestore();
    set.mockRestore();
  });
});

function TableProbe() {
  const { tableId } = useParams();
  const loc = useLocation();
  return <div data-testid="table-route">{`${tableId}|${loc.search}`}</div>;
}

const renderEntry = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/lightning/:clusterId" element={<LightningEntryPage />} />
        <Route path="/table/:tableId" element={<TableProbe />} />
      </Routes>
    </MemoryRouter>
  );

describe('the Lightning entry with several Clusters', () => {
  const sessions = (n: number) =>
    [
      { pool_session_id: POOL_B, cluster_id: CLUSTER_B, name: 'PLO 2/5', stakes: { sb: 2, bb: 5 } },
      {
        pool_session_id: POOL_C,
        cluster_id: CLUSTER_C,
        name: 'NLH 5/10',
        small_blind: 5,
        big_blind: 10,
      },
      {
        pool_session_id: '11111111-1111-4111-8111-444444444444',
        cluster_id: '22222222-2222-4222-8222-555555555555',
        name: 'NLH 1/3',
      },
      {
        pool_session_id: '11111111-1111-4111-8111-555555555555',
        cluster_id: '22222222-2222-4222-8222-666666666666',
        name: 'NLH 2/4',
      },
    ].slice(0, n);

  const withSessions = (n: number) =>
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_lightning_my_session')
        return {
          data: { pool_session_id: null, state: null, cluster_mode: 'lightning' },
          error: null,
        };
      if (name === 'fn_lightning_my_sessions') return { data: sessions(n), error: null };
      return defaultRpc(name);
    });

  it('lists the other Lightning tables with VIEW GAME, and the pool badge', async () => {
    withSessions(2);
    renderEntry(`/lightning/${CLUSTER}`);
    expect(await screen.findByRole('button', { name: /join lightning/i })).toBeTruthy();
    expect((await screen.findByTestId('lightning-table-count')).textContent).toBe('2 Of 4');
    expect((await screen.findByTestId('lightning-pool-badge')).getAttribute('data-status')).toBe(
      'HOT'
    );
    fireEvent.click(screen.getAllByTestId('lightning-my-session-view')[0]);
    const probe = await screen.findByTestId('table-route');
    expect(probe.textContent?.startsWith(`${POOL_B}|`)).toBe(true);
    expect(probe.textContent).toContain('stakes=2%2F5');
    expect(moneyRpcs()).toEqual([]);
  });

  it('at the device limit JOIN LIGHTNING is not offered, and the page says why', async () => {
    withSessions(4);
    renderEntry(`/lightning/${CLUSTER}`);
    expect(await screen.findByText(/Most Lightning Tables This Device Allows/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^join lightning$/i })).toBeNull();
    expect(moneyRpcs()).toEqual([]);
  });

  it('offers the last Cluster played as a door, which only opens its entry', async () => {
    writeLightningPrefs({
      lastClusterId: CLUSTER_C,
      lastClusterName: 'NLH 5/10',
      lastStakes: '5/10',
    });
    withSessions(1);
    renderEntry(`/lightning/${CLUSTER}`);
    const last = await screen.findByTestId('lightning-last-played');
    expect(last.textContent).toContain('NLH 5/10');
    expect(moneyRpcs()).toEqual([]);
  });
});
