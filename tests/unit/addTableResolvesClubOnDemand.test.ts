import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dan 2026-08-23: "when you click the + button to add a second table, it
 * doesn't create the box at the top of the screen."
 *
 * handleAddTable opens a quick-join picker filtered to the player's club. The
 * club id comes from `homeClubIdRef`, which is filled by an ASYNCHRONOUS lookup
 * of the open tables' club_id. Press "+" before that round trip lands - which
 * is precisely what happens if you sit down and immediately add a second table
 * - and the old code fell straight through to
 *
 *     masterBus.emit('OPEN_LOBBY_TAB', {})
 *
 * with no picker and no message. You get a tab you did not ask for, which is
 * indistinguishable from the button being broken.
 *
 * The club id is knowable at that moment without waiting: the table you are
 * looking at has one. This is a source-level test because the failure is a
 * RACE - a rendering test would have to lose the race deliberately to see it,
 * and would pass against the broken code on a fast machine.
 */
const SRC = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');

const HANDLER = SRC.slice(
  SRC.indexOf('const handleAddTable = useCallback('),
  SRC.indexOf('const handleQuickJoinPick')
);

/**
 * Dan 2026-08-23 (UNION LAW): the caching moved OUT of handleAddTable into
 * `commitHomeClub`, because storing `tables.club_id` verbatim is exactly what
 * put SHARK CLUB players in the MIDWAY UNION lobby — a union's games hang off
 * the union's own hub club. handleAddTable still resolves the club on demand
 * and still caches the answer; it just goes through the one writer that filters
 * unions out first. Both halves are asserted below.
 */
const COMMIT = SRC.slice(
  SRC.indexOf('const commitHomeClub = useCallback('),
  SRC.indexOf('const handleAddTable = useCallback(')
);

describe('the add-table button does not lose a race with its own lookup', () => {
  it('resolves the club from the open tables before giving up', () => {
    expect(HANDLER).toContain('clubLookupCacheRef');
    // It must actually query, not just read the cache that may also be cold.
    expect(HANDLER).toMatch(/from\('tables'\)[\s\S]{0,120}select\('id, club_id'\)/);
  });

  it('only falls back to the lobby when there is genuinely no club', () => {
    // The bail-out must come AFTER the on-demand resolution, not before it.
    const resolveAt = HANDLER.indexOf('clubLookupCacheRef');
    const bailAt = HANDLER.indexOf("masterBus.emit('OPEN_LOBBY_TAB'");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(bailAt).toBeGreaterThan(resolveAt);
  });

  it('does not strand the picker open when it bails to the lobby', () => {
    // The on-demand lookup opens the sheet in its loading state; the bail-out
    // path has to close it again or the player is left on a dead spinner.
    const tail = HANDLER.slice(
      HANDLER.indexOf('if (!club) {', HANDLER.indexOf('clubLookupCacheRef'))
    );
    expect(tail).toMatch(/setQuickJoin\(\{ open: false/);
  });

  it('caches what it resolved, so the next press is instant', () => {
    // handleAddTable hands the table's club to the one writer...
    expect(HANDLER).toMatch(/commitHomeClub\(tableClubId\)/);
    // ...and that writer is what fills both the ref and the state.
    expect(COMMIT).toMatch(/homeClubIdRef\.current = resolved/);
    expect(COMMIT).toMatch(/setHomeClubId\(resolved\)/);
  });

  it('UNION LAW: the table club is a candidate, never the stored answer', () => {
    // The bug: `homeClubIdRef.current = club` straight off `tables.club_id`,
    // which on a union game is the union's own hub club — so pressing "+"
    // inside SHARK CLUB opened the MIDWAY UNION lobby, union skins and all.
    expect(HANDLER).not.toMatch(/homeClubIdRef\.current = club\b/);
    expect(COMMIT).toContain('resolveLobbyClubId');
    expect(COMMIT).toContain('currentClubId');
  });
});
