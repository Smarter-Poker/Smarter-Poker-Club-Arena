/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MTT CARDS MUST NOT MOVE AND CHANGE ONCE THEY ARE SET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, with a screen recording: "whatever is causing the MTT cards
 * to MOVE AND CHANGE needs to stop, I don't want them moving and adjusting
 * once they are set. This is happening inside the ALL tab and the MTT tab."
 *
 * WHAT THE RECORDING SHOWS, frame by frame (17s, sampled at 2fps): a card
 * reading "CURRENT LEVEL 5 / 200/400", "BLIND LEVELS 4 Min", "FORMAT Deepst.."
 * and "Late Reg 7:48 Left" becomes "CURRENT LEVEL 5" with no blinds line, no
 * Blind Levels chip, no Format chip and "Late Reg 0:00 Left". The card shrinks
 * by ~40px, every card below jumps up, and a moment later it all comes back.
 * It repeats four times in seventeen seconds.
 *
 * ROOT CAUSE, confirmed against production rather than guessed. `get_club_home`
 * is the one-round-trip fast path, and `pg_get_functiondef` proves its
 * tournament rows select NO `blind_structure`, NO `level_started_at`, NO
 * `spin_multiplier`, NO `is_bounty` and NO `prize_pool`. Those five are
 * precisely the fields the missing chips render from. `lobbyPainted` was
 * believed to stop the fast path painting over good data, but it is a local of
 * one `loadClubData` invocation, so every reload - the 90s timer, a
 * visibilitychange, TOURNAMENT_UPDATED, WAITLIST_PROMOTED - starts a fresh one
 * at false with full rows already on screen, and `setTournaments(home.tournaments)`
 * REPLACED them.
 *
 * Two guards now, and this file pins both. Either alone leaves a hole:
 *   1. mergeFastRows - a narrower row can never erase a wider one.
 *   2. the hasDataRef check - the fast path does not run on a warm reload.
 *
 * Also pinned: the search box is gone (Dan, same message: "you can remove the
 * Search Games By Name field, nobody is ever typing the name of a game, remove
 * it completely"), and it is gone rather than hidden.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFastRows } from '../../src/pages/ClubHomePage';

const PAGE = readFileSync(join(process.cwd(), 'src/pages/ClubHomePage.tsx'), 'utf8');
const PAGE_CSS = readFileSync(join(process.cwd(), 'src/pages/ClubHomePage.css'), 'utf8');

/** A row as the AUTHORITATIVE chain fetches it: everything a card renders. */
const wideRow = {
  id: 't1',
  name: 'Late Night PKO (PLO4)',
  status: 'RUNNING',
  current_level: 5,
  blind_structure: '[{"level":1,"smallBlind":25,"bigBlind":50,"durationMinutes":4}]',
  level_started_at: '2026-08-25T19:00:00Z',
  spin_multiplier: null,
  is_bounty: true,
  prize_pool: 450,
};

/** The SAME row as `get_club_home` returns it. Five columns simply absent. */
const narrowRow = {
  id: 't1',
  name: 'Late Night PKO (PLO4)',
  status: 'RUNNING',
  current_level: 6, // the one thing genuinely fresher
};

describe('mergeFastRows - a narrower row may never erase a wider one', () => {
  it('keeps every column the incoming row does not carry', () => {
    const [merged] = mergeFastRows([wideRow], [narrowRow]) as any[];

    // The five columns get_club_home does not select. Each one is a chip that
    // vanished from the card in Dan's recording.
    expect(merged.blind_structure, 'blinds line + Blind Levels + Format chip').toBe(
      wideRow.blind_structure
    );
    expect(merged.level_started_at, 'late registration countdown').toBe(wideRow.level_started_at);
    expect(merged.is_bounty, 'bounty badge').toBe(true);
    expect(merged.prize_pool, 'guarantee line').toBe(450);
    expect('spin_multiplier' in merged, 'spin badge').toBe(true);
  });

  it('still takes the fresher value for a column the incoming row DOES carry', () => {
    const [merged] = mergeFastRows([wideRow], [narrowRow]) as any[];
    expect(merged.current_level).toBe(6);
  });

  it('treats undefined as "not selected", never as "now empty"', () => {
    const [merged] = mergeFastRows(
      [wideRow],
      [{ id: 't1', blind_structure: undefined } as any]
    ) as any[];
    expect(merged.blind_structure).toBe(wideRow.blind_structure);
  });

  it('lets an explicit null through - that is a real value, not an absent column', () => {
    const [merged] = mergeFastRows([wideRow], [{ id: 't1', prize_pool: null } as any]) as any[];
    expect(merged.prize_pool).toBeNull();
  });

  it('adds rows it has never seen', () => {
    const merged = mergeFastRows([wideRow], [narrowRow, { id: 't2', name: 'New' } as any]);
    expect(merged.map((r: any) => r.id)).toContain('t2');
  });

  it('keeps a row the incoming answer did not mention, because a limit is not a delete', () => {
    const merged = mergeFastRows([wideRow, { id: 't9', name: 'Clipped' } as any], [narrowRow]);
    expect(merged.map((r: any) => r.id)).toEqual(['t1', 't9']);
  });

  it('never returns an empty list over a painted one', () => {
    expect(mergeFastRows([wideRow], [])).toEqual([wideRow]);
  });

  it('takes the incoming list wholesale on first paint', () => {
    expect(mergeFastRows([], [narrowRow])).toEqual([narrowRow]);
  });
});

describe('the fast path cannot repaint a warm lobby', () => {
  it('bails out when this club already has rows on screen', () => {
    // The guard must sit BETWEEN the lobbyPainted check and the setters, so a
    // reload returns before touching either list.
    const start = PAGE.indexOf('if (lobbyPainted) return;');
    const setters = PAGE.indexOf('setTournaments((prev) => mergeFastRows(');
    expect(start, 'the lobbyPainted guard is gone').toBeGreaterThan(-1);
    expect(setters, 'the fast-path tournament setter is gone').toBeGreaterThan(-1);

    const between = PAGE.slice(start, setters);
    expect(between, 'a warm reload can still repaint from the narrow RPC').toContain(
      'if (hasDataRef.current) return;'
    );
  });

  it('routes BOTH fast-path lists through mergeFastRows, never a bare replace', () => {
    expect(PAGE).toContain('setTables((prev) => mergeFastRows(prev, home.tables))');
    expect(PAGE).toContain('setTournaments((prev) => mergeFastRows(prev, home.tournaments))');
    expect(PAGE, 'a bare replace is what caused the flicker').not.toContain(
      'setTournaments(home.tournaments)'
    );
    expect(PAGE).not.toContain('setTables(home.tables)');
  });
});

describe('the Search Games By Name field is gone, not hidden', () => {
  it('has no search input, placeholder or label', () => {
    expect(PAGE).not.toContain('Search Games By Name');
    expect(PAGE).not.toContain('lobby-top__searchbox');
    expect(PAGE).not.toMatch(/\btype="search"/);
  });

  it('has no search state left to filter on', () => {
    expect(PAGE).not.toMatch(/\bsearchQuery\b/);
    expect(PAGE).not.toMatch(/\bsetSearchQuery\b/);
  });

  it('drops the unused IconSearch import rather than leaving it dangling', () => {
    // An unused import is a CI-gated build failure in this repo.
    expect(PAGE).not.toContain('IconSearch');
  });

  it('removes the stylesheet rules with it', () => {
    expect(PAGE_CSS).not.toContain('.lobby-top__searchbox');
    expect(PAGE_CSS).not.toContain('.lobby-top__searchclear');
  });

  it('leaves no unreachable "Your Search And" branch in the empty state', () => {
    expect(PAGE).not.toContain('Your Search And');
  });
});
