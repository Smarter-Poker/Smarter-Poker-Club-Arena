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

describe('club lobby creation controls', () => {
  it('shows creation only to authorized standalone clubs', () => {
    expect(page).toContain('const canCreateClubGames = noticeEditable && !unionManagedClub');
    expect(page).toContain("canCreateClubGames && gameType !== 'ALL'");
    expect(page).toContain('showCreateTournament && canCreateClubGames');
    expect(tableConfig).toContain("access?.reason === 'union_only'");
    expect(tableConfig).toContain('access?.allowed === true && !unionManagedClub');
    expect(tableConfig).toContain('Create Games From The Union Console');
  });

  it('keeps the desktop selector deck sticky and mobile controls inside the approved chassis', () => {
    /* FIND THE BLOCK BY THE RULE IT OWNS, NOT BY BEING LAST (2026-09-01).
       This used to slice from `lastIndexOf('@media (min-width: 901px)')`, which
       is a guess about file order rather than a statement about the deck lock.
       The campaign-bay fix appended a SECOND desktop block below this one and
       the pin went red while `display: contents` had not moved a character.
       Anchoring on `.club-lobby-machine > .club-lobby-command-top` asserts the
       same three declarations about the block that actually declares them, so
       appending another desktop block cannot make this lie in either
       direction. */
    const deckAnchor = commandCss.indexOf('.club-lobby-machine > .club-lobby-command-top {');
    expect(deckAnchor).toBeGreaterThan(-1);
    const deckOpen = commandCss.lastIndexOf('@media (min-width: 901px)', deckAnchor);
    expect(deckOpen).toBeGreaterThan(-1);
    const deckEnd = commandCss.indexOf('@media', deckOpen + 1);
    const desktop = commandCss.slice(deckOpen, deckEnd === -1 ? undefined : deckEnd);
    expect(desktop).toContain('display: contents');
    expect(desktop).toContain('position: sticky');
    expect(desktop).toContain('top: 0');

    const mobile = commandCss.slice(commandCss.indexOf('/* ONE-CHASSIS CONTROL LOCK'));
    expect(mobile).toContain('@media (max-width: 900px)');
    expect(mobile).toMatch(
      /\.club-lobby-command-top\s*\{[^}]*position:\s*relative[^}]*display:\s*grid/s
    );
    expect(commandCss).toMatch(
      /\.club-lobby-machine\s*\{[^}]*width:\s*calc\(100% - 8px\)[^}]*max-width:\s*none/s
    );
  });

  it('keeps cash and tournament creation on their existing flows', () => {
    expect(page).toContain('setShowCreateTournament(true)');
    expect(page).toContain('navigate(`/clubs/${clubId}/create-table/${routeVariant}`)');
    expect(page).toContain('CREATE_LABEL_FOR[gameType]');
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
