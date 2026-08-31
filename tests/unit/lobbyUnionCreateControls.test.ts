import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');
const pageCss = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.css'), 'utf8');
const table = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.tsx'), 'utf8');
const css = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');

describe('club lobby creation controls', () => {
  it('shows creation to authorized staff in standalone and union clubs', () => {
    // `noticeEditable` is the shared owner/staff authority predicate. Game
    // creation is a club capability, so standalone clubs must not be hidden
    // behind the union-only condition that used to make a new club inert.
    expect(page).toContain("noticeEditable && gameType !== 'ALL'");
    expect(page).not.toContain('(isOwner || isClubStaff(userRole)) && club?.is_union === true');
    expect(page).not.toContain("userRole === 'admin') && club?.is_union");
    expect(page).not.toContain('(!isInUnion || club?.is_union)');
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
