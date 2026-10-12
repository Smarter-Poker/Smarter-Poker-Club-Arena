import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { bettingStructureFor } from '../BettingStructure.js';
import type { GameVariant, HandConfig, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import {
  jointLegalMenu,
  jointMayReopen,
  openJointStreet,
  performJointAction,
  jointOneWager,
} from './JointStreetBetting.js';

function controller(variant: GameVariant, stacks: number[], dealer = 1) {
  const players = stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: 'u' + (i + 1),
        username: 'U' + (i + 1),
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const hc = new HandController(
    {
      tableId: 't-joint-street',
      handNumber: 1,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    dealer
  );
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  return { hc, st };
}

/** The controller's own state, reduced to what a live horse request carries. */
function liveStreet(variant: GameVariant, st: any) {
  return openJointStreet({
    bettingStructure: bettingStructureFor(variant),
    bigBlind: 2,
    pot: st.pot,
    currentBet: st.currentBet,
    lastRaise: st.lastRaise,
    actionHistory: st.actionHistory,
    stage: st.stage,
    chipUnit: 0.01,
    fixedLimitSmallBet: 2,
  } as unknown as HorseGameStateV2);
}

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

describe('joint street betting replicates the authoritative controller', () => {
  it.each(['nlh', 'plo4', 'flh', 'flo8', 'short_deck'] as GameVariant[])(
    '%s post-flop menus, bounds and reopening agree with HandController on every decision',
    (variant) => {
      let compared = 0,
        reopenRefusals = 0,
        oneWagers = 0,
        funded = 0;
      for (let game = 0; game < 120; game++) {
        const rng = random(1310 + game * 7919);
        const stacks = Array.from(
          { length: 3 + (game % 4) },
          () => Math.round((4 + rng() * 120) * 100) / 100
        );
        const { hc, st } = controller(variant, stacks, 1 + (game % stacks.length));
        for (let step = 0; step < 80 && !['showdown', 'complete'].includes(st().stage); step++) {
          const seat = st().currentPlayerSeat;
          const player: SeatPlayer = st().players.find((p: SeatPlayer) => p.seat === seat);
          if (!player) break;
          const auth = hc.getAuthoritativeActionState(player.user_id)!;
          if (!auth.canAct) break;
          if (st().stage !== 'preflop') {
            const street = liveStreet(variant, st());
            const copy = { ...player };
            const mine = jointLegalMenu(street, copy);
            expect(mine, JSON.stringify({ game, step, history: st().actionHistory })).toEqual({
              legalActions: auth.legalActions,
              toCall: auth.toCall,
              minRaiseTo: auth.minRaiseTo,
              maxRaiseTo: auth.maxRaiseTo,
            });
            if (st().currentBet > player.bet && player.stack > st().currentBet - player.bet)
              if (!jointMayReopen(street, copy)) reopenRefusals++;
            // The bounded tree's one wager is always accepted by the controller.
            const wager = jointOneWager(street, copy);
            if (wager && rng() < 0.35) {
              oneWagers++;
              performJointAction(street, copy, wager.action, wager.amount);
              const stage = st().stage;
              const standing = st().currentBet;
              const recorded = st().actionHistory.length;
              expect(hc.performAction(seat, wager.action, wager.amount)).toBe(true);
              const record = st().actionHistory[recorded];
              const mine = street.history.at(-1)!;
              expect({
                action: record.action,
                amount: record.amount,
                isFullRaise: record.isFullRaise,
              }).toEqual({
                action: mine.action,
                amount: mine.amount,
                isFullRaise: mine.isFullRaise,
              });
              // The one bounded wager always puts in a new standing bet.
              expect(['bet', 'raise', 'all_in']).toContain(record.action);
              expect(record.amount).toBeGreaterThan(standing);
              const after = st().players.find((p: SeatPlayer) => p.seat === seat);
              // While the street is still open (nobody's excess was returned
              // by the end of the hand) the funded state is identical.
              const open = st().players.filter((p: SeatPlayer) => !p.is_folded && !p.is_all_in);
              if (st().stage === stage && open.length >= 2) {
                funded++;
                expect(after.stack).toBeCloseTo(copy.stack, 6);
                expect(after.totalInvested).toBeCloseTo(copy.totalInvested, 6);
                expect(st().pot).toBeCloseTo(street.pot, 6);
                expect(st().currentBet).toBeCloseTo(street.currentBet, 6);
                expect(st().lastRaise).toBeCloseTo(street.lastRaise, 6);
              }
              compared++;
              continue;
            }
          }
          const menu = auth.legalActions;
          const roll = rng();
          let action =
            menu.includes('call') && roll < 0.55
              ? 'call'
              : menu.includes('check')
                ? 'check'
                : 'fold';
          let amount: number | undefined;
          if (roll > 0.7 && (menu.includes('raise') || menu.includes('bet'))) {
            action = menu.includes('raise') ? 'raise' : 'bet';
            amount = rng() < 0.5 ? auth.minRaiseTo! : auth.maxRaiseTo!;
          } else if (roll > 0.9 && menu.includes('all_in')) action = 'all_in';
          hc.performAction(seat, action as any, amount);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(400);
      expect(oneWagers).toBeGreaterThan(20);
      expect(funded).toBeGreaterThan(10);
      if (variant === 'nlh') expect(reopenRefusals).toBeGreaterThan(0);
    }
  );
});
