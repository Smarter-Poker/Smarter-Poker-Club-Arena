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
import {
  cashierRecipientBlock,
  mapCashierRoster,
  rosterMatchRank,
  rosterRowMatches,
} from '../src/lib/cashierRoster';

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

  it('a cashier says why a member cannot receive, instead of removing them', () => {
    // The two refusals a cashier can know before the tap. Anything else is
    // the server's to say on submit.
    expect(
      cashierRecipientBlock({
        isSelf: true,
        refusesSelfSend: true,
        destinationNeedsAgentWallet: false,
        memberHoldsAgentWallet: true,
      })?.label
    ).toBe('You');
    expect(
      cashierRecipientBlock({
        isSelf: false,
        refusesSelfSend: true,
        destinationNeedsAgentWallet: true,
        memberHoldsAgentWallet: false,
      })?.label
    ).toBe('No Wallet');
    // The club bank deliberately allows a self-send: an owner funding their
    // own float is the route the whole hierarchy hangs off.
    expect(
      cashierRecipientBlock({
        isSelf: true,
        refusesSelfSend: false,
        destinationNeedsAgentWallet: false,
        memberHoldsAgentWallet: true,
      })
    ).toBeNull();
    // Nothing to say: an ordinary sendable member.
    expect(
      cashierRecipientBlock({
        isSelf: false,
        refusesSelfSend: true,
        destinationNeedsAgentWallet: true,
        memberHoldsAgentWallet: true,
      })
    ).toBeNull();
  });

  it('no cashier surface filters a member out of its list to avoid a refusal', () => {
    // Both surfaces, one rule. These two literals are the exact filters that
    // made a member vanish; neither may come back.
    const modal = read('src/components/wallet/WalletCashierModal.tsx');
    expect(modal).toContain('cashierRecipientBlock({');
    expect(modal).toContain('const destinationMembers = members;');
    expect(modal).not.toContain('!(excludeSelf && m.user_id === user?.id)');
    expect(modal).not.toContain('needsAgent ? canHoldAgentWallet(m.role) : true');
    // Listed, and refused at the one place a recipient is chosen.
    expect(modal).toContain('if (!block) setRecipient(m);');
    expect(modal).toContain('aria-disabled={block ? true : undefined}');

    const trade = read('src/pages/CashierTradePage.tsx');
    expect(trade).not.toMatch(/user_id\)\s*!==\s*(viewerId|user\.id)/);
  });

  it('the modal finds a member by the id printed on their row', () => {
    // Same gap the trade page had: #short_id is on screen and was not searched.
    const modal = read('src/components/wallet/WalletCashierModal.tsx');
    expect(modal).toContain("(m.short_id || '').toLowerCase().includes(q)");
  });

  it('PRESENT IS NOT DISCOVERABLE: a search ranks by match, and you find yourself first', () => {
    // Dan, on being told he was "discoverable": "I AM NOT DISCOVERABLE... WHY
    // ARE YOU LYING TO ME?!" He was row 21 of 21 - on the list, and buried,
    // because the list kept sorting by chip balance during a search and his
    // balance was 0.00. Twenty horses with "kingsley" in their HANDLES sat
    // above the one member whose NAME is KingFish.
    const roster = mapCashierRoster(
      [
        ...Array.from({ length: 20 }, (_, i) => ({
          user_id: `horse${i}`,
          role_rank: 1,
          name: `horse${i}`,
          username: `${i}kingsley`,
          role: 'player',
          chip_balance: 10000 - i,
          player_number: `9401${String(i).padStart(2, '0')}`,
        })),
        {
          user_id: ME,
          role_rank: 9,
          name: 'KingFish',
          username: 'kingfish',
          role: 'owner',
          chip_balance: 0,
        },
        {
          user_id: 'tk',
          role_rank: 1,
          name: 'TheKing',
          username: 'reednightingale',
          role: 'player',
          chip_balance: 9852,
        },
      ],
      ME
    );
    const q = 'KING';
    const bySearch = roster
      .filter((r) => rosterRowMatches(r, q))
      .sort(
        (a, b) => rosterMatchRank(b, q) - rosterMatchRank(a, q) || b.chipBalance - a.chipBalance
      );
    expect(bySearch[0].userId).toBe(ME);
    // A NAME hit outranks a handle hit even with a fifth of the chips.
    expect(bySearch[1].userId).toBe('tk');
    expect(bySearch[2].username).toContain('kingsley');
  });

  it('the rank bands: name over handle over id, exact over prefix over contains', () => {
    const row = (name: string, username: string, playerNumber: string) =>
      mapCashierRoster(
        [
          {
            user_id: 'x',
            role_rank: 1,
            name,
            username,
            role: 'player',
            chip_balance: 0,
            player_number: playerNumber,
          },
        ],
        'me'
      )[0];
    expect(rosterMatchRank(row('king', 'a', '1'), 'king')).toBeGreaterThan(
      rosterMatchRank(row('kingfish', 'a', '1'), 'king')
    );
    expect(rosterMatchRank(row('kingfish', 'a', '1'), 'king')).toBeGreaterThan(
      rosterMatchRank(row('theking', 'a', '1'), 'king')
    );
    expect(rosterMatchRank(row('theking', 'a', '1'), 'king')).toBeGreaterThan(
      rosterMatchRank(row('zed', 'kingsley', '1'), 'king')
    );
    expect(rosterMatchRank(row('zed', 'kingsley', '1'), 'king')).toBeGreaterThan(
      rosterMatchRank(row('zed', 'a', '940'), '940')
    );
    expect(rosterMatchRank(row('zed', 'a', '1'), 'king')).toBe(0);
    expect(rosterMatchRank(row('anything', 'a', '1'), '')).toBe(0);
  });

  it('the trade page sorts a search by rank before the chosen sort', () => {
    const page = read('src/pages/CashierTradePage.tsx');
    expect(page).toContain('rosterMatchRank(b, q) - rosterMatchRank(a, q) || bySort(a, b)');
  });
});
