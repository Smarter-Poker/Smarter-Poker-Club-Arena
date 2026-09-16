import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngineHandEvents } from './ServerTableEngineHandEvents.js';

const TABLE = 'round-three-event-delivery';

describe('hand records survive event delivery failures', () => {
  it('records every forced-money row even when the ante announcement throws', async () => {
    const engine = Object.create(ServerTableEngineHandEvents.prototype) as any;
    const emitEvent = vi.fn(() => {
      throw new Error('fixture delivery failure');
    });
    Object.assign(engine, {
      tableId: TABLE,
      handCount: 73,
      currentHandActions: [],
      hub: { emitEvent },
    });
    const postings = [
      { seat: 1, userId: 'A', kind: 'small_blind', amount: 1, dead: false },
      { seat: 2, userId: 'B', kind: 'big_blind', amount: 2, dead: false },
      { seat: 1, userId: 'A', kind: 'ante', amount: 0.25, dead: true },
    ];

    await expect(
      engine.handleHandEvent({ type: 'FORCED_BETS_POSTED', postings }, [])
    ).resolves.toBeUndefined();

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0]).toMatchObject([
      TABLE,
      { type: 'antes_posted', hand_number: 73, postings: [{ seat: 1, amount: 0.25 }] },
    ]);
    expect(engine.currentHandActions).toEqual(
      postings.map(({ kind, ...row }) => ({
        ...row,
        action: kind,
        stage: 'preflop',
        timestamp: expect.any(Number),
      }))
    );
  });

  it('still publishes the current cent-exact pot distribution after pot_win throws', async () => {
    const engine = Object.create(ServerTableEngineHandEvents.prototype) as any;
    const emitEvent = vi.fn((_table: string, payload: Record<string, unknown>) => {
      if (payload.type === 'pot_win') throw new Error('fixture pot-win delivery failure');
    });
    Object.assign(engine, {
      tableId: TABLE,
      handCount: 74,
      currentHandShowdownResults: [],
      currentHandContributions: new Map(),
      currentHandReturnedUncalled: new Map(),
      broadcastCurrentState: vi.fn(),
      hub: { emitEvent },
      handController: {
        getState: () => ({
          pot: 100,
          pots: [{ amount: 100, eligiblePlayers: ['A', 'B'] }],
          players: [],
          communityCards: [],
        }),
      },
    });
    await expect(
      engine.handleHandEvent(
        {
          type: 'WINNERS',
          winners: [
            { userId: 'A', amount: 9.5 },
            { userId: 'B', amount: 19 },
          ],
          perPotAwards: [
            { potIndex: 0, userId: 'A', amount: 9.5 },
            { potIndex: 0, userId: 'B', amount: 19 },
          ],
        },
        []
      )
    ).resolves.toBeUndefined();

    expect(emitEvent.mock.calls.map(([, payload]) => payload.type)).toEqual([
      'pot_win',
      'pot_distributed',
    ]);
    expect(engine.currentHandWinnerIds).toEqual(['A', 'B']);
    expect(engine.broadcastCurrentState).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[1]).toMatchObject([
      TABLE,
      {
        type: 'pot_distributed',
        hand_number: 74,
        total_pot: 100,
        pots: [
          {
            pot_index: 0,
            amount: 100,
            winner_user_ids: ['A', 'B'],
            per_winner_share: [
              { user_id: 'A', share: 33.33 },
              { user_id: 'B', share: 66.67 },
            ],
          },
        ],
      },
    ]);
  });
});
