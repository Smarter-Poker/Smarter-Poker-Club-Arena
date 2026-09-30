/**
 * The global menu offers no union inside the Diamond Arena (Phase 10 line 6,
 * ruling 16: no unions, agents or commissions in the arena).
 * src/components/navigation/menuUnionDoor.ts and its one use in
 * src/components/navigation/HamburgerMenu.tsx.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { menuOffersCreateUnion } from '../../src/components/navigation/menuUnionDoor';
import { DIAMOND_ARENA_CLUB_ID, DIAMOND_ARENA_SLUG } from '../../src/lib/constants';

const MENU = readFileSync(
  resolve(__dirname, '../../src/components/navigation/HamburgerMenu.tsx'),
  'utf8'
);
const CHIP_CLUB_ID = '6f1c2a54-0b7e-4d0e-9a55-1c3b2f8e7d10';

describe('the menu offers no union inside the Diamond Arena', () => {
  it('hides Create Union while the arena is the club in context, however it is named', () => {
    const arena: (string | null | undefined)[][] = [
      [DIAMOND_ARENA_SLUG, null, null],
      ['Diamond-Arena', undefined, null],
      ['diamond%2Darena', null, null],
      [DIAMOND_ARENA_CLUB_ID, DIAMOND_ARENA_CLUB_ID, null],
      ['123456', DIAMOND_ARENA_CLUB_ID, null],
      [null, null, DIAMOND_ARENA_CLUB_ID],
      [null, null, DIAMOND_ARENA_SLUG],
    ];
    for (const keys of arena) {
      expect(menuOffersCreateUnion(true, keys), JSON.stringify(keys)).toBe(false);
    }
  });

  it('keeps Create Union for an allowed account everywhere else', () => {
    const elsewhere: (string | null | undefined)[][] = [
      [],
      [null, null, null],
      ['shark-club', CHIP_CLUB_ID, null],
      ['25450', CHIP_CLUB_ID, null],
      [null, null, CHIP_CLUB_ID],
      ['diamond-arena-fans', CHIP_CLUB_ID, null],
    ];
    for (const keys of elsewhere) {
      expect(menuOffersCreateUnion(true, keys), JSON.stringify(keys)).toBe(true);
    }
  });

  it('never offers it to an account the allowlist refuses', () => {
    expect(menuOffersCreateUnion(false, [null, null, null])).toBe(false);
    expect(menuOffersCreateUnion(false, ['shark-club', CHIP_CLUB_ID, null])).toBe(false);
  });

  it('the menu asks this rule for Create Union and leaves Create Club and Invite Players alone', () => {
    expect(MENU).toContain(') : showCreateUnion ? (');
    expect(MENU).not.toContain(') : canCreateUnion ? (');
    expect(MENU).toMatch(
      /menuOffersCreateUnion\(canCreateUnion, \[\s*clubId,\s*workspace\.clubUUID,\s*inTabLobbyActive \? inTabLobbyClubId : null,\s*\]\)/
    );
    expect(MENU).toContain("onClick={() => handleNavigate('/?create=club')}");
    expect(MENU).toContain('{clubId && workspace.canControlClub ? (');
  });
});
