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
 *   2. listsPaintedRef - the fast path does not run once the chain has painted.
 *
 * Guard 2 is deliberately NOT `hasDataRef`, which a cached boot has already set
 * true while the tournament list is still empty; see the hostile-state block
 * below for the blank-board regression that would have caused.
 *
 * Also pinned: the search box is gone (Dan, same message: "you can remove the
 * Search Games By Name field, nobody is ever typing the name of a game, remove
 * it completely"), and it is gone rather than hidden.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFastRows } from '../../src/pages/ClubHomePage';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

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
  it('bails out when the chain has already painted this club lists', () => {
    // The guard must sit BETWEEN the lobbyPainted check and the setters, so a
    // reload returns before touching either list.
    const start = PAGE.indexOf('if (lobbyPainted) return;');
    const setters = PAGE.indexOf('setTournaments((prev) => mergeFastRows(');
    expect(start, 'the lobbyPainted guard is gone').toBeGreaterThan(-1);
    expect(setters, 'the fast-path tournament setter is gone').toBeGreaterThan(-1);

    const between = PAGE.slice(start, setters);
    expect(between, 'a warm reload can still repaint from the narrow RPC').toContain(
      'if (listsPaintedRef.current) return;'
    );
  });

  /**
   * HOSTILE STATE - the regression this nearly shipped as.
   *
   * `hasDataRef` is seeded `Boolean(bootCache?.club)`, and the boot cache
   * stores `{ club, tables }` with NO tournaments. So a returning player with
   * a warm localStorage entry mounts with hasDataRef ALREADY TRUE and an empty
   * tournament list. Gating the fast path on it would skip the very call that
   * fills that list and leave the MTT board blank until the slow chain landed
   * - trading a flicker for a blank screen on the commonest visit there is.
   *
   * The guard must therefore be a ref that only the CHAIN sets.
   */
  it('does NOT gate on hasDataRef, which a cached boot has already set true', () => {
    const start = PAGE.indexOf('if (lobbyPainted) return;');
    const setters = PAGE.indexOf('setTournaments((prev) => mergeFastRows(');
    const between = PAGE.slice(start, setters);
    expect(
      between,
      'a cached boot would skip the fast path and paint no tournaments'
    ).not.toContain('if (hasDataRef.current) return;');
  });

  it('the guard ref is set by the chain and cleared per club', () => {
    expect(PAGE, 'nothing ever sets it, so the fast path would run forever').toContain(
      'listsPaintedRef.current = true;'
    );
    expect(PAGE, 'switching clubs would never get the fast path again').toContain(
      'listsPaintedRef.current = false;'
    );
    // Cleared in the per-club reset, beside the other per-club refs.
    const reset = PAGE.indexOf('hasDataRef.current = false;');
    expect(sliceEnclosingBlock(PAGE, 'hasDataRef.current = false;')).toContain(
      'listsPaintedRef.current = false;'
    );
  });

  it('the boot cache still carries no tournaments, which is what makes the above necessary', () => {
    // If this ever changes, the guard above can be simplified - and this test
    // is the tripwire that says so rather than letting it rot.
    expect(PAGE).toContain(
      'function setClubHomeCache(clubId: string, data: { club: any; tables: any[] })'
    );
    expect(PAGE).toContain('const [tournaments, setTournaments] = useState<TournamentData[]>([]);');
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ZERO-ASSUMPTION DOCTRINE: replay the reported sequence and prove it is gone
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tests above check the pieces. This one replays what Dan actually saw:
 * a lobby sitting open while reload after reload delivers the narrow RPC rows.
 * If ANY field that determines a card's rendered height changes between
 * reloads, the card moves - and that is the whole complaint.
 *
 * These are the five fields, and what each one draws:
 *   blind_structure  -> the blinds sub-line, Blind Levels chip, Format chip
 *   level_started_at -> the late-registration countdown
 *   is_bounty        -> the bounty badge
 *   spin_multiplier  -> the Spin badge
 *   prize_pool       -> the guarantee line
 */
describe('DOCTRINE: replaying the recording - the cards must not move', () => {
  /** Everything that decides how tall a card renders. */
  const cardShape = (row: any) => ({
    blind_structure: row.blind_structure,
    level_started_at: row.level_started_at,
    is_bounty: row.is_bounty,
    spin_multiplier: row.spin_multiplier,
    prize_pool: row.prize_pool,
  });

  it('survives twenty consecutive warm reloads without a single field changing', () => {
    // The lobby as the authoritative chain first painted it.
    let onScreen: any[] = [wideRow];
    const before = cardShape(onScreen[0]);

    // Twenty reloads. In the recording these came from the 90s timer, tab
    // focus, TOURNAMENT_UPDATED and WAITLIST_PROMOTED; the source does not
    // matter, only that each one delivers the narrow row.
    for (let reload = 0; reload < 20; reload++) {
      onScreen = mergeFastRows(onScreen, [
        // current_level genuinely advances - the card SHOULD track that.
        { ...narrowRow, current_level: 6 + reload },
      ]) as any[];

      expect(cardShape(onScreen[0]), `card changed shape on reload ${reload + 1}`).toEqual(before);
    }

    // ...and the one thing that legitimately moved, did.
    expect(onScreen[0].current_level).toBe(25);
    expect(onScreen).toHaveLength(1);
  });

  it('survives the realtime patch shape too - a single changed column', () => {
    // Supabase can deliver an UPDATE carrying only the primary key and what
    // changed. Same class of partial row, same guarantee required.
    const patched = mergeFastRows([wideRow], [{ id: 't1', current_players: 31 } as any]) as any[];
    expect(cardShape(patched[0])).toEqual(cardShape(wideRow));
  });

  it('a mid-flight drop leaves the painted rows exactly as they were', () => {
    /* If the RPC rejects or resolves empty, ClubHomePage's `.catch()` paints
       nothing at all ("Best effort only. The authoritative chain below is
       untouched"). The list-level equivalent is an empty incoming array, and
       it must return the SAME rows rather than an empty lobby. */
    const dropped = mergeFastRows([wideRow], []) as any[];
    expect(dropped).toEqual([wideRow]);
    expect(cardShape(dropped[0])).toEqual(cardShape(wideRow));
  });

  it('a row the fast path clipped does not blink out and back', () => {
    /* get_club_home applies its own limit. A row missing from its answer is
       not evidence the tournament ended - only the chain and the realtime
       DELETE branch remove rows. Dropping it here would be a card vanishing,
       which is the same defect wearing a different hat. */
    const kept = mergeFastRows([wideRow, { id: 't9', name: 'Clipped' } as any], [narrowRow]);
    expect(kept.map((r: any) => r.id)).toEqual(['t1', 't9']);
  });

  it('the stale-cache path cannot resurrect a lobby from a six-month-old entry', () => {
    /* HOSTILE STATE, the bookmark case. Two independent defences, both read
       off the page rather than assumed:
         1. the cache key is VERSIONED, so an entry written by an older build
            is not even looked at - it is a different key;
         2. a v3 entry older than the TTL is discarded on read.
       Either way getClubHomeCache returns null, hasDataRef starts false, and
       the fast path runs normally instead of a stale lobby being restored. */
    expect(PAGE).toMatch(/const CLUB_HOME_CACHE_VER = 'v\d+';/);
    expect(PAGE).toContain('const CLUB_HOME_CACHE_TTL_MS');
    expect(PAGE).toContain('if (Date.now() - parsed.at > CLUB_HOME_CACHE_TTL_MS) return null;');
    // And storage that THROWS (Safari private mode, sandboxed frame) must not
    // abort the club load.
    expect(PAGE).toMatch(/function getClubHomeCache[\s\S]{0,900}catch \{\s*return null;/);
  });

  it('a late answer from a club the player already left cannot paint', () => {
    // The per-load token: a slow RPC for club A resolving after the player
    // moved to club B is discarded rather than painting A's games over B's.
    expect(PAGE).toContain('const stale = () => loadToken !== loadTokenRef.current;');
    expect(PAGE).toContain('if (stale() || (getIsMounted && !getIsMounted())) return;');
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
