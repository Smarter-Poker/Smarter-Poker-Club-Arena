/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HOSTILE STATE — the saved lobby view must survive a browser that lies
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RULE 8, the Zero-Assumption Doctrine: "You must assume the user's browser is
 * a hostile environment: old localStorage data, expired tokens, stale
 * bookmarks... If your fix relies on a pristine, freshly-cleared browser state
 * to work, your fix is invalid."
 *
 * lobbyViewPrefs writes a tab name, a sort key and a boolean into localStorage
 * and reads them back on the next visit. Every one of those is a value a FUTURE
 * build may not recognise, and localStorage is the one API in the browser that
 * can throw on a plain read. So the failure modes are not hypothetical:
 *
 *   - a tab that this build removed would select a tab that does not exist;
 *   - a sort key from an older build would be handed to the sort switch;
 *   - Safari in private mode THROWS on getItem/setItem rather than returning
 *     null, which would take the whole lobby down on mount;
 *   - a full quota throws on write, and a lobby that cannot remember a tab
 *     must not be a lobby that crashes.
 *
 * These are the cases. Each one asserts the lobby still gets a usable value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadViewPrefs,
  saveViewPrefs,
  sortForTab,
  defaultSortForTab,
  EMPTY_VIEW_PREFS,
} from '../../src/components/lobby/lobbyViewPrefs';

const CLUB = 'fade0000-0000-0000-0000-000000000001';
const KEY = `ca_lobby_view_${CLUB}`;

/** Write a raw string straight into storage, the way an older build would have. */
const seed = (raw: string) => localStorage.setItem(KEY, raw);

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('a value this build does not recognise is dropped, not honoured', () => {
  it('drops a tab that no longer exists and falls back to no preference', () => {
    // The shape of the real risk: a build ships, removes a tab, and every
    // player who last used it has that name sitting in their storage.
    seed(JSON.stringify({ tab: 'QUANTUM_HOLDEM', sortByTab: {}, favoritesOnly: false }));
    expect(loadViewPrefs(CLUB).tab).toBeNull();
  });

  it('keeps a tab that does still exist', () => {
    seed(JSON.stringify({ tab: 'OMAHA', sortByTab: {}, favoritesOnly: false }));
    expect(loadViewPrefs(CLUB).tab).toBe('OMAHA');
  });

  it('drops a sort key this build cannot honour, per tab', () => {
    seed(
      JSON.stringify({
        tab: 'MTT',
        sortByTab: { MTT: 'by_vibes', OMAHA: 'stakes_high' },
        favoritesOnly: false,
      })
    );
    const prefs = loadViewPrefs(CLUB);
    // The bad one is gone entirely, so the tab falls back to its own default...
    expect(prefs.sortByTab.MTT).toBeUndefined();
    expect(sortForTab(prefs, 'MTT')).toBe(defaultSortForTab('MTT'));
    // ...and the good one beside it is untouched.
    expect(sortForTab(prefs, 'OMAHA')).toBe('stakes_high');
  });

  it('drops a sort saved against a tab that no longer exists', () => {
    seed(JSON.stringify({ tab: 'ALL', sortByTab: { QUANTUM: 'players' }, favoritesOnly: false }));
    expect(Object.keys(loadViewPrefs(CLUB).sortByTab)).toEqual([]);
  });

  it('treats a non-boolean favorites flag as off rather than as truthy', () => {
    // `favoritesOnly: 'yes'` is truthy in JS and would have silently filtered
    // the board down to starred tables with no way to see why.
    seed(JSON.stringify({ tab: 'HOLDEM', sortByTab: {}, favoritesOnly: 'yes' }));
    expect(loadViewPrefs(CLUB).favoritesOnly).toBe(false);
  });
});

describe('malformed storage never reaches the lobby', () => {
  it.each([
    ['truncated JSON (a write cut off by a crash)', '{"tab":"MTT","sortByT'],
    ['not JSON at all', 'MTT'],
    ['a JSON array', '[]'],
    ['a JSON number', '42'],
    ['a JSON string', '"MTT"'],
    ['JSON null', 'null'],
    ['an empty string', ''],
    ['sortByTab is not an object', '{"tab":"MTT","sortByTab":[1,2,3]}'],
    ['sortByTab is null', '{"tab":"MTT","sortByTab":null}'],
  ])('%s returns empty prefs instead of throwing', (_label, raw) => {
    seed(raw);
    const prefs = loadViewPrefs(CLUB);
    expect(prefs.tab === null || typeof prefs.tab === 'string').toBe(true);
    expect(prefs.sortByTab).toBeTypeOf('object');
    expect(prefs.favoritesOnly).toBe(false);
    // And the caller can always get a usable sort out of whatever came back.
    expect(sortForTab(prefs, 'MTT')).toBe('starting_soon');
  });

  it('a __proto__ key cannot poison the returned object', () => {
    seed('{"tab":"MTT","sortByTab":{"__proto__":{"polluted":true}}}');
    const prefs = loadViewPrefs(CLUB);
    expect((prefs.sortByTab as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('a browser that throws on storage access', () => {
  it('READ: private-mode Safari throws on getItem and the lobby still loads', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    expect(() => loadViewPrefs(CLUB)).not.toThrow();
    expect(loadViewPrefs(CLUB)).toEqual(EMPTY_VIEW_PREFS);
  });

  it('WRITE: a full quota throws on setItem and choosing a tab still works', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    expect(() =>
      saveViewPrefs(CLUB, { tab: 'MTT', sortByTab: { MTT: 'players' }, favoritesOnly: true })
    ).not.toThrow();
  });

  it('localStorage missing entirely (a non-browser host) does not throw', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => loadViewPrefs(CLUB)).not.toThrow();
    expect(() => saveViewPrefs(CLUB, EMPTY_VIEW_PREFS)).not.toThrow();
  });
});

describe('a stale bookmark into a club that is not this one', () => {
  it('never applies one club saved view to another club', () => {
    // The keys are per club precisely so a six-month-old bookmark to club A
    // cannot arrive carrying club B's tab.
    saveViewPrefs('club-a', { tab: 'OMAHA', sortByTab: { OMAHA: 'players' }, favoritesOnly: true });
    const other = loadViewPrefs('club-b');
    expect(other.tab).toBeNull();
    expect(other.favoritesOnly).toBe(false);
  });

  it('an empty or missing club id reads and writes nothing', () => {
    expect(loadViewPrefs('')).toEqual(EMPTY_VIEW_PREFS);
    expect(() => saveViewPrefs('', EMPTY_VIEW_PREFS)).not.toThrow();
    expect(localStorage.getItem('ca_lobby_view_')).toBeNull();
  });
});

describe('a round trip survives itself', () => {
  it('what saveViewPrefs writes, loadViewPrefs reads back unchanged', () => {
    const prefs = {
      tab: 'OMAHA' as const,
      sortByTab: { OMAHA: 'stakes_high' as const, MTT: 'players' as const },
      favoritesOnly: true,
    };
    saveViewPrefs(CLUB, prefs);
    expect(loadViewPrefs(CLUB)).toEqual(prefs);
  });
});
