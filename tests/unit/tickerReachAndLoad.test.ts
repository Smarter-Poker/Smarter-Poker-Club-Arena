/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RAIL HAS TO REACH THE PLAYER, AND NOT COST THE DATABASE A FORTUNE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four findings from the 2026-09-05 audit, none of them visible in the render.
 *
 * A BROADCAST TOOL THAT COULD NOT BROADCAST. `TICKER_SETTINGS_CHANGED` is
 * emitted from realtime only on GameManagementPage - the OPERATOR'S own tab -
 * and `game_management_events` is readable only by operators, so a player can
 * never be subscribed to it. A player refetched managed settings when
 * `location.pathname` changed, and a seated player does not change route for
 * hours: publishing an urgent SERVICE NOTICE reached nobody who was playing.
 *
 * FOUR QUERIES EVERY THIRTY SECONDS, PER SEATED PLAYER. The two operational
 * queries - a wide 80-row read of `tournaments` and a 10-row read of `tables` -
 * fired unconditionally, though three of the four sources they feed are OFF by
 * default.
 *
 * CLUB SCOPE CACHED FOR THE LIFE OF THE TAB. Join a club and its events stayed
 * silent until a hard reload; switch accounts and the rail stayed scoped to the
 * previous user's clubs.
 *
 * SETTINGS FAILED OPEN. A failed RPC returned DEFAULT_TICKER_SETTINGS, which
 * carries `enabled: true`, so a club that had switched the rail OFF got it back
 * during any transient failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceCall, sliceEnclosingBlock } from '../helpers/sourceWindow';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));

import {
  DEFAULT_TICKER_SETTINGS,
  resetTickerSettingsCache,
  tickerManagementService,
} from '../../src/services/TickerManagementService';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TICKER = read('src/components/tournament/TournamentStartingTicker.tsx');
/* The other half of the source gate lives in the feed function itself. */
const FEED_SQL = read('supabase/migrations/20260914102703_the_rail_asks_the_server_once.sql');

