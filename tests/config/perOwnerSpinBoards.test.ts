/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ACTIVATION HAS TO GOVERN SOMETHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23, choosing between the options: an owner who activates Spins
 * gets THEIR OWN SPIN TABLES, funded by their own wallet, with the house board
 * still running for players who are not in an activated club.
 *
 * Until this, every Spin on the platform was created with
 * club_id = union_id = the Midway union id. The wallet knew who owned it and
 * the switch worked, but there was not a single table anywhere for the switch
 * to govern.
 *
 * THE THING THAT MAKES THIS SUBTLE, AND EASY TO GET SILENTLY WRONG
 *
 * A Spin's visibility is decided ENTIRELY by club_id / union_id on its row.
 * ClubHomePage scopes its lobby query by one or the other and never consults
 * club membership, so those two fields are the whole access model:
 *
 *   - a club INSIDE a union has its page scoped by
 *     `.eq('club_id', id).eq('is_private', true)` — so a PUBLIC club-owned Spin
 *     is dropped by the very club that paid for it;
 *   - a STANDALONE club's page scopes by club_id alone, and shows it;
 *   - a union's games are found by union_id across every club in the union,
 *     which is exactly how the house board has always reached players.
 *
 * Which is why a union-owned pool stamps union_id and a club-owned pool must
 * not. Getting that backwards produces no error anywhere — just a board nobody
 * can see.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a board knows whose it is', () => {
  it('carries both fields that decide visibility', () => {
    expect(code).toMatch(/interface BoardOwner \{/);
    expect(code).toMatch(/clubId: string;/);
    expect(code).toMatch(/unionId: string \| null;/);
  });

  it('stamps the owner onto the tournament row', () => {
    expect(code).toMatch(/club_id: owner\.clubId,\s*union_id: owner\.unionId,/);
  });

  it('no longer hard-codes the house onto every board it creates', () => {
    // These two lines used to sit in createSpin and createSNG.
    const boardStamps =
      code.match(/club_id: this\.ownerClubId,\s*union_id: this\.ownerUnionId,/g) ?? [];
    // Only the MTT board legitimately still stamps the house.
    expect(boardStamps.length).toBeLessThanOrEqual(1);
  });

  it('a union owner stamps union_id, a club owner leaves it null', () => {
    expect(code).toMatch(/unionId: r\.owner_kind === 'union' \? String\(r\.club_id\) : null/);
  });

  it('the seat-first table inherits the tournament, so it cannot drift', () => {
    expect(code).toMatch(/club_id: tournament\.club_id \?\? this\.ownerClubId/);
  });
});

describe('the house board is not replaced, it is joined', () => {
  it('still exists, still stamped as it always was', () => {
    expect(code).toMatch(/houseOwner: BoardOwner = \{/);
    expect(code).toMatch(/clubId: MIDWAY_UNION_ID,\s*unionId: MIDWAY_UNION_ID,/);
  });

  it('is filled FIRST, so owner boards cannot starve it', () => {
    const spinPass = code.slice(code.indexOf('private async checkAndLaunchSpins'));
    const house = spinPass.indexOf('this.houseOwner');
    const owners = spinPass.indexOf('activatedSpinOwners()');
    expect(house).toBeGreaterThan(-1);
    expect(owners).toBeGreaterThan(-1);
    expect(house).toBeLessThan(owners);
  });

  it('is not also listed as an activated owner, which would alternate the board', () => {
    expect(code).toMatch(/\.filter\(\(o\) => o\.clubId !== this\.houseOwner\.clubId\)/);
  });
});

describe('only owners who actually switched Spins on get a board', () => {
  it('reads the activation flags, not just the pool row', () => {
    expect(code).toMatch(/from\('spin_bonus_pools'\)/);
    expect(code).toMatch(/\.eq\('is_active', true\)/);
    expect(code).toMatch(/\.not\('activated_at', 'is', null\)/);
  });

  it('refuses an owner whose wallet is empty', () => {
    // A drained pool cannot pay a multiplier; opening games it cannot settle
    // hands the player a prize the wallet has to clamp.
    expect(code).toMatch(/\.gt\('balance', 0\)/);
  });

  it('refuses an owner who never chose a stake', () => {
    expect(code).toMatch(/\.filter\(\(o\) => o\.maxStake > 0\)/);
  });

  it('fails closed on a read error instead of opening nothing forever', () => {
    expect(code).toMatch(/spin_owners_read_failed/);
  });
});

describe('an owner is only offered the stakes their seed covers', () => {
  it('filters the board by the stake they seeded for', () => {
    expect(code).toMatch(/SPIN_CONFIGS\.filter\(\(c\) => c\.buyIn <= owner\.maxStake\)/);
  });

  it('skips an owner with nothing affordable rather than opening an empty board', () => {
    expect(code).toMatch(/if \(affordable\.length === 0\) continue;/);
  });
});

describe('one board cannot be mistaken for another', () => {
  it('scopes the open-board read to the owner', () => {
    // The set is keyed on the config NAME, and "10 Chip Spin PLO4" is the same
    // string on every board. Unscoped, the house would fill first and every
    // activated club would look already-full and never open a single game.
    expect(code).toMatch(/if \(owner\.unionId\) openQuery\.eq\('union_id', owner\.unionId\);/);
    expect(code).toMatch(/else openQuery\.eq\('club_id', owner\.clubId\)\.is\('union_id', null\);/);
  });

  it('reads it the same way the lobby does', () => {
    expect(code).toMatch(/\.eq\('status', 'REGISTERING'\)/);
  });
});

describe('the work a single pass can do is bounded', () => {
  it('shares one budget across every board in the pass', () => {
    expect(code).toMatch(/const BURST = 12;/);
    expect(code).toMatch(/const budget = \{ left: BURST \}/);
    expect(code).toMatch(/budget: \{ left: number \}/);
  });

  it('stops the moment the budget is spent, mid-board', () => {
    expect(code).toMatch(/if \(budget\.left <= 0\) break;/);
    expect(code).toMatch(/if \(budget\.left <= 0\) return;/);
  });

  it('only spends budget on a game that was actually created', () => {
    // Decrementing on a failed insert would let a run of failures silently
    // starve every board behind it.
    expect(code).toMatch(/if \(result\.tournamentId\) \{\s*launched\+\+;\s*budget\.left--;/);
  });

  it('caps how many owners it will even consider', () => {
    expect(code).toMatch(/\.limit\(200\)/);
  });
});
