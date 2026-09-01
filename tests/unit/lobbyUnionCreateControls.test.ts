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
    expect(page).toContain('const canCreateClubGames = noticeEditable && !unionManagedClub');
    expect(page).toContain('canCreateClubGames && (');
    expect(page).toContain('GameCreationActions');
    expect(gameCreationGuard).toContain('fetchGameCreationAccess');
    expect(gameCreationGuard).toContain('if (!access.allowed)');
    expect(tableConfig).toContain('const canBuildHere = access?.allowed === true');
  });

  it('keeps the desktop selector deck sticky and mobile controls inside the approved chassis', () => {
    const desktop = commandCss.slice(commandCss.lastIndexOf('@media (min-width: 901px)'));
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

  it('routes every creation action through canonical table management', () => {
    expect(creationActions).toContain("{ target: 'table', label: 'Add Table' }");
    expect(creationActions).toContain("{ target: 'event', label: 'Event' }");
    expect(creationActions).toContain("{ target: 'spin', label: 'Spins' }");
    expect(creationActions).toContain("{ target: 'sng', label: 'Sit N Go' }");
    expect(creationActions).toContain('`${managementPath}?create=${action.target}`');
    expect(management).toContain(
      '<CreateTablePage clubIdOverride={hostClubId} onBack={clearCreate} />'
    );
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
