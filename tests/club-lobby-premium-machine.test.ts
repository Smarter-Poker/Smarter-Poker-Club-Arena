import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/ClubHomePage.tsx'), 'utf8');
const PAGE_CSS = readFileSync(resolve(ROOT, 'src/pages/ClubHomePage.css'), 'utf8');
const TOP = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.tsx'), 'utf8');
const TOP_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.css'), 'utf8');
const TABLE_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/LobbyTable.css'), 'utf8');
const CARD_CSS = readFileSync(
  resolve(ROOT, 'src/components/lobby/game-cards/ArenaGameCard.css'),
  'utf8'
);
const WALLET = readFileSync(resolve(ROOT, 'src/components/wallet/DynamicWallet.tsx'), 'utf8');
const IDENTITY_CSS = readFileSync(
  resolve(ROOT, 'src/components/club-buttons/ClubIdentityCard.css'),
  'utf8'
);
const APP_LAYOUT = readFileSync(resolve(ROOT, 'src/components/layouts/AppLayout.tsx'), 'utf8');
const HEADER_CSS = readFileSync(
  resolve(ROOT, 'src/components/navigation/GlobalHeader.module.css'),
  'utf8'
);
const GLOBALS_CSS = readFileSync(resolve(ROOT, 'src/styles/globals.css'), 'utf8');

