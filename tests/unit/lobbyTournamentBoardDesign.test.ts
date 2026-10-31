import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Source with its comments stripped.
 *
 * This codebase explains its fixes IN the file, so a NEGATIVE pin that greps
 * raw text matches the note describing the thing that was removed and reports
 * it as still present. That has cost four red runs in two days now.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const page = read('src/pages/ClubHomePage.tsx');
const pageCss = read('src/pages/ClubHomePage.css');
const identityCard = read('src/components/club-buttons/ClubIdentityCard.tsx');
const identityCardCss = read('src/components/club-buttons/ClubIdentityCard.css');
const wallet = read('src/components/wallet/DynamicWallet.tsx');
const directory = read('src/components/wallet/CashierMyWallets.tsx');
const walletCss = read('src/components/wallet/DynamicWallet.css');
const walletArtwork = read('src/components/wallet/ClubWalletArtwork.tsx');
const layout = read('src/components/layouts/AppLayout.tsx');
const filters = read('src/components/lobby/AdvancedFilters.tsx');
const filtersCss = read('src/components/lobby/AdvancedFilters.css');
const tableCss = read('src/components/lobby/LobbyTable.css');

describe('Club Arena Tournament Board lobby design', () => {
  it('keeps the global header and renders the approved dynamic Club Identity Card', () => {
    expect(layout).toContain('{showGlobalHeader && <GlobalHeader />}');
    expect(page).toContain('<ClubIdentityCard');
    expect(page).toContain('className="lobby-top__identity"');
    expect(page).toContain('club.logo_url || club.avatar_url');
    /* WAS a pin on `currentUser?.display_name || currentUser?.username ||
       'Player'` - which recorded the DEFECT. `display_name` is exactly
       `full_name` on 264 of 1,308 production rows, so that chain printed the
       player's legal name on the club card; Dan's own row is one of them, which
       is why his card read "Dan Bekavac" while his alias "KingFish" sat unread
       one column away.

       Dan 2026-09-02: "THE REAL NAME SHOULD NEVER BE DISPLAYED, IT SHOULD
       ALWAYS BE USING THE POKER ALIAS." The pin now guards the rule instead of
       the string: the card resolves through the house resolver, and never
       reaches for display_name itself. */
    expect(page).toContain("pokerAlias={playerDisplayName(currentUser, 'arena')}");
    expect(code(page)).not.toMatch(/currentUser\?\.display_name/);
    /* Dan 2026-10-16: the person line prints the REFERRAL ID - the player
       number for everyone, "KingFish" for player 1 (src/lib/referralId.ts). */
    expect(page).toContain('playerId={referralIdFor(currentUser?.player_number)}');
    expect(page).toContain('playersPlaying={playersPlaying}');
    /* ── DAN'S 2026-09-04 MASTER (kingfish-v1) ─────────────────────────────
       "YOU NEED TO MAKE THE CLUB CARD LOOK EXACTLY LIKE THIS." The card is
       now a layered chassis like every game card: the master with its dynamic
       words lifted out is the paint, and every live string is printed into a
       zone measured in pixels on that 1566 x 672 master. There is no club
       name band and no logo on the master - the name is spoken (sr-only) and
       the alias is the headline. Everything the old pins recorded (the v6
       shell, the name band, the logo column, the glow-box share button)
       belongs to the retired master and moved out with it in this commit. */
    expect(identityCard).toContain('kingfish-v1');
    expect(identityCard).toContain('CLUB_IDENTITY_CANVAS = { width: 1566, height: 672 }');
    expect(code(identityCard)).not.toContain('club-identity-template-no-level-v6.png');
    expect(code(identityCard)).not.toMatch(/className="club-identity__logo-mask"/);
    expect(identityCardCss).toContain('aspect-ratio: 1566 / 672');
    expect(identityCardCss).toContain('container-type: inline-size');

    /* The zones are pixels on the master, and every one of them is a real
       control or a real line, never a decoration. Declared once, in the
       component, so the CSS carries typography only. */
    const zoneOf = (name: string) => {
      const m = identityCard.match(
        new RegExp(`${name}: \\{ x: (\\d+), y: (\\d+), width: (\\d+), height: (\\d+) \\}`)
      );
      expect(m, `no zone declared for ${name}`).toBeTruthy();
      return { x: +m![1], y: +m![2], width: +m![3], height: +m![4] };
    };
    const alias = zoneOf('alias');
    const clubId = zoneOf('clubId');
    const playerId = zoneOf('playerId');
    const playing = zoneOf('playing');
    const invite = zoneOf('invite');
    const share = zoneOf('share');

    // Top to bottom on the left: alias, club ID, player ID (Dan's order).
    expect(alias.y).toBeLessThan(clubId.y);
    expect(clubId.y).toBeLessThan(playerId.y);
    // The two ID lines share one column and one width past the painted icons.
    expect(clubId.x).toBe(playerId.x);
    expect(clubId.width).toBe(playerId.width);
    // Right column: the copy frame top right, the count and the invite plate beneath.
    expect(share.y).toBeLessThan(playing.y);
    expect(playing.y).toBeLessThan(invite.y);
    expect(share.x + share.width).toBeLessThanOrEqual(1566);
    // Nothing is printed outside the master.
    for (const z of [alias, clubId, playerId, playing, invite, share]) {
      expect(z.x + z.width).toBeLessThanOrEqual(1566);
      expect(z.y + z.height).toBeLessThanOrEqual(672);
    }

    /* Dan 2026-10-11: "Remove the 'Level 29' under the playing Now and
       replace that with 'Share & Invite'". The blue box is painted on the
       master; the words are live in the plate, and pressing them shares.
       Since 2026-10-12 the words are the label INSIDE the share button, not
       a second button: the plate's centre is 24px below the copy frame's on
       a 375px card, so two buttons there could never both own a 44px thumb
       band (the post-deploy sweep measured the plate at 7px, reach 0). */
    expect(identityCard).toContain('club-identity__invite');
    expect(identityCard).toContain(
      'zoneStyleWithin(CLUB_IDENTITY_ZONES.invite, CLUB_IDENTITY_ZONES.share)'
    );
    expect(identityCard).not.toMatch(/<button[^>]*className="club-identity__invite"/);
    expect(identityCard).toContain('aria-label="Share And Invite"');
    expect(identityCard).toContain("SHARE_AND_INVITE = 'Share & Invite'");
    expect(identityCard).not.toContain('Level {level}');
    expect(identityCardCss).toContain('.club-identity__invite');
    expect(identityCardCss).not.toContain('linear-gradient');

    /* Dan 2026-09-02: the real name is never printed; the alias is the
       headline and is fitted by MEASUREMENT (useFitText writes --fit), the
       way every card title is, so a long alias shrinks rather than clips. */
    expect(identityCard).toContain('useFitText<HTMLElement>(pokerAlias, 1, 0.3)');
    expect(identityCardCss).toMatch(
      /\.club-identity__alias > span\s*\{[^}]*font-size:\s*calc\(8\.1cqw \* var\(--fit, 1\)\)[^}]*white-space:\s*nowrap/s
    );

    /* The count is a live number beside the painted PLAYING NOW, lit blue
       like the master's "321", and announced with its words. */
    /* The label became conditional on 2026-09-20: a count that could not be
       read is spoken as "Playing Now Unavailable" rather than "0 Playing Now"
       (CLAUDE.md 10.86 rule 1). The known-count form is unchanged and is what
       this pins. */
    expect(identityCard).toContain('`${count} Playing Now`');
    expect(identityCardCss).toMatch(/\.club-identity__playing strong\s*\{[^}]*color:\s*#5b83e8/s);

    /* The copy button IS the painted frame (Dan 2026-09-03: "THE COPY LINK
       NEEDS TO BE INSIDE THE FRAME AND CENTERED"). It occupies the frame in
       percentages and the 44px thumb target is an invisible ::after. */
    expect(identityCard).toContain('Copy Referral Link');
    expect(identityCardCss).toMatch(
      /\.club-identity__share::after\s*\{[^}]*width:\s*max\(100%, 44px\)[^}]*height:\s*max\(100%, 44px\)/s
    );

    /* Silver is a solid colour with a bevel. A clipped gradient rendered the
       alias BLACK on Dan's phone (2026-09-03); it may not come back. */
    const identityRules = identityCardCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(identityRules).not.toContain('background-clip: text');
    expect(identityRules).not.toContain('-webkit-text-fill-color: transparent');

    /* No breakpoint may rearrange this card, and no painted size may stop
       scaling: every size is cqw against the card, so a 320px phone and a
       430px one get the same picture. No :hover (house law). */
    expect(identityRules).not.toContain('@media (max-width');
    expect(identityRules).not.toContain('@media (pointer: coarse)');
    expect(identityRules).not.toContain('rem)');
    expect(identityRules).not.toContain(':hover');
  });

  it('spells out Bad Beat Jackpot and opens the existing detail modal', () => {
    expect(page).toContain('className="lobby-bbj"');
    expect(page).toContain('>Bad Beat Jackpot</span>');
    expect(page).toContain('setShowBBJInfo(true)');
    expect(directory).toContain('showBBJ={false}');
  });

  it('preserves the approved wallet art and live values inside Cashier', () => {
    expect(directory).toContain('compactLobby');
    expect(page).not.toContain('<DynamicWallet');
    /* The lobby's rows still come from the visibility law, never inlined
       here. The call gained an arena option on 2026-09-11 (Diamond Arena
       holds no chip ledger, so it draws no club row at all), so this pins
       the call and its role argument rather than the exact old spelling. */
    expect(wallet).toContain('clubLobbyWalletRows(rowRole,');
    expect(wallet).toContain('chipWallet: hasChipWallet');
    expect(wallet).toContain("row.key === 'union_bank' || row.key === 'union_rake'");
    expect(wallet).toContain('ClubWalletShell');
    expect(walletArtwork).toContain('CLUB_WALLET_ARTWORK');
    expect(walletArtwork).toContain('wallets/desktop/${filename}-v1.webp');
    expect(walletArtwork).toContain('wallets/mobile/${filename}-v1.webp');
    expect(pageCss).toContain('grid-column: 2');

    const lobbyWalletCss = walletCss.slice(
      walletCss.indexOf('APPROVED CLUB ARENA WALLET + BBJ ART')
    );
    expect(lobbyWalletCss).toContain('flex-direction: column');
    expect(lobbyWalletCss).toContain('aspect-ratio: 1800 / 380');
    expect(lobbyWalletCss).toContain('@media (min-width: 641px)');
    expect(lobbyWalletCss).toContain('aspect-ratio: 1800 / 273');
    expect(lobbyWalletCss).toContain('font-variant-numeric: tabular-nums');
    expect(lobbyWalletCss).not.toContain('linear-gradient');
  });

  it('uses the approved BBJ plaque without baking the live jackpot amount into the image', () => {
    expect(page).toContain('<ClubBBJShell className="lobby-bbj__shell" />');
    expect(walletArtwork).toContain('bbj-dynamic-plaque-v1.webp');
    expect(page).toContain('className="lobby-bbj__amount"');
    expect(pageCss).toContain('aspect-ratio: 1600 / 560');
  });

  it('removes the redundant result-count strip and cashier prompt', () => {
    expect(page).not.toMatch(/Showing\s*<strong>/);
    expect(page).not.toContain('Cashier For More');
  });

  it('keeps game types and refinements in two compact rows without changing filter state', () => {
    const compact = pageCss.slice(pageCss.lastIndexOf('/* Two browsing rows:'));
    expect(compact).toContain('.game-bar__types');
    expect(compact).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(compact).toContain('box-sizing: border-box');
    expect(compact).toContain('min-height: 44px');
    expect(compact).toContain('flex-wrap: nowrap');
    expect(compact).toContain('overflow-x: auto');
    expect(compact).toContain('.lobby-refinements .quickprefs__row--status');
    expect(compact).toContain('.lobby-refinements .game-bar__filter-btn');
    expect(compact).not.toContain('position: sticky');
    const refinements = page.slice(page.indexOf('className="lobby-refinements"'));
    expect(refinements.indexOf('aria-label="Game Status"')).toBeLessThan(
      refinements.indexOf('className={`game-bar__filter-btn')
    );
    expect(refinements).toContain("gameType === 'ALL' ? 'Sort' : 'Filters And Sort'");
    expect(refinements).toContain('persistAdvFilters(resolvedClubId, next)');
    expect(refinements).toContain('selectFavoritesOnly(!favoritesOnly)');
    expect(refinements).toContain('isFilterActive(fSpec, fVal)');
  });

  it('uses the same self-contained identity card on mobile and a smaller two-line club notice', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(pageCss).toContain('@media (max-width: 480px)');
    expect(pageCss).toContain('grid-template-columns: minmax(0, 1fr)');
    // The identity card has no breakpoint of its own; it scales in cqw.
    expect(identityCardCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('@media');
    expect(mobileConsole).toContain('-webkit-line-clamp: 2');
  });

  it('rebuilds Filters as a solid tournament-board console', () => {
    expect(filters).toContain('Tournament Board');
    expect(filters).toContain("Apply {activeCount > 0 ? `${activeCount} ` : ''}Filters");
    expect(filters).toContain('Reset {activeTypeLabel}');
    expect(filters).toContain('Only Show Games With Every Selected Feature.');
    expect(filtersCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(filtersCss).toContain('background: #08111d');
    expect(filtersCss).toContain('z-index: 9620');
    expect(filtersCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    expect(filtersCss).not.toContain('overflow-x: auto');
  });

  it('gives mobile game cards solid raised depth and balanced data bays', () => {
    const cards = tableCss.slice(tableCss.indexOf('MOBILE TOURNAMENT-BOARD CARDS'));
    expect(cards).toContain('background: #0d1928');
    expect(cards).toContain('flex: 1 1 82px');
    expect(cards).toContain('background: #07111d');
    expect(cards).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });
});
