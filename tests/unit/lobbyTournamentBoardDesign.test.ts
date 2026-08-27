import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const page = read('src/pages/ClubHomePage.tsx');
const pageCss = read('src/pages/ClubHomePage.css');
const wallet = read('src/components/wallet/DynamicWallet.tsx');
const walletCss = read('src/components/wallet/DynamicWallet.css');
const layout = read('src/components/layouts/AppLayout.tsx');
const filters = read('src/components/lobby/AdvancedFilters.tsx');
const filtersCss = read('src/components/lobby/AdvancedFilters.css');
const tableCss = read('src/components/lobby/LobbyTable.css');

describe('Club Arena Tournament Board lobby design', () => {
  it('keeps the global header and renders the club logo in the lobby identity', () => {
    expect(layout).toContain('{showGlobalHeader && <GlobalHeader />}');
    expect(page).toContain('className="lobby-club__avatar"');
    expect(page).toContain('club.logo_url || club.avatar_url');
  });

  it('spells out Bad Beat Jackpot and opens the existing detail modal', () => {
    expect(page).toContain('className="lobby-bbj"');
    expect(page).toContain('>Bad Beat Jackpot</span>');
    expect(page).toContain('setShowBBJInfo(true)');
    expect(page).toContain('showBBJ={false}');
  });

  it('uses the compact live wallet with icon-and-label above each balance', () => {
    expect(page).toContain('compactLobby');
    expect(wallet).toContain('clubLobbyWalletRows(rowRole)');
    expect(wallet).toContain("row.key === 'union_bank' || row.key === 'union_rake'");
    expect(wallet).toContain("icon: 'bank'");
    expect(wallet).toContain("compactLobby ? 'Diamond Wallet' : 'Diamonds'");
    expect(wallet).toContain("row.key === 'club_bank' ? 'Club Balance'");

    const lobbyWalletCss = walletCss.slice(walletCss.indexOf('CLUB LOBBY TOURNAMENT BOARD'));
    expect(lobbyWalletCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(lobbyWalletCss).toContain('grid-row: 1');
    expect(lobbyWalletCss).toContain('grid-row: 2');
    expect(lobbyWalletCss).toContain('@media (max-width: 480px)');
    expect(lobbyWalletCss).toContain('grid-template-columns: 11px minmax(0, auto)');
    expect(lobbyWalletCss).toContain('font-size: 0.48rem');
    expect(lobbyWalletCss).not.toContain('linear-gradient');
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

  it('uses a compact mobile identity and smaller two-line club notice', () => {
    const mobileConsole = pageCss.slice(pageCss.lastIndexOf('MOBILE LOBBY FINAL CONTRACT'));
    expect(page).toContain('className="lobby-club__status"');
    expect(page).toContain('className="lobby-club__playing"');
    expect(mobileConsole).toContain('grid-template-columns: minmax(0, 1fr) 112px');
    expect(mobileConsole).toContain('font-size: 0.64rem');
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