describe('responsive premium Club Arena', () => {
  it('renders one live composition instead of using the approval screenshot as the interface', () => {
    const machine = PAGE.indexOf('className="club-lobby-machine"');
    const commandTop = PAGE.indexOf('<ClubLobbyCommandTop', machine);
    const results = PAGE.indexOf('className="club-home__games club-home__games--v2"', machine);

    expect(machine).toBeGreaterThan(-1);
    expect(commandTop).toBeGreaterThan(machine);
    expect(results).toBeGreaterThan(commandTop);
    expect(PAGE).not.toContain('CLUB_LOBBY_CHASSIS');
    expect(PAGE).not.toContain('lobby-approved-desktop-reference-v3.png');
    expect(PAGE).not.toContain('club-lobby-machine__chassis');
    expect(TOP).not.toContain('club-lobby-command-top__chassis');
  });

  it('keeps every data-bearing surface on its production component and live handlers', () => {
    expect(PAGE).toContain('<ClubIdentityCard');
    expect(PAGE).toContain('className="lobby-bbj"');
    expect(PAGE).toContain('<DynamicWallet');
    expect(PAGE).toContain('<LobbyTable');
    expect(PAGE).toContain('onSelect={openEntry}');
    expect(PAGE).toContain('onActivate={openEntry}');
    expect(PAGE).toContain('src={club.banner_url || CLUB_LOBBY_CAMPAIGN}');
    expect(PAGE).toContain(
      'const CLUB_LOBBY_ASSET_ROOT = `${import.meta.env.BASE_URL}assets/club-buttons/lobby`'
    );
  });

  it('builds the approved desktop two-column workspace without a duplicate welcome panel', () => {
    const desktop = PAGE_CSS.slice(PAGE_CSS.lastIndexOf('@media (min-width: 901px)'));

    expect(desktop).toMatch(
      /\.club-home\s*\{[^}]*grid-template-columns:\s*clamp\(320px, 26vw, 434px\) minmax\(0, 1fr\)/s
    );
    expect(desktop).toMatch(/\.lobby-top\s*\{[^}]*grid-column:\s*1/s);
    expect(desktop).toMatch(/\.club-lobby-machine\s*\{[^}]*grid-column:\s*2/s);
    expect(desktop).toContain('var(--ca-global-header-height, 0px)');
    expect(desktop).toContain('var(--bottom-nav-clearance, 86px)');
    expect(desktop).not.toContain('calc(100dvh - 274px)');
    expect(PAGE_CSS).toMatch(/\.club-mobile-welcome,[\s\S]*?display:\s*none/s);
    expect(TOP_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.club-lobby-command-top__welcome\s*\{[^}]*display:\s*none/s
    );
    expect(APP_LAYOUT).toContain('/^\\/clubs\\/[^/]+(?:\\/lobby)?$/');
    expect(APP_LAYOUT).toContain("normalizedPath.endsWith('/notifications') || isClubLobbyPage");
  });

  it('keeps the approved desktop control order on the populated ALL lobby', () => {
    const controls = PAGE.indexOf('className="lobby-controls"');
    const gameTypes = PAGE.indexOf('className="game-bar"', controls);
    const allStatuses = PAGE.indexOf('ALL_STATUS_FILTERS.map', gameTypes);
    const campaign = PAGE.indexOf('campaign={', allStatuses);
    const launch = PAGE.indexOf('<ClubLaunchProgress', campaign);
    const games = PAGE.indexOf('className="club-home__games club-home__games--v2"', launch);

    expect(PAGE).toContain('type AllStatusFilter =');
    expect(PAGE).toContain("{ key: 'OPEN_REGISTRATION', label: 'Open Registration' }");
    expect(PAGE).toContain("{ key: 'STARTING_SOON', label: 'Starting Soon' }");
    expect(gameTypes).toBeGreaterThan(controls);
    expect(allStatuses).toBeGreaterThan(gameTypes);
    expect(campaign).toBeGreaterThan(allStatuses);
    expect(launch).toBeGreaterThan(campaign);
    expect(games).toBeGreaterThan(launch);
    expect(PAGE).toContain('noticeEditable && launchTasks.some((task) => !task.complete)');
  });

  it('builds the approved mobile welcome, owner message, identity/jackpot pair, and wallet accordion', () => {
    expect(PAGE).toContain('className="club-mobile-welcome"');
    expect(PAGE).toContain('className={`club-mobile-owner-message');
    expect(PAGE).toContain('const CLUB_DESCRIPTION_MAX_LENGTH = 72');
    expect(PAGE).toContain('maxLength={CLUB_DESCRIPTION_MAX_LENGTH}');
    expect(PAGE).toContain('.slice(0, CLUB_DESCRIPTION_MAX_LENGTH)');
    expect(PAGE).toContain('className="lobby-wallets-trigger"');
    expect(PAGE).toContain('aria-expanded={walletsExpanded}');
    expect(PAGE).toContain('data-expanded={walletsExpanded}');

    const mobile = PAGE_CSS.slice(PAGE_CSS.lastIndexOf('@media (max-width: 900px)'));
    expect(mobile).toMatch(
      /\.lobby-top__main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s
    );
    expect(mobile).toMatch(
      /\.lobby-top \.club-identity\.lobby-top__identity,[\s\S]*?\.lobby-bbj\s*\{[^}]*height:\s*auto[^}]*aspect-ratio:\s*var\(--lobby-paired-card-ratio\)/s
    );
    expect(mobile).toContain('--lobby-paired-card-ratio: 2.4 / 1');
    expect(mobile).toMatch(
      /\.lobby-wallets-content\s*\{[^}]*grid-template-rows:\s*0fr[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s
    );
    expect(mobile).toMatch(
      /\.lobby-wallets-content\[data-expanded='true'\]\s*\{[^}]*grid-template-rows:\s*1fr[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s
    );
  });

  it('keeps collapsed wallet controls inert and gives Share a full mobile hit area', () => {
    const mobile = PAGE_CSS.slice(PAGE_CSS.lastIndexOf('@media (max-width: 900px)'));
    expect(mobile).toMatch(
      /\.lobby-wallets-content\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s
    );
    expect(mobile).toMatch(
      /\.lobby-wallets-content\[data-expanded='true'\]\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s
    );
    expect(IDENTITY_CSS).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.club-identity__share\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s
    );
  });

  it('keeps the populated mobile lobby above fixed navigation and phone safe areas', () => {
    const mobile = PAGE_CSS.slice(PAGE_CSS.lastIndexOf('@media (max-width: 900px)'));
    expect(mobile).toMatch(
      /\.club-home\s*\{[^}]*padding-bottom:\s*calc\(var\(--bottom-nav-clearance, 74px\) \+ 44px\)/s
    );
    expect(mobile).not.toContain('padding-bottom: calc(var(--bottom-nav-height, 74px)');
  });

  it('shows every role-authorized wallet on both desktop and mobile', () => {
    expect(PAGE).toContain('showAllLobbyWallets');
    expect(PAGE).toContain('onVisibleWalletCountChange={setVisibleWalletCount}');
    expect(PAGE.indexOf('className="lobby-top__house-welcome"')).toBeGreaterThan(
      PAGE.indexOf('onVisibleWalletCountChange={setVisibleWalletCount}')
    );
    expect(WALLET).toContain('showAllLobbyWallets?: boolean');
    expect(WALLET).toContain('data-wallet-key="diamonds"');
    expect(WALLET).toContain('data-wallet-key={row.key}');
    expect(WALLET).toContain('onVisibleWalletCountChange?.(visibleWalletCount)');
    expect(PAGE_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.lobby-wallets-content__inner\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s
    );
    expect(PAGE_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.lobby-top__wallet\s*\{[^}]*align-self:\s*stretch[^}]*width:\s*100%[^}]*max-width:\s*100%/s
    );
    expect(PAGE_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.lobby-top__wallet \.dw--lobby-board \.dw__row\s*\{[^}]*display:\s*block/s
    );
    expect(PAGE_CSS).not.toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.lobby-top__wallet \.dw--lobby-board \.dw__row\s*\{[^}]*display:\s*none/s
    );
    expect(PAGE_CSS).toContain('aspect-ratio: 1800 / 334');
    expect(PAGE_CSS).toMatch(
      /\.lobby-top__wallet \.dw--lobby-board \.dw__row--wallet-art \.dw__row-shell\s*\{[^}]*object-fit:\s*fill/s
    );
    expect(PAGE).toContain(
      "import DiamondWalletModal from '../components/wallet/DiamondWalletModal'"
    );
    expect(PAGE).toContain('setShowDiamondWallet(true)');
    expect(PAGE).toContain('<DiamondWalletModal');
    expect(PAGE).toContain('onOpenClubRake={() => setStandaloneRakeModal(true)}');
    expect(PAGE).toContain('onOpenClubSpins={() => setStandaloneSpinsModal(true)}');
    expect(PAGE).not.toContain('navigate(`/clubs/${clubId}/detail`)');
  });

  it('keeps the desktop club card and jackpot on one premium frame footprint', () => {
    const desktop = PAGE_CSS.slice(PAGE_CSS.indexOf('@media (min-width: 901px)'));

    expect(desktop).toMatch(
      /\.lobby-top \.club-identity\.lobby-top__identity,\s*\.lobby-bbj\s*\{[^}]*width:\s*100%[^}]*aspect-ratio:\s*2\.4 \/ 1/s
    );
    expect(desktop).toMatch(
      /\.lobby-top__identity \.club-identity__shell img,\s*\.lobby-bbj__shell\s*\{[^}]*object-fit:\s*fill/s
    );
  });

  it('uses the authority desktop chrome heights without changing mobile artwork scaling', () => {
    expect(HEADER_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.desktopArtwork\s*\{[^}]*height:\s*96px[^}]*aspect-ratio:\s*auto[^}]*object-fit:\s*fill/s
    );
    expect(HEADER_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.headerControls\s*\{[^}]*height:\s*96px[^}]*aspect-ratio:\s*auto/s
    );
    expect(GLOBALS_CSS).toContain('--bottom-nav-height: clamp(44px, 13.72vw, 132px)');
  });

  it('keeps every desktop lobby table inside the premium frame', () => {
    const desktop = TOP_CSS.slice(TOP_CSS.lastIndexOf('@media (min-width: 901px)'));
    expect(desktop).toMatch(
      /\.lobby-table--all \.lt-col-tstack,[\s\S]*?\.lobby-table--all \.lt-col-format\s*\{[^}]*display:\s*none/s
    );
    expect(desktop).toMatch(/\.lobby-table--all \.lt-col-name\s*\{[^}]*width:\s*36%/s);
    expect(desktop).toMatch(/\.lobby-table--all \.lt-col-status\s*\{[^}]*width:\s*13%/s);
  });

  it('uses one desktop workspace frame instead of clipped control and campaign frames', () => {
    const desktop = TOP_CSS.slice(TOP_CSS.lastIndexOf('@media (min-width: 901px)'));
    const machine = desktop.slice(
      desktop.indexOf('.club-lobby-machine {'),
      desktop.indexOf('.club-lobby-command-top {')
    );
    expect(machine).toContain('border: 2px solid #58636d');
    expect(machine).toContain('inset 0 0 0 4px #1b2228');
    expect(desktop).toMatch(/\.club-lobby-command-top__controls\s*\{[^}]*border:\s*0/s);
    expect(desktop).toMatch(/\.club-lobby-command-top__campaign\s*\{[^}]*border:\s*0/s);
    const desktopControls = desktop.match(/\.club-lobby-command-top__controls\s*\{[^}]*\}/s)?.[0];
    const desktopCampaign = desktop.match(/\.club-lobby-command-top__campaign\s*\{[^}]*\}/s)?.[0];
    expect(desktopControls).not.toContain('border-image-source');
    expect(desktopCampaign).not.toContain('border-image-source');
  });

  it('uses live club identity for every club without a Shark-only branch', () => {
    expect(PAGE).not.toContain('exactDesktopWelcome=');
    expect(PAGE).not.toContain("toLocaleLowerCase() === 'shark club'");
    expect(TOP).not.toContain('exactDesktopWelcome');
    expect(PAGE).toContain('<h1 id="club-mobile-welcome-title" title={club.name}>');
    expect(PAGE_CSS).toMatch(
      /\.club-mobile-welcome\s*\{[^}]*lobby-header-frame-universal-v4\.png/s
    );
    expect(PAGE_CSS).not.toMatch(/\.club-mobile-welcome::before\s*\{/s);
    expect(PAGE_CSS).toContain('club-nav-shell.webp');
  });

  it('uses real selector and campaign artwork without stretching or a nested screenshot', () => {
    expect(TOP_CSS).toContain('lobby-selector-default-v3.png');
    expect(TOP_CSS).toContain('lobby-selector-active-v3.png');
    expect(TOP_CSS).toContain('lobby-preference-default-v3.png');
    expect(TOP_CSS).toContain('lobby-preference-active-v3.png');
    expect(TOP_CSS).toContain('lobby-filter-default-v3.png');

    const campaignImage = TOP_CSS.slice(
      TOP_CSS.indexOf('.club-lobby-command-top__campaign-button img')
    );
    expect(campaignImage).toContain('object-fit: cover');
    expect(campaignImage).not.toContain('object-fit: fill');
    expect(campaignImage).not.toContain('scaleY(');
  });

  it('contains the complete mobile campaign control inside its framed hit area', () => {
    const tablet = TOP_CSS.slice(
      TOP_CSS.indexOf('@media (max-width: 900px)'),
      TOP_CSS.indexOf('@media (max-width: 430px)')
    );
    expect(tablet).toMatch(/\.club-lobby-command-top__campaign\s*\{[^}]*min-height:\s*122px/s);
    expect(tablet).toMatch(
      /\.club-lobby-command-top__campaign-button\s*\{[^}]*min-height:\s*84px/s
    );

    const phone = TOP_CSS.slice(
      TOP_CSS.indexOf('@media (max-width: 430px)'),
      TOP_CSS.indexOf('@media (max-width: 900px)', TOP_CSS.indexOf('@media (max-width: 430px)'))
    );
    expect(phone).toMatch(/\.club-lobby-command-top__campaign\s*\{[^}]*min-height:\s*116px/s);
    expect(phone).toMatch(/\.club-lobby-command-top__campaign-button\s*\{[^}]*min-height:\s*78px/s);
  });

  it('keeps the desktop ledger readable and the production premium card renderer on mobile', () => {
    expect(TOP_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.club-lobby-machine\s*\{[^}]*max-width:\s*100%[^}]*box-sizing:\s*border-box/s
    );
    expect(TOP_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.club-lobby-command-top__controls\s*\{[^}]*overflow:\s*visible/s
    );
    expect(TOP_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.club-lobby-machine > \.club-home__games--v2\s*\{[^}]*max-width:\s*calc\(100% - 14px\)/s
    );
    expect(TOP_CSS).toContain('.club-lobby-machine .lobby-table .lt-status');
    expect(TOP_CSS).toContain('.club-lobby-machine .lobby-table td.lt-col-name::before');
    expect(TOP_CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.club-lobby-machine \.lobby-table\s*\{[^}]*font-size:\s*clamp\(14px, 0\.95vw, 18px\)/s
    );
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.arena-lobby-card-list\s*\{[^}]*display:\s*grid/s
    );
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \+ \.lobby-table-wrap\s*\{\s*display:\s*none/s
    );
  });

  it('keeps the reference-derived runtime slices present', () => {
    const lobbyAssets = resolve(ROOT, 'public/assets/club-buttons/lobby');
    for (const file of [
      'lobby-header-frame-v3.png',
      'lobby-header-frame-universal-v4.png',
      'lobby-controls-frame-v3.png',
      'lobby-campaign-frame-v3.png',
      'lobby-selector-default-v3.png',
      'lobby-selector-active-v3.png',
      'lobby-preference-default-v3.png',
      'lobby-preference-active-v3.png',
      'lobby-filter-default-v3.png',
      'shark-club-championship-ad-v2.png',
    ]) {
      expect(existsSync(resolve(lobbyAssets, file)), file).toBe(true);
    }
  });

  it('keeps the premium V2 card renderer through tablet widths', () => {
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.arena-lobby-card-list\s*\{[^}]*display:\s*grid/s
    );
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \+ \.lobby-table-wrap\s*\{\s*display:\s*none/s
    );
    expect(TOP_CSS).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.club-lobby-machine\s*\{[^}]*width:\s*calc\(100% - 32px\)/s
    );
    expect(TOP_CSS).not.toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.club-lobby-machine\s*\{[^}]*520px/s
    );
    expect(CARD_CSS).toMatch(
      /\.arena-game-card\[data-presentation='mobile'\]\s*\{[^}]*width:\s*var\(--agc-mobile-canvas-width, 100%\)[^}]*max-width:\s*none/s
    );
  });
});
