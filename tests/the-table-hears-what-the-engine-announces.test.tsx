/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TABLE HEARS WHAT THE ENGINE ANNOUNCES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three subscribers in this codebase had been waiting, since the day they were
 * written, for an event that could not reach them.
 *
 *   1. THE TIME BANK BADGE NEVER CLEARED.
 *      `setTimeBankActive(false)` has exactly one caller in the whole app:
 *      `persistTimeBankState` in TablePage, subscribed to TIME_BANK_STOPPED /
 *      _DEPLETED / _EXPIRED. TIME_BANK_ACTIVATED has its own `case` in the
 *      engine-event switch and sets the badge to TRUE. The three events that
 *      end a bank had no case, so the badge went on and stayed on; it cleared
 *      only if some later snapshot happened to disagree with it.
 *
 *   2. A STRADDLE WAS INVISIBLE TO EVERY OTHER SEAT.
 *      `useTableChat` raises "Player 1a2b turned ON Auto-Straddle" from
 *      STRADDLE_TOGGLED. The player who pressed the button sees their own
 *      switch move because handleToggleStraddle POSTs and updates locally —
 *      which is exactly why this looked like it worked. Nobody else was told.
 *
 *   3. A PRE-ACTION PLAYED ITSELF IN SILENCE.
 *      `useTableChat` raises "Player 1a2b auto-folded" from
 *      PRE_ACTION_EXECUTED. The feature worked; the table was never told.
 *
 * ONE ROOT CAUSE, TWO LEGS. The sub-engines publish through a PRIVATE
 * in-process callback whose only consumer was ServerTableEngineBase, and the
 * client's engine→bus dispatcher — the uppercase `switch (evt.type)` that
 * every other engine event passes through — had no `case` for any of these
 * types. Neither leg alone is enough: an event that never leaves the server
 * cannot be dispatched, and an event that arrives at a switch with no case
 * falls off the end of it.
 *
 * The server leg is proved in
 * server/src/engine/TheTableHearsWhatTheEngineAnnounces.test.ts, which drives
 * the real engines and asserts the hub broadcast. This file proves the client
 * leg: the dispatcher cases exist and carry the fields the subscribers read
 * (red before the fix, green after), and the subscribers turn that payload
 * into the visible notice (a contract pin — useTableChat is unchanged, so it
 * is green either way; it is here so a later edit to the payload shape fails
 * against the consumer rather than against a string).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HERO = 'hero-1';

// ═══════════════════════════════════════════════════════════════════════════
//  THE WIRE — src/pages/TablePage.tsx
// ═══════════════════════════════════════════════════════════════════════════

const TABLE_PAGE = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');

/**
 * The engine→bus dispatcher only. There is a second, lowercase `if`-chain
 * earlier in the file for transient payload events; slicing to the switch
 * keeps these assertions about the dispatcher that actually feeds MasterBus.
 */
const DISPATCHER = (() => {
  const start = TABLE_PAGE.indexOf('const normalizedType = rawType.toUpperCase();');
  expect(start).toBeGreaterThan(-1);
  const end = TABLE_PAGE.indexOf('// Supabase Realtime fallback: process lastEvent', start);
  expect(end).toBeGreaterThan(start);
  return TABLE_PAGE.slice(start, end);
})();

/** The body of one `case` label, up to its `break;`. */
function caseBody(label: string): string {
  const at = DISPATCHER.indexOf(`case '${label}':`);
  expect(at, `no case '${label}' in the engine-event dispatcher`).toBeGreaterThan(-1);
  const stop = DISPATCHER.indexOf('break;', at);
  expect(stop).toBeGreaterThan(at);
  return DISPATCHER.slice(at, stop);
}

