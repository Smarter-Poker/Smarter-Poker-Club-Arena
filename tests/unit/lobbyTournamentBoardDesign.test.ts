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
    expect(identityCard).toContain('club-identity-template-no-level-v2.png');
    expect(identityCard).not.toContain('club-identity__level');
    expect(identityCard).toContain('Copy Referral Link');
    expect(identityCardCss).toContain('aspect-ratio: 1650 / 953');
    expect(identityCardCss).toContain('line-height: 1.18');
    expect(identityCardCss).toContain('transform: translateY(1.65cqw)');
    expect(identityCardCss).toContain('top: 52%');
    expect(identityCardCss).toContain('margin-top: 1.4cqw');
    expect(identityCardCss).not.toContain('translateY(1.44cqw)');
    expect(identityCardCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.club-identity__share\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s
    );
    expect(identityCardCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.club-identity__share svg\s*\{[^}]*width:\s*3\.75cqw[^}]*height:\s*3\.75cqw/s
    );
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
