/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TAB SLOTS — behavioural pins for two bugs that source-grep tests missed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both decisions below were already "covered" by tests that asserted the SHAPE
 * OF THE SOURCE TEXT (`expect(CODE).toMatch(/t\.kind === 'table'/)`). That kind
 * of test passes on a line that is present and wrong, which is exactly what
 * happened: the prune predicate existed, read correctly, matched its regex, and
 * did nothing to the tabs that mattered because they were built elsewhere
 * without the field it asked for. A test that RUNS the predicate against the
 * real tab shapes catches it in a second.
 *
 * BUG 1 (Dan 2026-08-30) — "WHEN I WENT INTO THE LOBBY TO CHANGE A TABLE, IT
 * DIDN'T CHANGE THE TABLE FOR THE LOBBY TABLE AND PAGE I WAS IN, IT CREATED A
 * NEW ACTION BAR AND ADDED IT IN THE FIRST SLOT LABELED MTT."
 *
 * BUG 2 (Dan 2026-08-28 bug 1, re-opened) — a tab whose seat the server has
 * closed must not stay on screen. It stayed, for every tab restored by a
 * reload, because those are the ones built without `kind`.
 */
import { describe, it, expect } from 'vitest';
import {
  isFreeSlot,
  isLobbyLike,
  isTournamentRow,
  pickObserveSlot,
  pruneStaleSeatedTabs,
  type SlotTab,
} from '../../src/utils/tabSlots';

const MAX = 4;

/* The four tab shapes MultiTablePage actually constructs, copied field for
   field from their factories so a drift in either direction fails here. */
const lobbyTab: SlotTab = { id: 'lobby:1', kind: 'lobby' };
/** TABLE_SEATED / hero-seat-move / route effect. */
const seatedTab = (id: string): SlotTab => ({ id, kind: 'table', seated: true });
/** OPEN_OBSERVE_TABLE: `seated` deliberately undefined — that is what marks it. */
const observerTab = (id: string): SlotTab => ({ id, kind: 'table' });
/** The server-truth rebuild's own additions: seated, and NO `kind` field. */
const rebuiltTab = (id: string): SlotTab => ({ id, seated: true });

describe('isLobbyLike / isFreeSlot', () => {
  it('recognises a lobby tab by flag or by id prefix', () => {
    expect(isLobbyLike(lobbyTab)).toBe(true);
    expect(isLobbyLike({ id: 'lobby:cold' })).toBe(true);
    expect(isLobbyLike(seatedTab('T1'))).toBe(false);
    // A rebuilt tab has no `kind` at all and must still read as a table.
    expect(isLobbyLike(rebuiltTab('T1'))).toBe(false);
  });

  it('counts a lobby tab and an unseated observer as free, a seat never', () => {
    expect(isFreeSlot(lobbyTab)).toBe(true);
    expect(isFreeSlot(observerTab('T1'))).toBe(true);
    expect(isFreeSlot({ id: 'T1', kind: 'table', seated: false })).toBe(true);
    expect(isFreeSlot(seatedTab('T1'))).toBe(false);
    expect(isFreeSlot(rebuiltTab('T1'))).toBe(false);
  });
});

describe('isTournamentRow — the flag every tab factory must carry', () => {
  /**
   * The rebuild derived this, handed it to `gameCode(...)`, and threw it away.
   * `undefined` then reads as "cash" at four readers, one of which is a rule
   * Dan set in writing: the profit chip is a cash-game-only feature.
   */
  it('is true when the row says tournament', () => {
    expect(isTournamentRow({ game_type: 'tournament', tournament_id: null })).toBe(true);
  });

  it('is true on tournament_id alone, with no game_type', () => {
    // Satellite / re-seated tables carry the id without always carrying the
    // type. Reading only `game_type` would misfile every one of them as cash.
    expect(isTournamentRow({ tournament_id: 'evt-1' })).toBe(true);
    expect(isTournamentRow({ game_type: null, tournament_id: 'evt-1' })).toBe(true);
  });

  it('is false for a cash row', () => {
    expect(isTournamentRow({ game_type: 'cash', tournament_id: null })).toBe(false);
    expect(isTournamentRow({})).toBe(false);
  });

  it('never throws on a row the query did not return', () => {
    // `rows?.find(...)` yields undefined whenever the read raced or the row was
    // deleted; a factory must still produce a tab rather than crash the rebuild.
    expect(isTournamentRow(undefined)).toBe(false);
    expect(isTournamentRow(null)).toBe(false);
  });
});

