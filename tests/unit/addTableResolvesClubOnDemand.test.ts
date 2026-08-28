import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';

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
    //
    // The guard reads `if (!club && !tableClubId)` since 2026-08-26: there are
    // now TWO ways to know where the games are, and having either one is
    // enough to show a sheet. See the union-scope test below.
    const tail = HANDLER.slice(
      HANDLER.indexOf('if (!club && !tableClubId) {', HANDLER.indexOf('clubLookupCacheRef'))
    );
    expect(tail).toMatch(/setQuickJoin\(\{ open: false/);
  });

  it('UNION SCOPE: the candidate query is not narrowed to the navigation club', () => {
    /* Dan 2026-08-26: "when you click the + button on the game page, and get
       the QUICK JOIN pop up, thats not working."

       It reported "No Open Seats Right Now" on a club with 44 open cash tables
       and 25 free seats. `commitHomeClub` deliberately never returns a union
       (UNION LAW, pinned above) because navigating a player into the union hub
       would show them the union treasury — but every Midway table carries
       `club_id = <Midway Union>`, so using that same answer to SCOPE THE QUERY
       matched literally nothing, for every union player, every time.

       Navigation and data scope are two different questions. The query asks
       both ids; `commitHomeClub` still answers the navigation one alone. */
    expect(HANDLER).toMatch(/scopeClubIds[\s\S]{0,200}tableClubId/);
    expect(HANDLER).toMatch(/\.in\('club_id', scopeClubIds\)/);
    // The old single-club scope must not come back.
    expect(HANDLER).not.toMatch(/\.eq\('club_id', club\)/);
  });

  it('reads a whole club rather than sampling it, in a defined order', () => {
    /* `.limit(30)` with no `.order()` returns whichever rows the scan reaches
       first. On a 44-table club that hid fourteen tables at random — and when
       the hidden ones were the player's own stakes, the sheet reported them as
       not existing. It also dropped the ACTIVE table's row often enough to
       matter, and without that row the current variant is unknown, which
       silently disables the entire same-game ranking. */
    expect(HANDLER).toMatch(/\.order\('current_players', \{ ascending: false \}\)/);
    // Deliberately no `not.toMatch(/\.limit\(30\)/)`: the note above the query
    // NAMES the old limit to explain what it broke, and a test that forbids a
    // string forbids the comment that records why it was wrong.
    expect(HANDLER).toMatch(/\.limit\(QUICK_JOIN_CANDIDATE_LIMIT\)/);
  });

  it('the active row is fetched directly rather than assumed present', () => {
    /* Everything in the sheet is measured against the ACTIVE table's row.
       Without its game_variant every candidate falls to the 'other' tier and
       the same-game ranking switches itself off silently. The 200-row fetch
       holds it in any ordinary club, but a union hub with more than 200 open
       tables is the shape this platform actually has. */
    expect(HANDLER).toMatch(/if \(activeTableId && !activeRow\)/);
    expect(HANDLER).toMatch(/\.eq\('id', activeTableId\)/);
    // The rare-miss lookup must not be able to hang the sheet.
    const miss = sliceBlockAfter(HANDLER, 'if (activeTableId && !activeRow)');
    expect(miss).toMatch(/withTimeout/);
  });

  it('the stakes label is the lobby formatter, not string interpolation', () => {
    /* The same table must not read "0.5/1" here and "0.50/1" in the lobby, and
       a fixed-limit table's stakes are its BET SIZES, not its blinds. The
       string also travels onto the new tab as ?stakes=, so a wrong label here
       became a wrong label on the table itself. */
    expect(HANDLER).toMatch(/stakesLabel\(/);
    expect(HANDLER).not.toMatch(/`\$\{t\.smallBlind\}\/\$\{t\.bigBlind\}`/);
    expect(SRC).toMatch(/import \{ stakesLabel \} from '\.\.\/lib\/bettingStructure'/);
  });

  it('the current stake is read variant-aware when it falls back to the label', () => {
    expect(HANDLER).toMatch(/bigBlindFromStakesLabel\(activeStakes, activeVariant\)/);
  });

  it('a missing seat cap is not read as a full table', () => {
    // `current_players < (max_players || 0)` evaluates 0 < 0 for any row with
    // no recorded capacity, so a data gap presented as "no seats".
    expect(HANDLER).toMatch(/const hasRoom =/);
    expect(HANDLER).not.toMatch(/Number\(r\.max_players\) \|\| 0\)/);
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
