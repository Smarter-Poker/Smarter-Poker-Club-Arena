import { isDiamondHandHistoryScope } from '../../src/utils/clubScopedPath';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const details = readFileSync('src/pages/tournament/TournamentDetails.tsx', 'utf8');
const home = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
const panel = readFileSync('src/components/lobby/GameLobbyPanel.tsx', 'utf8');
describe('Diamond tournament entry denomination and return context', () => {
  it('labels the buy-in from the same authoritative arena unit as its prize consumer', () => {
    const header = details.match(/<p className="tournament-buyin">([\s\S]*?)<\/p>/)?.[1] ?? '';
    expect(header).toContain(
      'formatBuyIn(tournament.buy_in_amount, tournament.buy_in_fee, tournament)'
    );
    expect(header).toMatch(
      /tournamentRowUnitCents\(tabProps\.tournament\)\s*===\s*DIAMOND_UNIT_CENTS/
    );
    expect(header).toContain("'Diamonds'");
    expect(header).toContain("'Chips'");
    expect(header).not.toContain('Chips Buy-In');
  });
  it('carries the originating club through both lobby entry paths without a second authority', () => {
    const start = home.indexOf('const openTournamentLobby = useCallback(');
    const route = home.slice(start, home.indexOf('const openEntry = useCallback(', start));
    expect(route).toContain('navigate(withClubContext(target, clubId));');
    expect(route).toContain('if (window.location.pathname.endsWith(target)) return;');
    expect(panel).toContain('to={withClubContext(`/tournaments/${entry.id}`, clubId)}');
    expect(
      panel.match(/link: withClubContext\(`\/tournaments\/\$\{entry.id\}`, clubId\)/g)
    ).toHaveLength(2);
  });
});

describe('the Diamond archive has one scope across reader, workspace and footer', () => {
  it.each([
    '?arena=diamond',
    '?club=diamond-arena',
    '?club=002c2d27-9584-4e52-835a-bb2be148fc81',
    '?arena=diamond&club=diamond-arena',
  ])('retains the Diamond scope for %s', (search) => {
    expect(isDiamondHandHistoryScope('/hand-history', search)).toBe(true);
  });
  it.each([
    ['/hand-history', ''],
    ['/hand-history', '?club=chip-club'],
    ['/profile', '?arena=diamond'],
    ['/wallet', '?arena=diamond'],
  ])('leaves %s%s unchanged outside the explicit archive scope', (path, search) => {
    expect(isDiamondHandHistoryScope(path, search)).toBe(false);
  });
  it('feeds the same scope to the reader, footer, and route workspace without altering permissions', () => {
    const archive = readFileSync('src/pages/HandHistoryPage.tsx', 'utf8');
    const footer = readFileSync('src/components/club/clubFooterVisibility.ts', 'utf8');
    const workspace = readFileSync('src/contexts/ClubWorkspaceContext.tsx', 'utf8');
    expect(archive).toContain("isDiamondHandHistoryScope('/hand-history', searchParams)");
    expect(footer).toContain('return isDiamondHandHistoryScope(path, search);');
    expect(workspace).toContain('isDiamondHandHistoryScope(pathname, search)');
  });
});