describe('changing tables from the lobby changes the screen you are on', () => {
  it('replaces the ACTIVE lobby tab in place, not another slot (Dan 2026-08-30)', () => {
    // The exact reported layout: a live MTT in slot 0, the lobby in slot 1,
    // and the player standing in the lobby asking for a different table.
    const tabs = [seatedTab('MTT'), lobbyTab];
    const slot = pickObserveSlot(tabs, 1, 'NEW', MAX);
    expect(slot).toEqual({ action: 'active', index: 1 });
    // The bug: it landed in slot 0 and left the lobby where it was.
    expect(slot.index).not.toBe(0);
  });

  it('replaces the ACTIVE unseated observer, so watching in sequence reuses one screen', () => {
    const tabs = [seatedTab('MTT'), observerTab('WATCH_A')];
    expect(pickObserveSlot(tabs, 1, 'WATCH_B', MAX)).toEqual({ action: 'active', index: 1 });
  });

  it('NEVER takes the slot of a table you are seated at', () => {
    const tabs = [seatedTab('MTT'), lobbyTab];
    // Standing on the seated table: it must survive, and the free lobby tab
    // takes the new table instead.
    expect(pickObserveSlot(tabs, 0, 'NEW', MAX)).toEqual({ action: 'lobby', index: 1 });
  });

  it('focuses a table that is already open rather than duplicating it', () => {
    const tabs = [seatedTab('MTT'), lobbyTab, observerTab('WATCH_A')];
    expect(pickObserveSlot(tabs, 1, 'WATCH_A', MAX)).toEqual({ action: 'focus', index: 2 });
  });

  it('appends when every open tab is a live seat and there is room', () => {
    const tabs = [seatedTab('A'), seatedTab('B')];
    expect(pickObserveSlot(tabs, 0, 'C', MAX)).toEqual({ action: 'append', index: 2 });
  });

  it('refuses out loud at four live seats instead of silently doing nothing', () => {
    const tabs = [seatedTab('A'), seatedTab('B'), seatedTab('C'), seatedTab('D')];
    expect(pickObserveSlot(tabs, 0, 'E', MAX)).toEqual({ action: 'full', index: -1 });
  });

  it('survives an activeIndex that points past the end', () => {
    // The clamp lives in the container; the helper must not throw or claim a
    // slot that does not exist.
    const tabs = [seatedTab('A')];
    expect(pickObserveSlot(tabs, 7, 'B', MAX)).toEqual({ action: 'append', index: 1 });
    expect(pickObserveSlot([], 0, 'B', MAX)).toEqual({ action: 'append', index: 0 });
  });
});

describe('a table the server moved you off is closed on rebuild', () => {
  it('prunes a REBUILT tab whose seat is gone (the reload case that was exempt)', () => {
    // This is the regression. A tab built by the rebuild carries no `kind`, so
    // the old `kind === 'table' && seated` predicate skipped it forever, and
    // after any reload that is every tab the player has.
    const tabs = [rebuiltTab('GONE'), rebuiltTab('LIVE')];
    expect(pruneStaleSeatedTabs(tabs, new Set(['LIVE'])).map((t) => t.id)).toEqual(['LIVE']);
  });

  it('prunes a TABLE_SEATED tab whose seat is gone', () => {
    const tabs = [seatedTab('GONE'), seatedTab('LIVE')];
    expect(pruneStaleSeatedTabs(tabs, new Set(['LIVE'])).map((t) => t.id)).toEqual(['LIVE']);
  });

  it('never prunes a lobby tab or an observer — the player opened those', () => {
    const tabs = [lobbyTab, observerTab('WATCH'), seatedTab('GONE')];
    expect(pruneStaleSeatedTabs(tabs, new Set()).map((t) => t.id)).toEqual(['lobby:1', 'WATCH']);
  });

  it('keeps every tab when the server still has all the seats', () => {
    const tabs = [rebuiltTab('A'), seatedTab('B'), lobbyTab];
    expect(pruneStaleSeatedTabs(tabs, new Set(['A', 'B']))).toHaveLength(3);
  });
});
