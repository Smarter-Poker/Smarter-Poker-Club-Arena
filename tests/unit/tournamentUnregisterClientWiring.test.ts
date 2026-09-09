import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const read = (path: string) => readFileSync(resolve(__dirname, '../../src', path), 'utf8');

describe('every tournament exit renders the committed settlement receipt', () => {
  const surfaces = [
    'pages/TournamentPage.tsx',
    'pages/ClubHomePage.tsx',
    'pages/UnionGamesPage.tsx',
    'pages/tournament/TournamentDetails.tsx',
    'pages/tournament/TournamentLobbyPage.tsx',
    'pages/XMTTPage.tsx',
  ];

  it.each(surfaces)('%s uses the shared wallet-or-ticket success copy', (path) => {
    const source = read(path);
    expect(source).toContain('const result = await tournamentService.unregisterPlayer(');
    expect(source).toContain('tournamentUnregisterSuccessText(result)');
  });

  it('the legacy Tournament page no longer invents a refund or prize-pool result', () => {
    const source = read('pages/TournamentPage.tsx');
    const handler = sliceMethod(source, 'const handleUnregister = async () => {');
    expect(handler).toContain('await tournamentService.getTournament(selectedTournament.id)');
    expect(handler).not.toContain('const refundedTotal = totalBuyIn(');
    expect(handler).not.toContain('notifyWalletChange(');
    expect(handler).not.toContain('prize_pool: Math.max(');
  });
});
