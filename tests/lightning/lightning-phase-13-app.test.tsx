/**
 * LIGHTNING PHASE 13 (client): what a player sees while an operator rolls
 * Lightning out, drains it or rolls it back.
 *
 *   - joins closed: JOIN LIGHTNING is shown and not offered, on the entry page
 *     ("Lightning Is Not Taking New Players Right Now.") and on the lobby card;
 *   - a draining Cluster: the room says "Lightning Is Ending. Your Game
 *     Returns To MUST MOVE After This Hand." while the engine says it is
 *     ending; a paused one says nothing technical;
 *   - the drain's ending (exit_reason lightning_drained) has its own words and
 *     VIEW GAME to the seat that remains;
 *   - LIGHTNING FOLD / FOLD & WATCH switched off are never offered;
 *   - nothing navigates on its own (Law 10.6); player words only.
 *
 * Every database row below is a REAL contract row: the shapes the Phase 13
 * migration's doors answer (see DB_CONTRACT).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const SEAT_TABLE = '44444444-4444-4444-8444-444444444444';

/**
 * DB_CONTRACT: the answers of the Phase 13 migration's doors
 * (20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql on
 * agent/claude-lightning-p13/lightning/rollout-drain-db), built from the
 * bodies production carries now plus that file's asserted substitutions.
 */
const AUTO_REBUY_ROW = {
  enabled: false,
  trigger: 'zero',
  threshold_bb: 1,
  threshold_pct: 25,
  target: 'initial',
  max_count: 3,
  session_cap: 0,
  used_count: null,
  used_total: null,
};
const DB_CONTRACT = {
  /**
   * fn_lightning_pool_status(p_cluster_id) after 20261009235505 section 9:
   * joinable gains "AND joins enabled", plus joins_enabled and draining.
   * An operator has run disable_joins (lightning_joins_enabled false).
   */
  poolStatusJoinsClosed: {
    players: 21,
    status: 'ACTIVE',
    joinable: false,
    joins_enabled: false,
    draining: false,
    multi_table_limit: { mobile: 2, tablet: 3, desktop: 4 },
    auto_rebuy: AUTO_REBUY_ROW,
  },
  /** The same door with joins open (the default, lightning_joins_enabled true). */
  poolStatusOpen: {
    players: 21,
    status: 'ACTIVE',
    joinable: true,
    joins_enabled: true,
    draining: false,
    multi_table_limit: { mobile: 2, tablet: 3, desktop: 4 },
    auto_rebuy: AUTO_REBUY_ROW,
  },
  /**
   * fn_cash_cluster_lightning_state (the lobby's `lightning` key) as
   * production answers it today, with 20261009235505 section 6's
   * joins_enabled, for a Lightning Cluster whose joins an operator closed.
   */
  lobbyStateJoinsClosed: {
    enabled: true,
    game_id: CLUSTER,
    verdict: {
      to_on: 0,
      to_off: 9,
      confidence: 'partial',
      live_eligible: 21,
      would_turn_on: false,
      would_turn_off: false,
    },
    must_move: true,
    handedness: 6,
    thresholds: {
      ok: true,
      on: 18,
      off: 12,
      band: 'six_max',
      source: 'default',
      game_id: CLUSTER,
      rejected: [],
      handedness: 6,
    },
    cluster_mode: 'lightning',
    cluster_epoch: 1,
    lightning_enabled: true,
    open_pool_sessions: 21,
    open_cluster_sessions: 21,
    joins_enabled: false,
  },
  /**
   * fn_lightning_reconnect_state after the drain's commit_must_move closed
   * the pool session with exit_reason 'lightning_drained' (the anchor seat
   * untouched); joinable false (the Cluster is MUST MOVE).
   */
  reconnectDrained: {
    pool_session_id: POOL,
    state: 'closed',
    in_hand: false,
    hand_id: null,
    disconnected_at: null,
    seat_table_id: SEAT_TABLE,
    seat_number: 3,
    stack: 212.5,
    joinable: false,
    exit_reason: 'lightning_drained',
  },
} as const;

const rpc = vi.fn();
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
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: gameRow, error: null });
      chain.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));

import LightningEntryPage, {
  LIGHTNING_JOINS_CLOSED_TEXT,
} from '../../src/pages/LightningEntryPage';
import LightningEndingNotice from '../../src/components/table/LightningEndingNotice';
import { resetLightningRegistryForTests } from '../../src/lightning/lightningSession';
import { parseLightningPoolHealth } from '../../src/lightning/lightningSessionApi';
import { lightningLobbyBadge, parseLightningLobbyState } from '../../src/lightning/lightningLobby';
import {
  lightningClusterStatus,
  noteLightningUserEvent,
  resetLightningClusterStatusForTests,
} from '../../src/lightning/lightningDecisionQueue';
import {
  LIGHTNING_ENDING_TEXT,
  lightningFoldAvailability,
  lightningFoldFlags,
} from '../../src/lightning/lightningHand';
import {
  LIGHTNING_DRAINED_EXIT_REASON,
  LIGHTNING_DRAINED_TITLE,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
} from '../../src/lightning/lightningReconnect';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import { blankNonCode, sliceEnclosingBlock } from '../helpers/sourceWindow';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

