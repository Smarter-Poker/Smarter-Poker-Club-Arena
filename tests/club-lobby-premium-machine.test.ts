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
const CARD_SHOWCASE = readFileSync(
  resolve(ROOT, 'src/pages/dev/ArenaGameCardsShowcasePage.tsx'),
  'utf8'
);
const CARD_SHOWCASE_CSS = readFileSync(
  resolve(ROOT, 'src/pages/dev/ArenaGameCardsShowcasePage.css'),
  'utf8'
);
const NLH_PREMIUM_CARD = readFileSync(
  resolve(ROOT, 'src/components/lobby/game-cards/NlhPremiumCard.tsx'),
  'utf8'
);
const NLH_PREMIUM_CSS = readFileSync(
  resolve(ROOT, 'src/components/lobby/game-cards/NlhPremiumCard.css'),
  'utf8'
);
const NLH_PREMIUM_TEMPLATE = readFileSync(
  resolve(ROOT, 'src/components/lobby/game-cards/nlhPremiumTemplate.ts'),
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
    expect(PAGE).toContain('openingChecklistEligible &&');
    expect(PAGE).toContain('launchTasks.some((task) => !task.complete && !task.skipped)');
  });

  it('builds the approved mobile welcome, identity/jackpot pair, and wallet accordion', () => {
    expect(PAGE).toContain('className="club-mobile-welcome"');
    /* The owner-message strip and its 72-character cap were pinned here until
       2026-09-03. Both are gone: the message is a full-screen greeting on
       entry, and the page-local cap went with the editor it belonged to. That
       cap was also a bug worth remembering - the page enforced 72 while the
       server accepts 240 and the desktop editor offered 240, so a message
       written on a desktop and touched on a phone was silently cut. One
       surface now, one cap, and the drift has nowhere to live. */
    expect(PAGE).not.toContain('CLUB_LOBBY_MESSAGE_MAX_LENGTH');
    expect(PAGE).toContain('className="lobby-wallets-trigger"');
    expect(PAGE).toContain('aria-expanded={walletsExpanded}');
    expect(PAGE).toContain('data-expanded={walletsExpanded}');

    expect(PAGE_CSS).toMatch(
      /\.lobby-top__main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s
    );
    expect(PAGE_CSS).toMatch(
      /\.lobby-top \.club-identity\.lobby-top__identity,[\s\S]*?\.lobby-bbj\s*\{[^}]*height:\s*auto[^}]*aspect-ratio:\s*var\(--lobby-paired-card-ratio\)/s
    );
    expect(PAGE_CSS).toContain('--lobby-paired-card-ratio: 2.4 / 1');
    expect(PAGE_CSS).toMatch(
      /\.lobby-wallets-content\s*\{[^}]*grid-template-rows:\s*0fr[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s
    );
    expect(PAGE_CSS).toMatch(
      /\.lobby-wallets-content\[data-expanded='true'\]\s*\{[^}]*grid-template-rows:\s*1fr[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s
    );
  });

  it('keeps collapsed wallet controls inert and gives Share a full mobile hit area', () => {
    expect(PAGE_CSS).toMatch(
      /\.lobby-wallets-content\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s
    );
    expect(PAGE_CSS).toMatch(
      /\.lobby-wallets-content\[data-expanded='true'\]\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s
    );
    /* The 44px now comes from an invisible `::after` band instead of from the
       button itself. Sizing the BUTTON to 44x44px made it 61% of the card's
       height at 375px and pushed the copy icon out of its painted frame, which
       is the mobile distortion Dan reported on 2026-09-01. The band gives the
       same thumb target and paints nothing. See ClubIdentityCard.css. */
    expect(IDENTITY_CSS).toMatch(
      /\.club-identity__share::after\s*\{[^}]*width:\s*max\(100%, 44px\)[^}]*height:\s*max\(100%, 44px\)/s
    );
  });

  it('keeps the populated mobile lobby above fixed navigation and phone safe areas', () => {
    /*
     * The CLEARANCE token, not the bar's artwork height: `--bottom-nav-height`
     * omits the home-indicator inset, which left a populated lobby's last card
     * 25px under the fixed nav in the authenticated production audit. That is
     * what this pin has always been about, and it is unchanged.
     *
     * The literal moved from 44px to 12px on 2026-09-02, and the pin moved
     * with it in the same commit rather than being deleted. Dan: "THERE IS TOO
     * MUCH PADDING AT THE BOTTOM ... MOVE IT SO ITS TRULY AT THE BOTTOM OF THE
     * PAGE." The bar itself had not moved - it is `position: fixed; bottom: 0`
     * - but the lobby reserved room for it TWICE and then padded that:
     * `.club-home` at clearance + 44px, and `.club-lobby-machine` at clearance
     * + 18px in ClubLobbyCommandTop.css. On a notched phone that is ~210px of
     * black under the last game card for a 78px bar, which is exactly what a
     * footer "floating in background" looks like.
     *
     * So the assertion is now about the RULE rather than the number: the page
     * reserves the clearance exactly once, and nothing downstream adds a
     * second copy of it. A pin on "+ 44px" would have gone red for the fix and
     * stayed green for the bug.
     */
    expect(PAGE_CSS).toMatch(
      /\.club-home\s*\{[^}]*padding-bottom:\s*calc\(var\(--bottom-nav-clearance, 74px\) \+ \d+px\)/s
    );
    expect(PAGE_CSS).not.toContain('padding-bottom: calc(var(--bottom-nav-height, 74px)');

    // The machine keeps a plain visual gap and never re-reserves the bar.
    expect(TOP_CSS).not.toMatch(/margin[^:]*:[^;]*var\(--bottom-nav-clearance/);
  });

  it('shows every role-authorized wallet on both desktop and mobile', () => {
    expect(PAGE).toContain('showAllLobbyWallets');
    expect(PAGE).toContain('onVisibleWalletCountChange={setVisibleWalletCount}');
    /* This line has moved twice and is now gone, which is the point.
       2026-09-01 it pinned the message strip as the LAST child of the wallet
       stack; Dan moved it to the top and the assertion was inverted to pin it
       AHEAD of the club card. On 2026-09-03 he removed it from the layout
       altogether - "not anywhere baked into the screen" - so the rail carries
       no message surface at all and the greeting is a full-screen popup on
       entry. Pinned as an ABSENCE: re-adding a message element to the rail is
       exactly the regression, and no assertion about what the rail DOES render
       would catch it. */
    expect(PAGE).not.toContain('<ClubOwnerMessage');
    expect(PAGE).not.toContain('club-mobile-owner-message');
    expect(PAGE).toContain('<ClubEntryMessage');
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
    const desktop = TOP_CSS.slice(TOP_CSS.indexOf('LOCKED CLUB ARENA DESKTOP / MOBILE SHELL'));
    expect(desktop).toMatch(
      /\.lobby-table--all \.lt-col-tstack,[\s\S]*?\.lobby-table--all \.lt-col-format\s*\{[^}]*display:\s*none/s
    );
    expect(desktop).toMatch(/\.lobby-table--all \.lt-col-name\s*\{[^}]*width:\s*36%/s);
    expect(desktop).toMatch(/\.lobby-table--all \.lt-col-status\s*\{[^}]*width:\s*13%/s);
  });

  it('uses one desktop workspace frame instead of clipped control and campaign frames', () => {
    const desktop = TOP_CSS.slice(TOP_CSS.indexOf('LOCKED CLUB ARENA DESKTOP / MOBILE SHELL'));
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
    expect(PAGE).toContain('className="club-home club-home--unified-mobile"');
    const unifiedMobile = PAGE_CSS.slice(PAGE_CSS.indexOf('/* ONE-CHASSIS MOBILE LOCK'));
    expect(unifiedMobile).toContain('.club-home--unified-mobile .club-mobile-welcome');
    expect(unifiedMobile).toMatch(/\.club-mobile-welcome span,[\s\S]*?position:\s*absolute/s);
    expect(unifiedMobile).toMatch(
      /\.lobby-wallets-trigger\s*\{[\s\S]*?background:\s*linear-gradient/s
    );
  });

  it('uses real selector and campaign artwork without stretching or a nested screenshot', () => {
    expect(TOP_CSS).toContain('lobby-selector-default-v3.png');
    expect(TOP_CSS).toContain('lobby-selector-active-v3.png');
    expect(TOP_CSS).toContain('lobby-preference-default-v3.png');
    expect(TOP_CSS).toContain('lobby-preference-active-v3.png');
    expect(TOP_CSS).toContain('lobby-filter-default-v3.png');

    const finalMobile = TOP_CSS.slice(TOP_CSS.indexOf('/* ONE-CHASSIS CONTROL LOCK'));
    expect(finalMobile).toMatch(
      /\.club-lobby-command-top__campaign-button img\s*\{[^}]*object-fit:\s*contain/s
    );
    expect(finalMobile).not.toContain('scaleY(');
    expect(PAGE).toContain('shark-club-championship-ad-mobile-v4.png');
    expect(PAGE).toContain('<picture className="club-lobby-command-top__campaign-picture">');
  });

  it('contains the complete mobile campaign control inside its framed hit area', () => {
    const finalMobile = TOP_CSS.slice(TOP_CSS.indexOf('/* ONE-CHASSIS CONTROL LOCK'));
    expect(finalMobile).toMatch(
      /\.club-lobby-command-top__campaign\s*\{[^}]*aspect-ratio:\s*2172 \/ 302/s
    );
    expect(finalMobile).toMatch(
      /\.club-lobby-command-top__campaign-button,[\s\S]*?width:\s*100%[^}]*height:\s*100%[^}]*min-height:\s*0/s
    );
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

  it('ships the locked NLH layered production asset pack', () => {
    const assetPack = resolve(
      ROOT,
      'public/assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1'
    );
    for (const file of [
      'chassis.png',
      'buttons/view-table.png',
      'buttons/join-table.png',
      'statuses/running.png',
      'statuses/live-dot.png',
      'types/nlh.png',
      'source/approved-reference.png',
      'source/restoration-mask.png',
    ]) {
      expect(existsSync(resolve(assetPack, file)), file).toBe(true);
    }

    const registry = readFileSync(
      resolve(ROOT, 'src/components/lobby/game-cards/arenaGameCardRegistry.ts'),
      'utf8'
    );
    expect(registry).toContain("'spade-nlh-premium-v1'");
    expect(NLH_PREMIUM_TEMPLATE).toContain('width: 729');
    expect(NLH_PREMIUM_TEMPLATE).toContain('height: 945');
    expect(NLH_PREMIUM_TEMPLATE).toContain('premiumZoneStyle');
    expect(NLH_PREMIUM_CARD).toContain('agc-nlh-premium__chassis');
    expect(NLH_PREMIUM_CARD).toContain('agc-nlh-premium__hitbox');
    expect(NLH_PREMIUM_CARD).not.toContain('ActionIcon');
    expect(NLH_PREMIUM_CSS).toMatch(
      /\.agc-nlh-premium__hitbox\s*\{[^}]*background:\s*transparent/s
    );
    expect(NLH_PREMIUM_CSS).not.toMatch(/\.agc-nlh-premium__hitbox(?:[^,{]*)::before/);
  });

  it('renders the NLH approval sheet and populated full mobile lobby review', () => {
    expect(CARD_SHOWCASE).not.toContain('club-mobile-owner-message');

    for (const requiredValue of [
      'NLH 25/50',
      'Insurance Test',
      '25/50',
      '3/6',
      '2,000 - 10,000',
      'Approved Reference',
      'Actual Live 430px Render',
      'Static Premium Asset Set',
      /* The Shark Club owner-message line was pinned here as proof the
         showcase mirrored the mobile lobby. The lobby has no message strip as
         of 2026-09-03, so a showcase that still drew one would be mirroring a
         page that no longer exists. Its absence is now the fidelity check. */
      '93,293.98',
      '3 Balances',
      '135',
      'Open Seats',
      'Deep Stack Cash',
      'VIEW TABLE handler fired',
      'JOIN TABLE handler fired',
    ]) {
      expect(CARD_SHOWCASE).toContain(requiredValue);
    }
    expect(CARD_SHOWCASE).toContain('skin="spade-nlh-premium-v1"');
    expect(CARD_SHOWCASE).toContain("get('review') === 'mobile'");
    expect(CARD_SHOWCASE).not.toContain('agc-calibration__difference-card');
    expect(CARD_SHOWCASE).not.toContain('ArenaGameFamily');
    expect(CARD_SHOWCASE).not.toContain('samples');
  });

  it('keeps the premium V2 card renderer through tablet widths', () => {
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.arena-lobby-card-list\s*\{[^}]*display:\s*grid/s
    );
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \+ \.lobby-table-wrap\s*\{\s*display:\s*none/s
    );
    const finalMobile = TOP_CSS.slice(TOP_CSS.indexOf('/* Final mobile composition lock'));
    expect(finalMobile).toMatch(
      /\.club-lobby-machine\s*\{[^}]*width:\s*calc\(100% - 8px\)[^}]*margin:\s*0 4px/s
    );
    expect(TOP_CSS).not.toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.club-lobby-machine\s*\{[^}]*520px/s
    );
    expect(CARD_CSS).toMatch(
      /\.arena-game-card\[data-presentation='mobile'\]\s*\{[^}]*width:\s*var\(--agc-mobile-canvas-width, 100%\)[^}]*max-width:\s*none/s
    );
  });

  it('uses the full phone and tablet viewport for the mobile Club Arena composition', () => {
    expect(PAGE_CSS).toMatch(
      /@media \(max-width: 900px\) \{[\s\S]*?\.club-home\s*\{[^}]*width:\s*100vw[^}]*max-width:\s*100vw/s
    );
    expect(PAGE_CSS).toMatch(
      /#main-content:has\(> \.club-home--unified-mobile\)[\s\S]*?padding-inline:\s*0/s
    );
    expect(PAGE_CSS).toMatch(/\.club-home--unified-mobile\s*\{[^}]*margin-left:\s*0/s);
    expect(CARD_SHOWCASE_CSS).toMatch(
      /\.agc-mobile-page\s*\{[^}]*width:\s*100vw[^}]*max-width:\s*none[^}]*margin:\s*0/s
    );
    expect(CARD_SHOWCASE_CSS).toMatch(
      /#main-content:has\(> \.agc-mobile-page\)\s*\{[^}]*padding-inline:\s*0/s
    );
    expect(CARD_SHOWCASE_CSS).not.toContain('width: min(100vw, 454px)');
    expect(TABLE_CSS).toMatch(
      /\.arena-lobby-card-list \.arena-game-card\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s
    );
  });
});