describe('an operator change reaches a player who is already seated', () => {
  it('refetches the managed settings on the same tick as the feed', () => {
    /* The RPC is member-gated and already authorised for every player in the
       club, so it rides the existing poll. No DDL, no new read surface, and no
       new RLS policy to get wrong - which is what a realtime subscription to
       `game_management_events` would have needed, and could not have had. */
    const BLOCK = sliceBetween(TICKER, 'const loadManaged = async ()', 'const [items, setItems]');
    expect(BLOCK).toMatch(/setInterval\(/);
    expect(BLOCK).toMatch(/POLL_MS/);
  });

  it('does not poll settings into a tab nobody is looking at', () => {
    expect(sliceBetween(TICKER, 'const loadManaged = async ()', 'const [items, setItems]')).toMatch(
      /document\.hidden/
    );
  });

  it('keeps the instant path for the operator who made the change', () => {
    expect(TICKER).toMatch(/useMasterBusSubscription\('TICKER_SETTINGS_CHANGED'/);
  });
});

describe('a club pays only for the sources it has switched on', () => {
  it('hands every source switch to the feed, so the server can gate on it', () => {
    /* THE GATE MOVED (2026-09-14). It used to be four ternaries around four
       query builders in this file; the read is one RPC now and the switches
       travel as its argument. The assertion follows the gate: the call has to
       carry every source, or a switched-off source silently becomes a
       switched-ON one at the database. */
    const call = sliceCall(TICKER, 'await fetchTickerFeed(');
    for (const flag of [
      'starting_soon: sources.starting_soon',
      'overlays: sources.overlays',
      'registration_closing: sources.registration_closing',
      'guarantees: sources.guarantees',
      'winner_results: sources.winner_results',
      'table_openings: sources.table_openings',
    ]) {
      expect(call, flag).toContain(flag);
    }
  });

  it('is the regression: the operational read is still not unconditional', () => {
    /* Three of the four sources it feeds are off by default, and it was the
       most expensive query on the tick: 80 rows, seventeen columns. The other
       half of the gate is now in SQL, so this reads the migration: each source
       block must be guarded by its own `v_want_*`, or the function does the
       work for a club that asked for none of it. */
    for (const [marker, flag] of [
      ['STARTING SOON', 'v_want_soon'],
      ['OVERLAYS', 'v_want_overlays'],
      ['REGISTRATION CLOSING', 'v_want_closing'],
      ['GUARANTEES', 'v_want_guarantee'],
      ['RESULTS', 'v_want_results'],
      ['TABLE OPENINGS', 'v_want_tables'],
    ] as const) {
      const block = sliceBetween(FEED_SQL, `-- \u2500\u2500 ${marker} `, 'RETURN v_out');
      expect(block, marker).toContain(flag);
    }
  });

  it('still suspends the whole poll while the tab is hidden', () => {
    expect(TICKER).toMatch(/visibilitychange/);
  });
});

describe('the club scope can go stale, and does not', () => {
  it('carries the user it was built for, so an account switch cannot leak', () => {
    expect(sliceCall(TICKER, 'const loadScope = useCallback')).toContain('cached.userId === uid');
  });

  it('has a floor on how long it is trusted', () => {
    expect(TICKER).toMatch(/SCOPE_TTL_MS\s*=\s*5 \* 60_000/);
    expect(sliceCall(TICKER, 'const loadScope = useCallback')).toContain('SCOPE_TTL_MS');
  });

  it('is cleared the moment the two things that invalidate it happen', () => {
    expect(TICKER).toMatch(/useMasterBusSubscription\('AUTH_STATE_CHANGED', invalidateScope\)/);
    expect(TICKER).toMatch(/useMasterBusSubscription\('CLUB_JOINED', invalidateScope\)/);
  });
});

describe('settings fail closed', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    resetTickerSettingsCache();
  });

  it('is the regression: a failed refresh no longer switches the rail back on', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { enabled: false, speed_seconds: 30 },
      error: null,
    });
    const off = await tickerManagementService.get('club-1', null);
    expect(off.enabled).toBe(false);

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    const afterFailure = await tickerManagementService.get('club-1', null);
    expect(afterFailure.enabled).toBe(false);
    expect(afterFailure.speedSeconds).toBe(30);
  });

  it('keeps each scope separate, so one club cannot answer for another', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { enabled: false }, error: null });
    await tickerManagementService.get('club-1', null);

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    const other = await tickerManagementService.get('club-2', null);
    expect(other).toEqual(DEFAULT_TICKER_SETTINGS);
  });

  it('still uses the defaults on a cold start with no prior answer', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    expect(await tickerManagementService.get('club-9', null)).toEqual(DEFAULT_TICKER_SETTINGS);
  });

  it('an account transition retires both the cached settings and a late response', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { custom_messages: ['Previous account notice'] },
      error: null,
    });
    await tickerManagementService.get('club-1', null);
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const stale = tickerManagementService.get('club-1', null);
    resetTickerSettingsCache();
    finish({ data: { custom_messages: ['Late previous account notice'] }, error: null });
    expect(await stale).toEqual(DEFAULT_TICKER_SETTINGS);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection interrupted' } });
    expect(await tickerManagementService.get('club-1', null)).toEqual(DEFAULT_TICKER_SETTINGS);
  });

  it('and the container does not overwrite it with defaults on a throw', () => {
    /* The effect used to `setManagedTicker(DEFAULT_TICKER_SETTINGS)` in its
       catch, which put the rail back on from the other direction. */
    const CATCH = sliceEnclosingBlock(
      TICKER,
      "reportError(error, 'TournamentStartingTicker.loadManagedSettings')"
    );
    expect(CATCH).not.toContain('setManagedTicker(DEFAULT_TICKER_SETTINGS)');
  });
});

describe('the contract in the header matches the code underneath it', () => {
  it('no longer promises a union scope the RLS cannot deliver', () => {
    /* `tournaments_select` is `is_club_member(club_id, auth.uid())`, so a
       sibling club's rows come back empty however many ids the query passes.
       The header claimed the wider scope for two weeks. */
    const HEADER = TICKER.slice(0, TICKER.indexOf('import {'));
    expect(HEADER).toContain('THIS HEADER USED TO SAY');
    expect(HEADER).toContain('is_club_member');
    const SCOPE = sliceCall(TICKER, 'const loadScope = useCallback');
    expect(SCOPE).toContain("from('club_members')");
    expect(SCOPE).not.toContain('union_clubs');
  });
});
