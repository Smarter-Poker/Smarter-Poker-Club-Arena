/**
 * EVERY MEMBER IS DISCOVERABLE IN THE CASHIER (Dan 2026-09-04, binding)
 *
 * "IM NOT SEARCHABLE WHEN YOU ARE IN THE CASHIER, EVERY PERSON WHO IS IN THE
 * CLUB SHOULD BE SEARCHABLE, IF THEY DON'T HAVE A WALLET, LIKE (ADMINS) YOU
 * CAN'T SEND THEM ANYTHING, BUT ALL USERS SHOULD STILL BE SEARCHABLE AND
 * DISCOVERABLE ACCORDING TO YOUR ROLE ACCESS."
 *
 * The database decides who a viewer may see (fn_club_cashier_scope) and who
 * they may pay (fn_agent_wallet_send). The client shows everything the server
 * returned, finds a member by anything the row prints, and marks - never
 * deletes - the one row that cannot be a recipient: the viewer's own.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapCashierRoster, rosterRowMatches } from '../src/lib/cashierRoster';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const ME = '47965354-0e56-43ef-931c-ddaab82af765';

const rows = [
  {
    user_id: ME,
    role_rank: 9,
    name: 'KingFish',
    username: 'kingfish',
    role: 'owner',
    chip_balance: 0,
    player_number: '940001',
  },
  {
    user_id: 'u2',
    role_rank: 1,
    name: 'loubruno',
    username: 'quillkingsley',
    role: 'player',
    chip_balance: 13250.07,
    depth: 1,
    player_number: '940136',
    is_horse: true,
  },
  {
    user_id: 'u3',
    role_rank: 5,
    name: 'Admin Ann',
    username: '',
    role: 'admin',
    chip_balance: 0,
    player_number: '940002',
  },
  {
    user_id: 'u4',
    role_rank: 1,
    name: 'Player',
    username: '',
    role: 'player',
    chip_balance: 5,
    player_number: '940777',
  },
];

describe('every member is discoverable in the cashier', () => {
  it('maps every row the server returned, the viewer included', () => {
    const roster = mapCashierRoster(rows, ME);
    expect(roster.map((r) => r.userId)).toEqual([ME, 'u2', 'u3', 'u4']);
    expect(roster[0].isSelf).toBe(true);
    expect(roster.slice(1).every((r) => !r.isSelf)).toBe(true);
  });

  it('a wallet-less admin with no handle is still on the list', () => {
    const admin = mapCashierRoster(rows, ME).find((r) => r.userId === 'u3');
    expect(admin).toBeDefined();
    expect(admin?.chipBalance).toBe(0);
    expect(rosterRowMatches(admin!, 'ann')).toBe(true);
  });

  it('the owner finds himself with the same search that finds the horses', () => {
    const roster = mapCashierRoster(rows, ME);
    const hits = roster.filter((r) => rosterRowMatches(r, 'KING')).map((r) => r.userId);
    expect(hits).toContain(ME);
    expect(hits).toContain('u2');
  });

  it('a member is findable by the ID the row prints', () => {
    const roster = mapCashierRoster(rows, ME);
    // A profile-less member renders as "Player" with no handle: the member ID
    // is the only thing that can find them, so it must.
    expect(roster.filter((r) => rosterRowMatches(r, '940777')).map((r) => r.userId)).toEqual([
      'u4',
    ]);
    expect(rosterRowMatches(roster[0], '')).toBe(true);
    expect(rosterRowMatches(roster[0], 'nobody-here')).toBe(false);
  });

  it('the trade page never filters the roster by user id before the search sees it', () => {
    const page = read('src/pages/CashierTradePage.tsx');
    expect(page).toContain('setDownline(mapCashierRoster(dl, user.id))');
    expect(page).not.toMatch(/user_id\)\s*!==\s*(viewerId|user\.id)/);
    expect(page).toContain('downline.filter((r) => rosterRowMatches(r, search))');
    // The self row is refused as a recipient at the one place selection happens.
    expect(page).toContain('if (id === user?.id) return prev;');
    // And the "Available" count is recipients, not rows.
    expect(page).toContain(
      'const recipients = useMemo(() => downline.filter((r) => !r.isSelf), [downline]);'
    );
  });
});