beforeEach(() => {
  sessionStorage.clear();
  resetLightningRegistryForTests();
  resetLightningClusterStatusForTests();
  rpc.mockReset();
});
afterEach(cleanup);

// ─── JOINS CLOSED ────────────────────────────────────────────────────────

describe('joins closed: JOIN LIGHTNING shown, not offered', () => {
  it('reads joins_enabled from the pool door, and an older payload decides nothing', () => {
    expect(parseLightningPoolHealth(DB_CONTRACT.poolStatusJoinsClosed)?.joinsEnabled).toBe(false);
    expect(parseLightningPoolHealth(DB_CONTRACT.poolStatusOpen)?.joinsEnabled).toBe(true);
    const { joins_enabled: _drop, ...older } = DB_CONTRACT.poolStatusOpen;
    void _drop;
    expect(parseLightningPoolHealth(older)).not.toHaveProperty('joinsEnabled');
  });

  it('the entry page shows JOIN LIGHTNING disabled with the player line, and no other door', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_lightning_my_session')
        return {
          data: { pool_session_id: null, state: null, cluster_mode: 'lightning' },
          error: null,
        };
      if (name === 'fn_lightning_pool_status')
        return { data: DB_CONTRACT.poolStatusJoinsClosed, error: null };
      if (name === 'fn_lightning_my_sessions') return { data: [], error: null };
      return { data: null, error: null };
    });
    render(
      <MemoryRouter initialEntries={[`/lightning/${CLUSTER}`]}>
        <Routes>
          <Route path="/lightning/:clusterId" element={<LightningEntryPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText(LIGHTNING_JOINS_CLOSED_TEXT)).toBeTruthy();
    const closed = await screen.findByTestId('lightning-entry-join-closed');
    expect(closed.textContent).toMatch(/join lightning/i);
    expect((closed as HTMLButtonElement).disabled).toBe(true);
    // The only enabled door left is the way back to the lobby.
    const enabled = screen
      .getAllByRole('button')
      .filter((b) => !(b as HTMLButtonElement).disabled)
      .map((b) => b.textContent);
    expect(enabled.some((t) => /join/i.test(t ?? ''))).toBe(false);
    expect(rpc).not.toHaveBeenCalledWith('fn_cash_game_join', expect.anything());
    expect(LIGHTNING_JOINS_CLOSED_TEXT).toBe('Lightning Is Not Taking New Players Right Now.');
  });

  it('the lobby card keeps JOIN LIGHTNING, disabled; an open pool is exactly as before', () => {
    const cardCtx = {
      seatedIds: new Set<string>(),
      waitlistedIds: new Set<string>(),
      registeredIds: new Set<string>(),
      onJoinTable: () => {},
      onViewTable: () => {},
      onWaitlistToggle: () => {},
    } as unknown as LobbyRowContext;
    const row = (state: unknown): LobbyTableRow =>
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
        cluster_mode: 'lightning',
        cluster_lightning: parseLightningLobbyState(state),
      }) as LobbyTableRow;
    const closed = cashEntry(row(DB_CONTRACT.lobbyStateJoinsClosed));
    expect(closed.game?.lightning).toEqual({ players: 21, status: 'ACTIVE', joinsClosed: true });
    const actions = arenaGameCardActionsForEntry(closed, cardCtx);
    expect(actions.primaryLabel).toBe('Join Lightning');
    expect(actions.primaryDisabled).toBe(true);
    const { joins_enabled: _j, ...open } = DB_CONTRACT.lobbyStateJoinsClosed;
    void _j;
    const openEntry = cashEntry(row(open));
    expect(openEntry.game?.lightning).toEqual({ players: 21, status: 'ACTIVE' });
    expect(arenaGameCardActionsForEntry(openEntry, cardCtx).primaryDisabled).toBe(false);
    expect(
      lightningLobbyBadge({
        clusterMode: 'lightning',
        state: parseLightningLobbyState(DB_CONTRACT.lobbyStateJoinsClosed),
        boardPlayers: 5,
      })
    ).toMatchObject({ joinLightning: true, joinsClosed: true });
  });
});

// ─── THE DRAIN ───────────────────────────────────────────────────────────

