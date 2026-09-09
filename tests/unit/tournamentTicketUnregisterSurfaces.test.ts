import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const surfaces = [
  'src/pages/XMTTPage.tsx',
  'src/pages/UnionGamesPage.tsx',
  'src/pages/tournament/TournamentDetails.tsx',
  'src/pages/tournament/TournamentLobbyPage.tsx',
  'src/pages/TournamentPage.tsx',
  'src/pages/ClubHomePage.tsx',
];

describe('every tournament unregistration surface reports the committed rail', () => {
  for (const file of surfaces) {
    it(`${file} uses the wallet-or-ticket result`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source).toContain('tournamentUnregisterSuccessText');
      expect(source).not.toMatch(/buy-in refunded(?: to your wallet)?/i);
    });
  }

  it('does not reconstruct a wallet refund or prize pool in TournamentPage', () => {
    const source = readFileSync(join(ROOT, 'src/pages/TournamentPage.tsx'), 'utf8');
    const start = source.indexOf('const handleUnregister = async () =>');
    const end = source.indexOf('// Check rebuy/add-on eligibility', start);
    const handler = source.slice(start, end);
    expect(handler).toContain('tournamentUnregisterSuccessText(result)');
    expect(handler).not.toContain('notifyWalletChange');
    expect(handler).not.toContain('refundedTotal');
    expect(handler).not.toContain('prize_pool:');
  });

  it('routes both TablePage seat-release controls through the replay-safe service contract', () => {
    const source = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
    const menuStart = source.indexOf('if (seatFirstBuyIn && tableState.heroSeat > 0)');
    const menuEnd = source.indexOf('// Capture hero stack BEFORE leave', menuStart);
    const menuLeave = source.slice(menuStart, menuEnd);
    const footerStart = source.indexOf('spectator-footer-bar__cta--leave');
    const footerEnd = source.indexOf('</button>', footerStart);
    const footerLeave = source.slice(footerStart, footerEnd);

    for (const handler of [menuLeave, footerLeave]) {
      expect(handler).toContain('tournamentService.leaveTournamentSeatAndRefund');
      expect(handler).toContain('tournamentUnregisterSuccessText(result)');
      expect(handler).not.toMatch(/res\.refunded|Chips Refunded/);
    }
    expect(source).not.toMatch(/supabase\.rpc\('fn_leave_seat_and_refund'/);
    expect(source.match(/tournamentService\.leaveTournamentSeatAndRefund\(/g)).toHaveLength(2);
  });
});
