import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const page = read('src/pages/ClubHomePage.tsx');
const pageCss = read('src/pages/ClubHomePage.css');
const wallet = read('src/components/wallet/DynamicWallet.tsx');
const walletCss = read('src/components/wallet/DynamicWallet.css');
const layout = read('src/components/layouts/AppLayout.tsx');

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
    const liveBoard = pageCss.slice(pageCss.indexOf('LIVE GAME BOARD'));
    expect(liveBoard).toContain('grid-template-columns: repeat(5, minmax(0, 1fr))');
    expect(liveBoard).toContain('display: contents');
    expect(liveBoard).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(liveBoard).toContain('overflow: visible');
  });
});
