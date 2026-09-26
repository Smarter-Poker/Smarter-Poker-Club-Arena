import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
const pageCss = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.css'), 'utf8');
const commandCss = readFileSync(
  resolve(__dirname, '../../src/components/lobby/ClubLobbyCommandTop.css'),
  'utf8'
);
const table = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');
const tableConfig = readFileSync(resolve(__dirname, '../../src/pages/TableConfigPage.tsx'), 'utf8');
const gameCreationGuard = readFileSync(
  resolve(__dirname, '../../src/components/auth/GameCreationGuard.tsx'),
  'utf8'
);
const management = readFileSync(
  resolve(__dirname, '../../src/pages/GameManagementPage.tsx'),
  'utf8'
);
const creationActions = readFileSync(
  resolve(__dirname, '../../src/components/club/GameCreationActions.tsx'),
  'utf8'
);

describe('club lobby creation controls', () => {
  it('shows creation only to authorized standalone clubs', () => {
    /* Phase 2 (2026-09-20): this pinned `noticeEditable && !unionManagedClub`,
       where unionManagedClub was Boolean(is_union || union_id || lookup). An
       unresolved or errored lookup is `undefined`, which that read as "not a
       union" and showed staff the create controls of a union_clubs-only club.
       The gate now fails closed on a three-state scope. */
    expect(page).toContain(
      "const canCreateClubGames = noticeEditable && clubUnionScope === 'standalone'"
    );
    expect(page).toContain('const clubUnionScope = resolveClubUnionScope(club, unionIdForCreate)');
    expect(page).not.toContain('Boolean(club.is_union || club.union_id || unionIdForCreate)');
    expect(page).toContain('canCreateClubGames && (');
    expect(page).toContain('GameCreationActions');
    expect(gameCreationGuard).toContain('fetchGameCreationAccess');
    expect(gameCreationGuard).toContain('if (!canUseStandaloneClubCreationRoute(access))');
    expect(gameCreationGuard).toContain('Create Games From The Union Console');
    expect(tableConfig).toContain('const canBuildHere = access?.allowed === true');
  });

  it('keeps the complete selector deck sticky below the real header on desktop and mobile', () => {
    /* FIND THE BLOCK BY THE RULE IT OWNS, NOT BY BEING LAST (2026-09-01).
       This used to slice from `lastIndexOf('@media (min-width: 901px)')`, which
       is a guess about file order rather than a statement about the deck lock.
       The campaign-bay fix appended a SECOND desktop block below this one and
       the pin went red while `display: contents` had not moved a character.
       Anchoring on `.club-lobby-machine > .club-lobby-command-top` asserts the
       same three declarations about the block that actually declares them, so
       appending another desktop block cannot make this lie in either
       direction. */
    const deckComment = commandCss.indexOf(
      '/* Keep the complete Find Your Game selector deck available while the game'
    );
    expect(deckComment).toBeGreaterThan(-1);
    const deckOpen = commandCss.indexOf('@media (min-width: 901px)', deckComment);
    expect(deckOpen).toBeGreaterThan(-1);
    const deckEnd = commandCss.indexOf('@media', deckOpen + 1);
    const desktop = commandCss.slice(deckOpen, deckEnd === -1 ? undefined : deckEnd);
    expect(desktop).toContain('display: contents');
    expect(desktop).toContain('position: sticky');
    expect(desktop).toContain('top: 0');

    const mobileAnchor = commandCss.indexOf('/* MOBILE FIND-YOUR-GAME LOCK');
    expect(mobileAnchor).toBeGreaterThan(-1);
    const mobile = commandCss.slice(mobileAnchor);
    expect(mobile).toContain('@media (max-width: 900px)');
    expect(mobile).toContain('display: contents');
    expect(mobile).toContain('position: sticky');
    expect(mobile).toContain('--ca-global-header-height');
    expect(mobile).toContain('--ca-in-tab-header-height');
    expect(mobile).toContain('env(safe-area-inset-top, 0px)');
    expect(commandCss).toMatch(
      /\.club-lobby-machine\s*\{[^}]*width:\s*calc\(100% - 8px\)[^}]*max-width:\s*none/s
    );

    const lastTargetRule = commandCss.lastIndexOf(
      '.club-lobby-command-top .lobby-controls .game-bar__type,'
    );
    expect(lastTargetRule).toBeGreaterThan(mobileAnchor);
    const finalTargetBlock = commandCss.slice(
      lastTargetRule,
      commandCss.indexOf('}', lastTargetRule)
    );
    expect(finalTargetBlock).toContain('.game-bar__filter-btn');
    expect(finalTargetBlock).toContain('.quickprefs__chip');
    expect(finalTargetBlock).toContain('min-height: 44px');
    expect(finalTargetBlock).toContain('height: 44px');
  });

  it('routes every creation action through canonical table management', () => {
    expect(creationActions).toContain("{ target: 'table', label: 'Add Table' }");
    expect(creationActions).toContain("{ target: 'event', label: 'Event' }");
    expect(creationActions).toContain("{ target: 'spin', label: 'Spins' }");
    expect(creationActions).toContain("{ target: 'sng', label: 'Sit N Go' }");
    expect(creationActions).toContain('`${managementPath}?create=${action.target}`');
    // Embedded, and it stays embedded: picking a variant opens the config
    // form on the same page (2026-09-04) instead of a /clubs/<host> route.
    expect(management).toContain('clubIdOverride={hostClubId}');
    expect(management).toContain('onSelectGameType={openTableConfig}');
    expect(management).toContain('<CreateTournamentModal');
  });

  it('retains union-scoped cash and tournament loading for attached clubs', () => {
    expect(page).toContain("table: 'tables', filter: `union_id=eq.${unionId}`");
    expect(page).toContain("table: 'tournaments', filter: `union_id=eq.${unionId}`");
    expect(page).toContain('applyClubScope(tableQuery');
    expect(page).toContain('applyClubScope(clubTournamentQuery');
  });
});

describe('responsive tournament list redesign', () => {
  it('renders the live-board hierarchy and responsive control deck', () => {
    expect(page).toContain('Live Club Schedule');
    expect(page).toContain('Find Your Game');
    expect(page).toContain('lobby-controls__total');
    expect(pageCss).toContain('LIVE GAME BOARD');
    expect(css).toContain('LIVE EVENT BOARD');
  });

  it('marks featured rows so mobile can progressively disclose extra details', () => {
    expect(table).toContain("entry.featured ? ' is-featured' : ''");
    expect(css).toContain("tr[data-kind='mtt'].is-featured td.lt-col-tstack");
    expect(css).toContain("tr[data-kind='mtt'].is-featured td.lt-col-tlevel");
  });

  it('keeps secondary MTT structure out of compact mobile cards', () => {
    expect(css).toContain("tr[data-kind='mtt'] td.lt-col-leveltime");
    expect(css).toContain("tr[data-kind='mtt'] td.lt-col-format");
  });
});
