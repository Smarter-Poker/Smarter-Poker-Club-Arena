import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { riverPositionIncrements } from './HorseRiverPositionRead.js';
const a = (userId: string, action: string, stage = 'river') => ({
  userId,
  action,
  stage,
  amount: action === 'check' || action === 'fold' ? 0 : 10,
});
describe('Public river last-to-act opportunities', () => {
  it('counts the in-position bettor after a check, not the first actor', () => {
    const rows = riverPositionIncrements(
      [a('oop', 'call', 'preflop'), a('ip', 'check', 'preflop'), a('oop', 'check'), a('ip', 'bet')],
      2
    );
    expect([...rows]).toEqual([['ip', { opportunities: 1, bets: 1 }]]);
  });
  it('counts a check-back as a real opportunity', () => {
    expect([...riverPositionIncrements([a('a', 'check'), a('b', 'check')], 2)]).toEqual([
      ['b', { opportunities: 1, bets: 0 }],
    ]);
  });
  it('waits for every remaining opponent in a multiway river', () => {
    expect([
      ...riverPositionIncrements([a('a', 'check'), a('b', 'check'), a('c', 'bet')], 3),
    ]).toEqual([['c', { opportunities: 1, bets: 1 }]]);
    expect(riverPositionIncrements([a('a', 'check'), a('b', 'bet'), a('c', 'fold')], 3).size).toBe(
      0
    );
  });
  it('removes earlier folds and all-in seats from players still able to act', () => {
    expect([
      ...riverPositionIncrements(
        [a('dead', 'fold', 'flop'), a('jam', 'all_in', 'turn'), a('a', 'check'), a('b', 'bet')],
        4
      ),
    ]).toEqual([['b', { opportunities: 1, bets: 1 }]]);
  });
  it('does not count checks facing bets, raises or repeat opportunities', () => {
    expect(riverPositionIncrements([a('a', 'bet'), a('b', 'raise'), a('a', 'call')], 2).size).toBe(
      0
    );
    expect(riverPositionIncrements([a('a', 'check'), a('a', 'check'), a('b', 'bet')], 2).size).toBe(
      0
    );
  });
  it('refuses unknown participants, unsupported count, out-of-order streets and oversized histories', () => {
    expect(riverPositionIncrements([a('a', 'check'), a('b', 'bet')], 3).size).toBe(0);
    expect(riverPositionIncrements([a('a', 'check'), a('b', 'bet')], undefined).size).toBe(0);
    expect(riverPositionIncrements([a('a', 'check'), a('b', 'check', 'turn')], 2).size).toBe(0);
    expect(
      riverPositionIncrements(
        Array.from({ length: 4097 }, () => a('a', 'check')),
        2
      ).size
    ).toBe(0);
  });
  it('uses public actions only and ignores unrelated record contents', () => {
    const first = [a('a', 'check'), a('b', 'bet')];
    const second = first.map((x) => ({ ...x, cards: ['opaque-unread-field'] }));
    expect([...riverPositionIncrements(second, 2)]).toEqual([...riverPositionIncrements(first, 2)]);
  });
});