describe('a draining Cluster: the room is told, in plain words', () => {
  it('lightning_cluster_status ending shows the line; paused and null show nothing', () => {
    render(<LightningEndingNotice clusterId={CLUSTER} />);
    expect(screen.queryByTestId('lightning-ending')).toBeNull();
    act(() => {
      expect(
        noteLightningUserEvent({
          type: 'lightning_cluster_status',
          cluster_id: CLUSTER,
          status: 'ending',
        })
      ).toBe(true);
    });
    expect(screen.getByTestId('lightning-ending').textContent).toBe(LIGHTNING_ENDING_TEXT);
    expect(LIGHTNING_ENDING_TEXT).toBe(
      'Lightning Is Ending. Your Game Returns To MUST MOVE After This Hand.'
    );
    act(() => {
      noteLightningUserEvent({
        type: 'lightning_cluster_status',
        cluster_id: CLUSTER,
        status: 'paused',
      });
    });
    expect(lightningClusterStatus(CLUSTER)).toBe('paused');
    expect(screen.queryByTestId('lightning-ending')).toBeNull();
    act(() => {
      noteLightningUserEvent({
        type: 'lightning_cluster_status',
        cluster_id: CLUSTER,
        status: null,
      });
    });
    expect(lightningClusterStatus(CLUSTER)).toBeNull();
    // Another Cluster's status is not this room's.
    act(() => {
      noteLightningUserEvent({
        type: 'lightning_cluster_status',
        cluster_id: ANCHOR,
        status: 'ending',
      });
    });
    expect(screen.queryByTestId('lightning-ending')).toBeNull();
  });

  it('the drained ending has its own words and VIEW GAME to the seat (REAL reconnect row)', () => {
    const state = parseLightningReconnectState(DB_CONTRACT.reconnectDrained);
    expect(state?.exitReason).toBe(LIGHTNING_DRAINED_EXIT_REASON);
    const verdict = lightningReconnectVerdict(POOL, state);
    expect(verdict).toEqual({
      kind: 'ended',
      timedOut: false,
      stopped: false,
      rgLimit: false,
      drained: true,
      seatTableId: SEAT_TABLE,
    });
    expect(lightningSessionEndText(verdict as never)).toBe(
      `${LIGHTNING_DRAINED_TITLE}. Your Seat Is Ready At Your Table.`
    );
    expect(LIGHTNING_DRAINED_TITLE).toBe('Lightning Has Ended For This Game');
  });

  it('TablePage mounts the ending line in the Lightning room, beside Next Hand, with no navigation', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(
      /\{lightningRoom \? <LightningEndingNotice clusterId=\{lightningRoom\.clusterId\} \/> : null\}/
    );
    const notice = blankNonCode(read('src/components/table/LightningEndingNotice.tsx'));
    expect(notice).not.toMatch(/navigate|useNavigate|location\.|window\.open/);
    // Law 10.6: the page's handler-bound return navigations are still exactly two.
    expect(page.split('navigate(lightningReturnPath(').length - 1).toBe(2);
  });
});

// ─── THE FOLD FLAGS ──────────────────────────────────────────────────────

describe('LIGHTNING FOLD and FOLD & WATCH follow the Cluster flags', () => {
  const live = {
    heroSeated: true,
    handInProgress: true,
    handSettling: false,
    heroStatus: 'active',
    engineFastFoldAvailable: true,
    handOnFelt: true,
  };
  const desktop = { fast_fold: true, fold_and_watch: true };
  it('a control switched off is never offered; an older engine offers both', () => {
    const off = lightningFoldFlags({
      lightning: { fast_fold_available: true, fast_fold_enabled: false, fold_watch_enabled: false },
    });
    expect(off).toEqual({ fastFold: false, foldWatch: false });
    expect(lightningFoldAvailability({ ...live, engineFoldFlags: off }, desktop)).toEqual({
      fastFold: false,
      foldWatch: false,
    });
    const watchOnly = lightningFoldFlags({ lightning: { fast_fold_enabled: false } });
    expect(lightningFoldAvailability({ ...live, engineFoldFlags: watchOnly }, desktop)).toEqual({
      fastFold: false,
      foldWatch: true,
    });
    expect(lightningFoldFlags({ lightning: { fast_fold_available: true } })).toBeNull();
    expect(lightningFoldAvailability({ ...live, engineFoldFlags: null }, desktop)).toEqual({
      fastFold: true,
      foldWatch: true,
    });
  });

  it('the table view passes the engine flags into the strip', () => {
    const page = read('src/pages/TablePage.tsx');
    const block = sliceEnclosingBlock(page, 'engineFoldFlags: lightningRoom');
    expect(block).toContain('lightningFoldFlags(engineSnapshot as LightningSnapshotFields)');
  });
});

// ─── WORDS ───────────────────────────────────────────────────────────────

describe('player words only', () => {
  it('no competitor product name, no em dash, no technical text on any Phase 13 surface', () => {
    const files = [
      'src/components/table/LightningEndingNotice.tsx',
      'src/pages/LightningEntryPage.tsx',
      'src/lightning/lightningHand.ts',
      'src/lightning/lightningReconnect.ts',
    ];
    for (const f of files) {
      const text = read(f);
      for (const re of [
        /\bzoom\b/i,
        /\brush\b/i,
        /\bsnap\b/i,
        /\bfast[\s-]?forward\b/i,
        /\bfast[\s-]fold\b/i,
      ])
        expect(re.test(text), `${f} ${re}`).toBe(false);
    }
    for (const s of [LIGHTNING_JOINS_CLOSED_TEXT, LIGHTNING_ENDING_TEXT, LIGHTNING_DRAINED_TITLE]) {
      expect(s).not.toMatch(/—/);
      expect(s).not.toMatch(/drain|pause|flag|operator|loading|connecting/i);
    }
  });
});
