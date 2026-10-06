/**
 * "Top Up" in the buy-in dialog opens a cashier the player can use (launch
 * audit 2026-10-05). It used to open `/cashier?club=...`, the classic cashier,
 * whose Buy-In tab can only answer "No table selected for buy-in" to a plain
 * player - a dead end for exactly the player who pressed it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { topUpCashierPath } from '../../src/utils/topUpCashierPath';

describe('topUpCashierPath', () => {
  it("goes to the club's Trade cashier when the club is known", () => {
    expect(topUpCashierPath('2c9e1f0a-1111-4222-8333-444455556666')).toBe(
      '/clubs/2c9e1f0a-1111-4222-8333-444455556666/cashier'
    );
    expect(topUpCashierPath('shark-club')).toBe('/clubs/shark-club/cashier');
  });

  it('never builds the classic cashier link that dead-ends', () => {
    for (const club of ['abc', 'shark-club', '2c9e1f0a-1111-4222-8333-444455556666']) {
      expect(topUpCashierPath(club)).not.toContain('?club=');
      expect(topUpCashierPath(club)).not.toContain('cashier-classic');
    }
  });

  it('lets /cashier resolve the club when none is known yet', () => {
    expect(topUpCashierPath(null)).toBe('/cashier');
    expect(topUpCashierPath(undefined)).toBe('/cashier');
    expect(topUpCashierPath('  ')).toBe('/cashier');
  });

  it('keeps a club id inside its own path segment', () => {
    expect(topUpCashierPath('a/b?c')).toBe('/clubs/a%2Fb%3Fc/cashier');
  });
});

describe('the table uses it, and the route it names exists', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('TablePage sends Top Up through topUpCashierPath', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('navigate(topUpCashierPath(lobbyClubIdRef.current))');
    expect(page).not.toContain("navigate(withClubContext('/cashier', lobbyClubIdRef.current))");
  });

  it('the Trade cashier is routed at clubs/:clubId/cashier', () => {
    expect(read('src/App.tsx')).toContain('path="clubs/:clubId/cashier"');
  });
});
