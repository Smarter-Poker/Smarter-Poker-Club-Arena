import { describe, expect, it } from 'vitest';
import { persistedKnockoutEvidence, planBountyRecovery } from './bountyAttributionGate.js';

const busted = '00000000-0000-4000-8000-000000000001';
const winner = '00000000-0000-4000-8000-000000000002';
const table = '00000000-0000-4000-8000-000000000003';
const HAND = 1_000_202;

const settlement = (handNumber = HAND): any => ({
  success: true,
  table_id: table,
  hand_number: handNumber,
  written: { [busted]: 0, [winner]: 2_000 },
});

const history = (handNumber = HAND, stack = 0): any => ({
  id: '00000000-0000-4000-8000-000000000004',
  table_id: table,
  hand_number: handNumber,
  players: [
    { userId: busted, stack },
    { userId: winner, stack: 2_000 },
  ],
  winners: [{ userId: winner, amount: 2_000, potIndex: 0 }],
  pots: [{ index: 0, eligible: [busted, winner] }],
});

describe('bounty attribution persistence gate', () => {
  it('does not authorize elimination while the exact knockout history is still pending', () => {
    expect(persistedKnockoutEvidence(settlement(), null, busted)).toEqual({
      ready: false,
      reason: 'history_not_ready',
    });
  });

  it('rejects a stale earlier bust after a rebuy instead of paying the wrong hand', () => {
    expect(persistedKnockoutEvidence(settlement(HAND), history(HAND - 101), busted)).toEqual({
      ready: false,
      reason: 'history_identity_mismatch',
    });
  });

  it('rejects a stale later hand instead of substituting a different knockout', () => {
    expect(persistedKnockoutEvidence(settlement(HAND), history(HAND + 101), busted)).toEqual({
      ready: false,
      reason: 'history_identity_mismatch',
    });
  });

  it('rejects a row that does not independently record the player at zero', () => {
    expect(persistedKnockoutEvidence(settlement(), history(HAND, 500), busted)).toEqual({
      ready: false,
      reason: 'player_not_in_hand',
    });
  });

  it('returns the exact persisted hand and final-pot claimants only after both records agree', () => {
    const result = persistedKnockoutEvidence(settlement(), history(), busted);
    expect(result).toMatchObject({
      ready: true,
      tableId: table,
      handId: '00000000-0000-4000-8000-000000000004',
      handNumber: HAND,
      attribution: {
        knockerUserId: winner,
        basis: 'pot',
        potIndex: 0,
        claimants: [{ userId: winner, weight: 1 }],
      },
    });
  });

  it('refuses legacy per-table hand numbers that are not globally unique', () => {
    expect(persistedKnockoutEvidence(settlement(202), history(202), busted)).toEqual({
      ready: false,
      reason: 'settlement_identity_missing',
    });
  });

  it('fails closed when a modern hand omitted its pot ledger', () => {
    const row = history();
    delete row.pots;
    expect(persistedKnockoutEvidence(settlement(), row, busted)).toEqual({
      ready: false,
      reason: 'knocker_not_attributable',
    });
  });

  it('does not substitute the largest side-pot winner when pot evidence is malformed', () => {
    const row = history();
    row.pots = [{ index: 1, eligible: [winner] }];
    row.winners = [{ userId: winner, amount: 50_000, potIndex: 1 }];
    expect(persistedKnockoutEvidence(settlement(), row, busted)).toEqual({
      ready: false,
      reason: 'knocker_not_attributable',
    });
  });
});

describe('durable bounty recovery plan', () => {
  const eliminated = [{ user_id: busted, current_bounty: 10 }];

  it('treats a committed ledger row as success after an RPC response was lost', () => {
    expect(
      planBountyRecovery({
        eliminated,
        collections: [{ eliminated_player_id: busted }],
        awards: [],
        mysteryActive: false,
      })
    ).toEqual({ missing: [], pendingAwards: [] });
  });

  it('re-drives a true fixed/PKO failure from fresh post-restart rows', () => {
    const freshRows = JSON.parse(JSON.stringify(eliminated));
    expect(
      planBountyRecovery({
        eliminated: freshRows,
        collections: [],
        awards: [],
        mysteryActive: false,
      })
    ).toEqual({ missing: [busted], pendingAwards: [] });
  });

  it.each(['reserved', 'revealed', 'paid'])('keeps a mystery %s award pending', (status) => {
    const award = {
      id: '00000000-0000-4000-8000-000000000005',
      eliminated_user_id: busted,
      table_id: table,
      status,
    };
    expect(
      planBountyRecovery({
        eliminated,
        collections: [],
        awards: [award],
        mysteryActive: true,
      })
    ).toEqual({ missing: [], pendingAwards: [award] });
  });

  it('does not reserve or collect a second time after the durable marker is complete', () => {
    expect(
      planBountyRecovery({
        eliminated,
        collections: [],
        awards: [
          {
            id: '00000000-0000-4000-8000-000000000005',
            eliminated_user_id: busted,
            status: 'completed',
          },
        ],
        mysteryActive: true,
      })
    ).toEqual({ missing: [], pendingAwards: [] });
  });
});

describe('exact per-pot awards at the bounty gate', () => {
  const mainWinner = '00000000-0000-4000-8000-000000000006';
  function row(awards: unknown) {
    return {
      ...history(),
      winners: [{ userId: winner, amount: 600, potIndex: 0 }],
      pots: [
        { index: 0, eligible: [busted, winner, mainWinner] },
        { index: 1, eligible: [busted, winner, mainWinner], awards },
      ],
    };
  }
  it('finds a later pot won by the same player as the main pot', () => {
    expect(
      persistedKnockoutEvidence(
        settlement(),
        row([{ userId: winner, amount: 300, potIndex: 1 }]),
        busted
      )
    ).toMatchObject({
      ready: true,
      attribution: { potIndex: 1, claimants: [{ userId: winner, weight: 1 }] },
    });
  });
  it.each([
    null,
    [],
    {},
    [{ userId: winner, potIndex: 0 }],
    [{ userId: winner }],
    [{ userId: busted, potIndex: 1 }],
    [{ userId: 'outsider', potIndex: 1 }],
  ])('does not replace unusable exact awards with merged totals: %j', (awards) => {
    expect(persistedKnockoutEvidence(settlement(), row(awards), busted)).toMatchObject({
      ready: false,
      reason: 'knocker_not_attributable',
    });
  });
  it('preserves equal sharing and distinct people across high/low award rows', () => {
    expect(
      persistedKnockoutEvidence(
        settlement(),
        row([
          { userId: winner, amount: 75, potIndex: 1, low: false },
          { userId: mainWinner, amount: 75, potIndex: 1, low: false },
          { userId: winner, amount: 150, potIndex: 1, low: true },
        ]),
        busted
      )
    ).toMatchObject({
      ready: true,
      attribution: {
        claimants: [
          { userId: winner, weight: 1 },
          { userId: mainWinner, weight: 1 },
        ],
      },
    });
  });
  it('uses array position for a null index exactly as the database reader does', () => {
    const value = row([{ userId: winner, amount: 300, potIndex: 1 }]);
    (value.pots[1] as any).index = null;
    expect(persistedKnockoutEvidence(settlement(), value, busted)).toMatchObject({
      ready: true,
      attribution: { potIndex: 1, knockerUserId: winner },
    });
  });
});
