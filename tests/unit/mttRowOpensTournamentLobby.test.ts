/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLICKING A TOURNAMENT ROW OPENS THE TOURNAMENT LOBBY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25:
 *
 *   "FIRST, WHEN YOU CLICK ANY OF THE MTT FIELDS IN THE DISPLAY INSIDE OF ALL
 *    OR MTT, IT SHOULD OPEN TO THE TOURNAMENT LOBBY."
 *
 * Before this, `openEntry` routed to `/tournaments/<id>` only when the MTT had
 * already started — running, late_reg or completed. A REGISTERING or
 * STARTING SOON tournament opened the GameLobbyPanel drawer instead, so the
 * same row led to two different screens depending on a clock the player cannot
 * see. Every MTT row now goes to the tournament's own lobby, at every status,
 * on both the ALL tab and the MTT tab.
 *
 * Two things this must NOT do, and both are pinned below:
 *
 *  - CASH ROWS ARE UNCHANGED. The drawer is where a cash buy-in is chosen; it
 *    is not a tournament detour. Spin and SNG rows are seat-first and keep it
 *    too. Only `kind === 'mtt'` routes.
 *  - IT STILL SPENDS NOTHING. Selecting a row never joins, registers or buys
 *    in (tests/e2e/club-lobby.spec.ts is the live guard). A tournament lobby
 *    is a read-only screen: TournamentDetails registers only from its sign-up
 *    modal, and its auto-seat effect requires an existing tournament_players
 *    row carrying a table_id, which an unregistered player does not have.
 *
 * These read the source rather than rendering it for the same reason
 * allTabScope.test.ts does: the rule lives in one callback inside a
 * 3,200-line page component, and standing up the whole club-loading machinery
 * to reach three lines buys nothing an assertion that names the rule does not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '../..', 'src/pages/ClubHomePage.tsx'), 'utf8');

/** The body of the row-selection callback. */
const openEntryBody = (() => {
  const start = src.indexOf('const openEntry = useCallback(');
  expect(start, 'openEntry has moved or been renamed').toBeGreaterThan(-1);
  const end = src.indexOf('preloadRoute(`/table/${entry.id}`);', start);
  expect(end, 'openEntry no longer ends by preloading the table route').toBeGreaterThan(start);
  return src.slice(start, end);
})();

describe('an MTT row opens the tournament lobby at every status', () => {
  it('routes on the kind alone', () => {
    expect(openEntryBody).toContain("if (entry.kind === 'mtt') {");
    expect(openEntryBody).toContain('openTournamentLobby(entry.id);');
  });

  it('never reads a status to decide', () => {
    for (const status of ['running', 'late_reg', 'completed', 'registering', 'starting_soon']) {
      expect(
        openEntryBody.includes(`entry.status === '${status}'`),
        `openEntry gates the tournament lobby on status '${status}' again`
      ).toBe(false);
    }
  });
});

describe('a cash row still opens the game lobby panel', () => {
  it('falls through to the panel for everything that is not an MTT', () => {
    const afterGuard = openEntryBody.slice(openEntryBody.indexOf('openTournamentLobby(entry.id);'));
    expect(afterGuard).toContain('setSelectedId(entry.id);');
    expect(afterGuard).toContain('setPanelOpen(true);');
  });

  it('does not route spin or sng rows away from the panel', () => {
    expect(/kind === 'cash'/.test(openEntryBody)).toBe(false);
    expect(/kind === 'spin'/.test(openEntryBody)).toBe(false);
    expect(/kind === 'sng'/.test(openEntryBody)).toBe(false);
  });
});

describe('there is exactly one route to a tournament lobby', () => {
  const helper = (() => {
    const start = src.indexOf('const openTournamentLobby = useCallback(');
    expect(start, 'the openTournamentLobby helper has moved or been renamed').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('[navigate]', start));
  })();

  it('the helper is the only place that builds the path', () => {
    const built = src.match(/navigate\(`\/tournaments\/\$\{[^}]+\}`\)/g) || [];
    expect(
      built.length,
      'a second hand-rolled navigate to /tournaments/<id> can drift from the helper'
    ).toBe(0);
    expect(helper).toContain('const target = `/tournaments/${tournamentId}`;');
    expect(helper).toContain('navigate(target);');
  });

  it('a double click cannot push a duplicate history entry', () => {
    // The row fires onSelect on click AND onActivate on double click; both are
    // openEntry. The helper is a no-op once the path is already current.
    expect(helper).toContain('if (window.location.pathname.endsWith(target)) return;');
    expect(src).toContain('onSelect={openEntry}');
    expect(src).toContain('onActivate={openEntry}');
  });

  it('the Details button and the post-registration hand-off use the same helper', () => {
    /* UPDATED 2026-08-28, same commit as the behaviour change it pins: a
       seat-first row (spin, or a 2-seat heads-up sng) has NO lobby screen —
       Dan 2026-08-20: "there is 'no lobby' for a spin, you just start on a
       table" — so its view action opens the live TABLE via spinQuickJoin.
       Cash still goes to the table route, and everything else (MTTs and
       multi-seat SNGs) still goes through the one openTournamentLobby
       helper. The onViewTable ternary now carries three arms; pin each. */
    const viewBody = (() => {
      const start = src.indexOf('onViewTable: (e) =>');
      expect(start, 'onViewTable has moved or been renamed').toBeGreaterThan(-1);
      return src.slice(start, src.indexOf('}),', start));
    })();
    expect(viewBody).toContain("e.kind === 'cash'");
    expect(viewBody).toContain('navigate(`/table/${e.id}`)');
    expect(viewBody).toContain(
      "e.kind === 'spin' || (e.kind === 'sng' && e.capacity > 0 && e.capacity <= 2)"
    );
    expect(viewBody).toContain('spinQuickJoin(');
    expect(viewBody).toContain('openTournamentLobby(e.id)');
    expect(src).toContain('setTimeout(() => openTournamentLobby(t.id), 0);');
  });
});

describe('selecting a row still spends nothing', () => {
  it.each(['registerMtt', 'handleRegister', 'handleJoinTable'])(
    'openEntry does not call %s',
    (forbidden) => {
      expect(
        openEntryBody.includes(forbidden),
        `openEntry calls ${forbidden}, which commits the player`
      ).toBe(false);
    }
  );

  it('the only table reference left in the callback is a module preload', () => {
    expect(src).toContain('preloadRoute(`/table/${entry.id}`);');
    expect(/navigate\(`\/table\/\$\{entry\.id\}`\)/.test(openEntryBody)).toBe(false);
  });
});
