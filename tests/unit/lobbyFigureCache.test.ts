/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOBBY FIGURE CACHE — the last number we knew, and everything it must not do
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/lib/lobbyFigureCache.ts` shipped on 2026-09-02 with no coverage at all,
 * and exported a `resetLobbyFigureCacheForTests` seam that nothing called -
 * dead code by the playbook's own rule. This file makes that seam live, and
 * pins the behaviours the cache exists for plus the ways storage betrays you
 * in the wild.
 *
 * Every case here is a way the cache could quietly do the WRONG thing while
 * looking fine: forget a figure it was holding, keep one it should have let
 * go, hand a stale number to a card that has a live one, or take the lobby
 * down because a browser refused a write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  figureOr,
  readFigures,
  rememberFigures,
  resetLobbyFigureCacheForTests,
} from '../../src/lib/lobbyFigureCache';

const KEY = 'ca_lobby_figures_v1';

beforeEach(() => {
  localStorage.clear();
  resetLobbyFigureCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetLobbyFigureCacheForTests();
});

/** The flush is debounced by 400ms; nothing reaches storage before it fires. */
function flushToStorage() {
  vi.advanceTimersByTime(500);
}

describe('what the cache remembers', () => {
  it('reads back what it was told, through storage, in a fresh session', () => {
    vi.useFakeTimers();
    rememberFigures('club:1', { members: 1240, level: 20, active: 258 });
    flushToStorage();

    // A new session: drop the hydrated copy so the next read must parse storage.
    resetLobbyFigureCacheForTests();
    expect(readFigures('club:1')).toEqual({ members: '1240', level: '20', active: '258' });
  });

  it('does not touch storage until the debounce fires', () => {
    vi.useFakeTimers();
    rememberFigures('club:1', { members: 7 });
    expect(localStorage.getItem(KEY)).toBeNull();
    flushToStorage();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it('KEEPS a field that a later partial update did not carry', () => {
    /*
     * The whole point of the module. A realtime update carrying only `players`
     * must not wipe the `stakes` we already had, or the cache forgets exactly
     * when it is needed - on the next paint, with a field missing.
     */
    vi.useFakeTimers();
    rememberFigures('game:a', { players: '3/6', stakes: '50/100' });
    rememberFigures('game:a', { players: '4/6' });
    flushToStorage();
    resetLobbyFigureCacheForTests();

    expect(readFigures('game:a')).toEqual({ players: '4/6', stakes: '50/100' });
  });

  it('ignores null, undefined and empty string rather than storing them', () => {
    vi.useFakeTimers();
    rememberFigures('game:a', { players: '3/6' });
    rememberFigures('game:a', { players: null, stakes: undefined, buyIn: '' });
    flushToStorage();
    resetLobbyFigureCacheForTests();

    expect(readFigures('game:a')).toEqual({ players: '3/6' });
  });

  it('stores 0 — a real count, not an absent one', () => {
    // A bare `if (!raw)` would have dropped this. An empty table IS a fact.
    vi.useFakeTimers();
    rememberFigures('game:a', { players: 0 });
    flushToStorage();
    resetLobbyFigureCacheForTests();

    expect(readFigures('game:a')).toEqual({ players: '0' });
  });

  it('returns an empty map for an unknown scope and for no scope at all', () => {
    expect(readFigures('game:never-seen')).toEqual({});
    expect(readFigures('')).toEqual({});
  });

  it('writes nothing at all when handed an empty scope', () => {
    vi.useFakeTimers();
    rememberFigures('', { players: '3/6' });
    flushToStorage();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('what the cache lets go', () => {
  it('prunes to the newest 400 scopes so a busy club cannot grow it forever', () => {
    /*
     * A lobby rotates games continuously, so without a cap this key grows
     * without bound and nothing is in a position to prune it. 401 in, 400 out,
     * and the one that goes is the oldest.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'));

    rememberFigures('game:oldest', { players: '1/6' });
    for (let i = 0; i < 400; i += 1) {
      vi.advanceTimersByTime(1);
      rememberFigures(`game:${i}`, { players: '2/6' });
    }
    flushToStorage();

    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    expect(Object.keys(stored)).toHaveLength(400);
    expect(stored['game:oldest']).toBeUndefined();
    expect(stored['game:399']).toBeDefined();
  });
});

describe('when the browser is hostile', () => {
  it('survives corrupt JSON in storage', () => {
    localStorage.setItem(KEY, '{not json');
    resetLobbyFigureCacheForTests();
    expect(readFigures('club:1')).toEqual({});
  });

  it('survives a well-formed but wrongly-shaped payload', () => {
    // Written by an older version, another tab, or a user poking devtools.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        'club:1': null,
        'club:2': { at: 'yesterday', v: { members: 5, level: '20' } },
        'club:3': 'nonsense',
      })
    );
    resetLobbyFigureCacheForTests();

    expect(readFigures('club:1')).toEqual({});
    expect(readFigures('club:3')).toEqual({});
    // The numeric member count is not a string so it is dropped, and its valid
    // sibling survives: a half-good record is not thrown away wholesale.
    expect(readFigures('club:2')).toEqual({ level: '20' });
  });

  it('never throws when storage refuses to be read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    resetLobbyFigureCacheForTests();
    expect(() => readFigures('club:1')).not.toThrow();
    expect(readFigures('club:1')).toEqual({});
    spy.mockRestore();
  });

  it('never throws when storage refuses to be written, and still serves the session', () => {
    /*
     * Safari private mode throws on setItem once the quota is reached. A lobby
     * that could not draw because a CACHE was unavailable would be far worse
     * than the bug this module exists to fix, so the in-memory copy carries on.
     */
    vi.useFakeTimers();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() => {
      rememberFigures('club:1', { members: 1240 });
      flushToStorage();
    }).not.toThrow();

    // Same session, no storage: the figure is still there.
    expect(readFigures('club:1')).toEqual({ members: '1240' });
    spy.mockRestore();
  });
});

describe('figureOr — live wins, then memory, then zero', () => {
  it('prefers the live figure over anything remembered', () => {
    expect(figureOr('4/6', '3/6')).toBe('4/6');
  });

  it('falls back to the remembered figure when there is no live one', () => {
    expect(figureOr(undefined, '3/6')).toBe('3/6');
    expect(figureOr(null, '3/6')).toBe('3/6');
    expect(figureOr('', '3/6')).toBe('3/6');
  });

  it('falls back to 0 when nothing is known — never to an empty bay', () => {
    // Dan 2026-09-02: "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS."
    expect(figureOr(undefined, undefined)).toBe('0');
    expect(figureOr(null, '')).toBe('0');
  });

  it('treats a live 0 as an answer, not as absence', () => {
    /*
     * The trap this closes: a plain `live || cached || '0'` discards a genuine
     * zero and shows a remembered 3/6 for a table that has just emptied.
     */
    expect(figureOr(0, '3/6')).toBe('0');
    expect(figureOr('0/6', '3/6')).toBe('0/6');
  });

  it('accepts a caller-chosen placeholder for bays where 0 is not a fact', () => {
    expect(figureOr(undefined, undefined, '-')).toBe('-');
  });
});