describe('the engine-event dispatcher carries the events its subscribers wait for', () => {
  it.each(['TIME_BANK_STOPPED', 'TIME_BANK_DEPLETED', 'TIME_BANK_EXPIRED'])(
    '%s reaches the bus, with the fields persistTimeBankState reads',
    (label) => {
      const body = caseBody(label);
      // By LITERAL name: tests/unit/noDeadBusSubscriptions.test.ts finds a
      // publisher by scanning for one, and a computed `evt.type` would leave
      // these reading as dead subscriptions while working.
      expect(body).toContain(`masterBus.emit('${label}'`);
      // persistTimeBankState returns on its first line unless BOTH of these
      // match, and writes the other two to table_seats.
      for (const field of ['tableId', 'playerId', 'usesRemaining', 'remainingSeconds']) {
        expect(body, `${label} must carry ${field}`).toContain(`${field}:`);
      }
      // The hub speaks snake_case; the subscriber reads camelCase. That
      // mismatch is the exact drop that made TIME_BANK_ACTIVATED look
      // intermittent for months, so both spellings are accepted on arrival.
      expect(body).toContain('table_id');
      expect(body).toContain('player_id');
    }
  );

  it('STRADDLE_TOGGLED reaches the bus with the enrolment it announces', () => {
    const body = caseBody('STRADDLE_TOGGLED');
    expect(body).toContain("masterBus.emit('STRADDLE_TOGGLED'");
    for (const field of ['tableId', 'playerId', 'enabled']) {
      expect(body).toContain(`${field}:`);
    }
  });

  it('PRE_ACTION_EXECUTED reaches the bus with the move that was played', () => {
    const body = caseBody('PRE_ACTION_EXECUTED');
    expect(body).toContain("masterBus.emit('PRE_ACTION_EXECUTED'");
    for (const field of ['tableId', 'playerId', 'action']) {
      expect(body).toContain(`${field}:`);
    }
  });

  it('never dispatches a pre-action that was only ARMED', () => {
    // SET / CLEARED / INVALIDATED are one player's unplayed intention. The
    // server keeps them on the private per-user frame; a case here would be
    // the client half of a leak, so there must not be one.
    for (const label of ['PRE_ACTION_SET', 'PRE_ACTION_CLEARED', 'PRE_ACTION_INVALIDATED']) {
      expect(DISPATCHER).not.toContain(`case '${label}':`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE CONSUMER — src/hooks/useTableChat.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * tests/setup.ts replaces MasterBus globally with a stub whose emit() never
 * calls subscribers — correct for suites that only need the module to exist,
 * useless for a test about whether a hook reacts to an event. A real minimal
 * bus is supplied here so the assertions below are about useTableChat and not
 * about the stub.
 */
const bus = vi.hoisted(() => {
  const subscribers = new Map<string, Set<(e: unknown) => void>>();
  return {
    subscribers,
    subscribe(type: string, handler: (e: unknown) => void) {
      if (!subscribers.has(type)) subscribers.set(type, new Set());
      subscribers.get(type)!.add(handler);
      return () => subscribers.get(type)?.delete(handler);
    },
    emit(type: string, payload: unknown) {
      subscribers.get(type)?.forEach((h) => h({ type, payload, timestamp: '' }));
    },
  };
});

vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: bus.subscribe,
    subscribeDebounced: (t: string, h: (e: unknown) => void) => bus.subscribe(t, h),
    emit: bus.emit,
    onEvent: () => () => undefined,
    init: () => ({ online: true }),
    reset: () => undefined,
    getOrCreateChannel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      ch.unsubscribe = () => Promise.resolve('ok');
      return ch;
    },
    removeRegisteredChannel: () => undefined,
  },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
      unsubscribe() {
        return undefined;
      },
    }),
    removeChannel: () => undefined,
  },
}));

import { useTableChat } from '../src/hooks/useTableChat';

afterEach(cleanup);

describe('the table chat says out loud what the dispatcher hands it', () => {
  it('announces a pre-action that folded for its player', async () => {
    const { result } = renderHook(() => useTableChat(TABLE, HERO, []));
    // Flush the mount-time history read before asserting on what the bus added.
    await act(async () => undefined);
    act(() => {
      // Exactly the payload the PRE_ACTION_EXECUTED case builds.
      bus.emit('PRE_ACTION_EXECUTED', {
        tableId: TABLE,
        playerId: 'abcd-1234',
        action: 'fold',
        amount: 0,
      });
    });
    expect(result.current.chatMessages.at(-1)).toMatchObject({
      type: 'SYSTEM',
      content: 'Player abcd auto-folded',
    });
  });

  it('announces a straddle to a seat that did not toggle it', async () => {
    // HERO is not the toggling player: this is the notice that never appeared.
    const { result } = renderHook(() => useTableChat(TABLE, HERO, []));
    await act(async () => undefined);
    act(() => {
      bus.emit('STRADDLE_TOGGLED', { tableId: TABLE, playerId: 'wxyz-9999', enabled: true });
    });
    expect(result.current.chatMessages.at(-1)).toMatchObject({
      type: 'SYSTEM',
      content: 'Player wxyz turned ON Auto-Straddle',
    });
  });

  it('keeps another table out of this one', async () => {
    const { result } = renderHook(() => useTableChat(TABLE, HERO, []));
    await act(async () => undefined);
    act(() => {
      bus.emit('PRE_ACTION_EXECUTED', {
        tableId: 'some-other-table',
        playerId: 'abcd-1234',
        action: 'fold',
        amount: 0,
      });
      bus.emit('STRADDLE_TOGGLED', {
        tableId: 'some-other-table',
        playerId: 'wxyz-9999',
        enabled: true,
      });
    });
    // MasterBus is app-wide and MultiTablePage keeps four TablePages mounted.
    expect(result.current.chatMessages).toHaveLength(0);
  });
});
