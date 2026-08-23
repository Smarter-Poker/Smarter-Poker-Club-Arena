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
    const tail = HANDLER.slice(HANDLER.indexOf('if (!club) {', HANDLER.indexOf('clubLookupCacheRef')));
    expect(tail).toMatch(/setQuickJoin\(\{ open: false/);
  });

  it('caches what it resolved, so the next press is instant', () => {
    expect(HANDLER).toMatch(/homeClubIdRef\.current = club/);
    expect(HANDLER).toMatch(/setHomeClubId\(club\)/);
  });
});
