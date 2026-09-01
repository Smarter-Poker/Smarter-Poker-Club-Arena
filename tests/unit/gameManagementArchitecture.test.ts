import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const app = read('src/App.tsx');
const page = read('src/pages/GameManagementPage.tsx');
const navigation = read('src/config/clubArenaNavigation.ts');
const hamburger = read('src/components/navigation/HamburgerMenu.tsx');
const tickerPanel = read('src/components/club/TickerManagementPanel.tsx');
const ticker = read('src/components/tournament/TournamentStartingTicker.tsx');
const unionGames = read('src/pages/UnionGamesPage.tsx');
const tableConfig = read('src/pages/TableConfigPage.tsx');
const messagePanel = read('src/components/club/ClubMessageManagementPanel.tsx');
const messageService = read('src/services/ClubMessageManagementService.ts');
const clubHome = read('src/pages/ClubHomePage.tsx');
const migration = read('supabase/migrations/20260901130000_game_and_ticker_management.sql');
const lifecycleMigration = read(
  'supabase/migrations/20260902050000_managed_game_lifecycle_is_one_door.sql'
);

describe('canonical table management architecture', () => {
  it('provides club and union management routes', () => {
    expect(app).toContain('path="clubs/:clubId/table-management"');
    expect(app).toContain('<GameManagementPage scope="club" />');
    expect(app).toContain('path="unions/:unionId/table-management"');
    expect(app).toContain('<GameManagementPage scope="union" />');
    expect(unionGames).toContain('unionService.isUnionAdmin(targetUnion, user.id)');
    expect(unionGames).toContain('GameCreationActions');
  });

  it('fails closed for a club after it joins a union', () => {
    expect(page).toContain('const standaloneAccess = access.allowed && !access.unionId');
    expect(page).toContain('This Club Is Managed By Its Union');
    expect(navigation).toContain('if (canManageGames)');
    expect(hamburger).toContain('setCanManageGames(access.allowed && !access.unionId)');
    expect(hamburger).toContain('Table Management');
  });

  it('keeps mutations behind server-authoritative game ownership', () => {
    expect(migration).toContain('public.fn_can_create_games(v_club,v_uid)');
    expect(migration).toContain('public.fn_is_union_operator');
    expect(migration).toContain('public.fn_update_managed_game');
    expect(migration).toContain('public.fn_close_managed_game');
    expect(migration).toContain("'reason','players_seated'");
    expect(migration).toContain("'reason','players_registered'");
    expect(migration).not.toContain("'Table closed:'");
    expect(migration).not.toContain("'Tournament cancellation refund:");
  });

  it('never force-closes occupied games or mutates a registered tournament', () => {
    expect(lifecycleMigration).toContain('FROM public.table_seats ts');
    expect(lifecycleMigration).toContain('ts.left_at IS NULL');
    expect(lifecycleMigration).not.toContain('ts.user_id IS NOT NULL');
    expect(lifecycleMigration).toContain('FROM public.tournament_players tp');
    expect(lifecycleMigration).not.toContain('tp.user_id IS NOT NULL');
    expect(lifecycleMigration).toContain('trg_tables_managed_lifecycle_guard');
    expect(lifecycleMigration).toContain('trg_tournaments_managed_lifecycle_guard');
    expect(page).toContain('This table cannot be closed while players are seated');
    expect(page).toContain('This tournament cannot be modified after a player has registered');
    expect(page).not.toContain('cancelled and refunded');
  });

  it('keeps refund cancellation away from browser callers', () => {
    expect(lifecycleMigration).toContain(
      'REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid, uuid)'
    );
    expect(lifecycleMigration).toContain('FROM PUBLIC, anon, authenticated');
    expect(lifecycleMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) TO service_role'
    );
  });

  it('removes the private-tournament bypass for union member clubs', () => {
    expect(migration).toContain('fn_create_tournament_governed_legacy');
    expect(migration).toContain('IF NOT public.fn_can_create_games(p_club_id,v_uid)');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_create_tournament_governed_legacy(uuid,jsonb) FROM PUBLIC,anon,authenticated'
    );
  });

  it('stamps union-created cash tables into the union game scope', () => {
    expect(tableConfig).toContain('union_id: access?.unionId || null');
  });
});

describe('ticker management', () => {
  it('offers operator sources and visual controls', () => {
    for (const label of [
      'Overlay Alerts',
      'Tournament Starting Soon',
      'Custom Messages',
      'Registration Closing',
      'Guaranteed Events',
      'New Table Openings',
      'Maintenance & Service',
      'Winners & Results',
    ])
      expect(tickerPanel).toContain(label);
    expect(tickerPanel).toContain('Scroll Speed');
    expect(tickerPanel).toContain('Background Color');
    expect(tickerPanel).toContain('Text Color');
    expect(tickerPanel).toContain('Accent Color');
    expect(tickerPanel).toContain('Font');
    expect(tickerPanel).toContain('Maintenance &amp; Service Rotation');
    expect(tickerPanel).toContain('Add Service Notice');
  });

  it('wires saved controls into the live ticker', () => {
    expect(ticker).toContain('managedTicker.sources.starting_soon');
    expect(ticker).toContain('managedTicker.sources.overlays');
    expect(ticker).toContain('managedTicker.sources.registration_closing');
    expect(ticker).toContain('managedTicker.sources.table_openings');
    expect(ticker).toContain('managedTicker.sources.maintenance');
    expect(ticker).toContain('SERVICE NOTICE');
    expect(ticker).toContain("'--ticker-speed'");
    expect(ticker).toContain('managedTicker.backgroundColor');
    expect(ticker).toContain('managedTicker.fontFamily');
  });
});

describe('club message management', () => {
  it('centralizes every club identity message with explicit display limits', () => {
    expect(page).toContain('ClubMessageManagementPanel');
    expect(messagePanel).toContain('Club Tag Line');
    expect(messagePanel).toContain('Lobby Owner Message');
    expect(messagePanel).toContain('Club Description');
    expect(messagePanel).toContain('Announcement Banners');
    expect(messageService).toContain('tagline: 72');
    expect(messageService).toContain('lobbyMessage: 72');
    expect(messageService).toContain('description: 500');
    expect(messageService).toContain('announcementTitle: 100');
    expect(messageService).toContain('announcementContent: 2000');
  });

  it('keeps the one-line lobby message separate from the long description', () => {
    expect(clubHome).toContain('lobby_message');
    expect(clubHome).toContain('.update({ lobby_message: newDesc })');
    expect(migration).toContain('clubs_lobby_message_character_limit');
    expect(migration).toContain('fn_save_club_identity_messages');
    expect(migration).toContain('fn_manage_club_announcement');
  });
});