import { HorseMind } from './HorseMind.js';
import { encodeHorseDecisionReads, decodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import type { ActionRecord, SeatPlayer } from '../types.js';
describe('Independent river frequency survives read transport', () => {
  it('dedupes original hands, scopes learning and preserves the private read frame', () => {
    const learned = HorseMind.createSandbox(),
      other = HorseMind.createSandbox();
    const players = [{ user_id: 'a' }, { user_id: 'b' }] as SeatPlayer[];
    const view = HorseMind.runInSandbox(learned, () => {
      HorseMind.setDecisionScope('omaha:hu', 'plo5', 'cash');
      for (let hand = 1; hand <= 12; hand++) {
        const actions = [a('a', 'check'), a('b', hand < 12 ? 'bet' : 'check')].map((v, i) => ({
          ...v,
          seat: i + 1,
          timestamp: 1793000000000 + hand * 1000 + i,
        })) as ActionRecord[];
        const identity = {
          version: 1 as const,
          tableId: '11111111-1111-4111-8111-111111111111',
          handNumber: 1000000 + hand,
        };
        HorseMind.observe(actions, [], identity, 2);
        HorseMind.observe(actions, [], identity, 2);
      }
      expect(HorseMind.riverLastToActRead('b')).toMatchObject({
        opportunities: 12,
        bets: 11,
        rate: 11 / 12,
      });
      expect(HorseMind.riverLastToActRead('a')).toBeNull();
      return HorseMind.snapshotDecisionReads(players, null);
    });
    HorseMind.runInSandbox(other, () => {
      HorseMind.setDecisionScope('omaha:hu', 'plo5', 'cash');
      expect(HorseMind.riverLastToActRead('b')).toBeNull();
    });
    const frame = encodeHorseDecisionReads(view, players, null);
    expect(frame.version).toBe('horse-decision-reads-v7');
    const forged = JSON.parse(frame.json);
    const row = forged.riverCalls.find((r: [string, number[]]) => r[0] === 'b');
    row[1][3] = row[1][2] + 1;
    const json = JSON.stringify(forged);
    expect(() =>
      decodeHorseDecisionReads(
        {
          ...frame,
          json,
          bytes: Buffer.byteLength(json),
          sha256: createHash('sha256').update(json).digest('hex'),
        },
        players,
        null
      )
    ).toThrow();

    const restored = decodeHorseDecisionReads(frame, players, null);
    HorseMind.runInSandbox(restored, () => {
      HorseMind.setDecisionScope('omaha:hu', 'plo5', 'cash');
      expect(HorseMind.riverLastToActRead('b')).toMatchObject({ opportunities: 12, bets: 11 });
    });
    const old = encodeHorseDecisionReads(HorseMind.createSandbox(), players, null);
    expect(old.version).toBe('horse-decision-reads-v1');
    expect(
      encodeHorseDecisionReads(decodeHorseDecisionReads(old, players, null), players, null)
    ).toEqual(old);
  });
  it('does not infer a conditional read without original dealt metadata', () => {
    const sandbox = HorseMind.createSandbox();
    HorseMind.runInSandbox(sandbox, () => {
      HorseMind.setDecisionScope('omaha:hu', 'plo5', 'cash');
      const actions = [a('a', 'check'), a('b', 'bet')].map((v, i) => ({
        ...v,
        seat: i + 1,
        timestamp: 1793000000000 + i,
      })) as ActionRecord[];
      HorseMind.observe(actions, [], {
        version: 1,
        tableId: '11111111-1111-4111-8111-111111111111',
        handNumber: 1000001,
      });
      expect(HorseMind.riverLastToActRead('b')).toBeNull();
      expect(HorseMind.getStats('b')?.riverLastToActOpps).toBe(0);
    });
  });
});

import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { variantInfo, seedFastRandom } from './HorseEval.js';
import type { Card } from '../types.js';
const card = (rank: string, suit: string) => ({ rank, suit }) as Card;
describe('Conditional river defense keeps the existing range and price arbiter', () => {
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s admits only the observed last-to-act river pattern',
    (variant) => {
      const sandbox = HorseMind.createSandbox(),
        scope = variant === 'nlh' ? 'holdem:hu' : 'omaha:hu';
      const counters = {
        ...freshExploitCounters(),
        hands: 1000,
        vpip: 999,
        betCheckedToOpp: 1000,
        betCheckedTo: 200,
      };
      sandbox.exploit.set(scope + '|b', counters);
      HorseMind.runInSandbox(sandbox, () => {
        HorseMind.setDecisionScope(scope, variant, 'cash');
        for (let h = 1; h <= 100; h++) {
          const actions = [
            a('a', 'call', 'preflop'),
            a('b', 'call', 'preflop'),
            a('a', 'check'),
            a('b', 'bet'),
          ].map((v, i) => ({
            ...v,
            seat: (i % 2) + 1,
            timestamp: 1793000000000 + h * 1000 + i,
          })) as ActionRecord[];
          HorseMind.observe(
            actions,
            [],
            {
              version: 1,
              tableId: '11111111-1111-4111-8111-111111111111',
              handNumber: 1000000 + h,
            },
            2
          );
        }
        expect(HorseMind.opponentRead('b')?.stats.vpip.engaged).toBe('high');
        const hero = {
          user_id: 'a',
          seat: 1,
          stack: 100,
          bet: 0,
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          cards: [
            card('A', 'spades'),
            card('T', 'spades'),
            ...(variant === 'nlh' ? [] : [card('3', 'clubs'), card('4', 'diamonds')]),
            ...(variant === 'plo5' || variant === 'plo6' ? [card('5', 'hearts')] : []),
            ...(variant === 'plo6' ? [card('6', 'clubs')] : []),
          ],
        } as SeatPlayer;
        const opponent = { ...hero, user_id: 'b', seat: 2, bet: 10, cards: [] };
        const hist = [
          a('a', 'call', 'preflop'),
          a('b', 'call', 'preflop'),
          a('a', 'check'),
          a('b', 'bet'),
        ].map((v, i) => ({
          ...v,
          seat: (i % 2) + 1,
          timestamp: 1793001000000 + i,
        })) as ActionRecord[];
        const gs = {
          players: [hero, opponent],
          dealtSeatIds: [1, 2],
          gameVariant: variant,
          gameMode: 'cash',
          stage: 'river',
          communityCards: [
            card('K', 'hearts'),
            card('Q', 'diamonds'),
            card('J', 'clubs'),
            card('7', 'spades'),
            card('2', 'hearts'),
          ],
          pot: 200,
          currentBet: 10,
          bigBlind: 2,
          boardCount: 1,
          actionHistory: hist,
          legalActions: ['fold', 'call', 'raise'],
          rakeConfig: { percent: 5, cap: 6 },
        } as unknown as HorseGameStateV2;
        const original = { action: 'fold' as const, thinkTime: 0 };
        seedFastRandom(4343);
        expect(
          HorseLogic.__testables.maniacCallDown(original, hero, gs, variantInfo(variant), {
            riverPositionDefense: false,
          })
        ).toEqual(original);
        seedFastRandom(4343);
        expect(
          HorseLogic.__testables.maniacCallDown(original, hero, gs, variantInfo(variant), {
            riverPositionDefense: true,
          }).action
        ).toBe('call');
        seedFastRandom(4343);
        expect(
          HorseLogic.__testables.maniacCallDown(
            original,
            hero,
            { ...gs, actionHistory: hist.filter((x) => x.action !== 'check') },
            variantInfo(variant),
            { riverPositionDefense: true }
          )
        ).toEqual(original);
      });
    }
  );
});
