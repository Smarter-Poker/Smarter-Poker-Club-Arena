import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const page = read('src/pages/ClubHomePage.tsx');
const pageCss = read('src/pages/ClubHomePage.css');
const identityCard = read('src/components/club-buttons/ClubIdentityCard.tsx');
const identityCardCss = read('src/components/club-buttons/ClubIdentityCard.css');
const wallet = read('src/components/wallet/DynamicWallet.tsx');
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
    expect(page).toContain("currentUser?.display_name || currentUser?.username || 'Player'");
    expect(page).toContain('playerId={currentUser?.player_number}');
    expect(page).toContain('playersPlaying={playersPlaying}');
    expect(identityCard).toContain('club-identity-template-no-level-v3.png');
    /* Dan 2026-09-01, verbatim: "ANYTIME A NEW CLUB IS CREATED, IT NEEDS TO
       START AT LEVEL 1, THAT NEEDS TO BE BELOW THE LOGO INSIDE A BLUE BOX,
       NOT OVERLAPPING THE LOGO." #2509 cured the old overlap by deleting the
       level and pinned the deletion here; the order was the other cure. The
       pin now guards the ordered state: the level RENDERS, in its own blue
       box, in the logo's column, starting beneath the logo square. */
    expect(identityCard).toContain('club-identity__level');
    expect(identityCardCss).toContain('.club-identity__level');
    expect(identityCardCss).toContain('top: 72.8%');
    expect(identityCardCss).toContain('linear-gradient(180deg, #1c4fd8 0%, #0f2f8c 100%)');
    expect(identityCard).toContain('Copy Referral Link');
    expect(identityCardCss).toContain('aspect-ratio: 1650 / 953');
    expect(identityCardCss).toContain('line-height: 1.18');
    expect(identityCardCss).toContain('top: 52%');

    /* ── THE CARD ONLY SHRINKS (Dan, 2026-09-01) ───────────────────────────
       These four pins replace `translateY(1.65cqw)`, `margin-top: 1.4cqw`,
       and the `@media (pointer: coarse)` block that sized the share BUTTON to
       44x44px. Each of those was a width-derived nudge or a pixel size applied
       to a card whose height comes from its aspect ratio, so the card laid
       itself out differently at 375px than at 1024px - measured live before
       this pass: the club ID line sat 3.37% below its icon on desktop and
       8.09% below it on mobile, and the share button was 61% of the card's
       height with its icon 3.7% outside the painted copy frame.

       What is pinned now is the cure: the ID lines have their own bay pinned
       to the artwork icons, the share button occupies the painted frame in
       percentages, and the 44px thumb target is an invisible `::after` band
       that paints nothing and so cannot move anything. */
    expect(identityCardCss).toMatch(
      /\.club-identity__ids\s*\{[^}]*top:\s*47\.06%[^}]*height:\s*21\.46%/s
    );
    expect(identityCardCss).toMatch(
      /\.club-identity__share\s*\{[^}]*left:\s*75\.92%[^}]*top:\s*65\.19%[^}]*width:\s*9\.68%[^}]*height:\s*15\.88%/s
    );
    expect(identityCardCss).toMatch(
      /\.club-identity__share::after\s*\{[^}]*width:\s*max\(100%, 44px\)[^}]*height:\s*max\(100%, 44px\)/s
    );
    /* Dan 2026-09-02: SVG size updated 3.75cqw → 4cqw to properly centre
       the icon inside the painted button frame at every card width. */
    expect(identityCardCss).toMatch(
      /\.club-identity__share svg\s*\{[^}]*width:\s*4cqw[^}]*height:\s*4cqw/s
    );
    /* No breakpoint may rearrange this card, and no painted size may stop
       scaling. A `clamp()` with a rem or px bound is a rearrangement waiting
       for a narrow enough card - that is exactly what shipped the bug. */
    const identityRules = identityCardCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(identityRules).not.toContain('@media (max-width');
    expect(identityRules).not.toContain('@media (pointer: coarse)');
    expect(identityRules).not.toContain('rem)');
    expect(identityCardCss).not.toContain('translateY(1.44cqw)');
  });

  it('spells out Bad Beat Jackpot and opens the existing detail modal', () => {
    expect(page).toContain('className="lobby-bbj"');
    expect(page).toContain('>Bad Beat Jackpot</span>');
    expect(page).toContain('setShowBBJInfo(true)');
    expect(page).toContain('showBBJ={false}');
  });

  it('stacks the approved long wallet art beneath the BBJ with live values', () => {
    expect(page).toContain('compactLobby');
    expect(wallet).toContain('clubLobbyWalletRows(rowRole)');
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

  it('fits every mobile control without a horizontal reveal row', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(mobileConsole).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(pageCss).toContain('display: contents');
    expect(mobileConsole).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(mobileConsole).toContain('overflow: visible');
  });

  it('uses the same self-contained identity card on mobile and a smaller two-line club notice', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(pageCss).toContain('@media (max-width: 480px)');
    expect(pageCss).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(identityCardCss).toContain('@media (max-width: 360px)');
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
