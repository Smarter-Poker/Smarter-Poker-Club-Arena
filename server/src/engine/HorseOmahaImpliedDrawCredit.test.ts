import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Eval from './HorseEval.js';
import * as Ev from './HorseEvEngine.js';
import { calculatePots, calculateContestablePot } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import fixture from './fixtures/horse-plo5-paired-turn-46012984.json';
type Variant = 'plo4' | 'plo5' | 'plo6' | 'plo8' | 'nlh';
const suits: Record<string, Card['suit']> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({ rank: c[0] as Card['rank'], suit: suits[c[1]] }));
function price(variant: Variant, hole = '8s Th Ad 4h', board = 'Ac 3s Js Jh') {
  const actions = fixture.actions as unknown as ActionRecord[];
  const n = actions[18].publicNode as Extract<HorsePublicActionNode, { status: 'captured' }>;
  const ids = new Map(fixture.players.map((p) => [p.seat, p.userId]));
  const players: SeatPlayer[] = n.seats.map(
    ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) => ({
      seat,
      user_id: ids.get(seat)!,
      username: `Seat ${seat}`,
      stack,
      bet,
      totalInvested,
      deadInvested,
      individualAnteInvested,
      is_folded: !!(flags & 1),
      is_all_in: !!(flags & 2),
      is_sitting_out: !!(flags & 4),
      cards: [],
    })
  );
  const own = cards(hole);
  if (variant === 'plo5' && own.length === 4) own.push(...cards('7d'));
  if (variant === 'plo6') own.push(...cards('7d 6d'));
  const hero: SeatPlayer = { ...players.find((p) => p.seat === 6)!, cards: own };
  if (n.deductions?.status !== 'captured') throw Error('missing deductions');
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    dealtSeatIds: players.map((p) => p.seat),
    blindSeats: { smallBlind: 5, bigBlind: 6 },
    chipUnit: n.chipUnit,
    asset: n.asset,
    heroSeat: 6,
    currentPlayerSeat: 6,
    legalActions: [...n.legalActions],
    toCall: n.toCall,
    minRaiseTo: n.minRaiseTo,
    maxRaiseTo: n.maxRaiseTo,
    bettingStructure: n.structure,
    fixedBetSize: n.fixedBetSize,
    wagersCapped: n.wagersCapped,
    pots: calculatePots(players),
    contestablePot: calculateContestablePot(players, hero.user_id, n.toCall),
    rakeConfig: {
      ...n.deductions.rake,
      playerCountCaps: n.deductions.rake.playerCountCaps.map(([players, cap]) => ({
        players,
        cap,
      })),
    },
    bbjConfig: n.deductions.bbj,
    variantRules: horseVariantRulesFor(variant),
    players,
    communityCards: cards(board),
    communityCards2: [],
    communityCards3: [],
    bombPot: false,
    boardCount: 1,
    pot: n.pot,
    currentBet: n.currentBet,
    minRaise: 60,
    lastRaise: 60,
    stage: 'turn',
    gameVariant: variant,
    bigBlind: 2,
    dealerSeat: 4,
    actionHistory: actions.slice(0, 18),
    gameMode: 'cash',
    format: 'cash',
    ante: 2,
    straddleActive: false,
  };
  HorseMind.reset();
  Eval.seedFastRandom(100);
  // Control only MC input. Physical draw evaluation, pressure caps, policy and EV remain real.
  const simulate = Eval.simulateEquity;
  vi.spyOn(Eval, 'simulateEquity').mockImplementation((...args) => {
    simulate(...args);
    return 0.35;
  });
  const spy = vi.spyOn(Ev, 'evaluateSpot');
  const decision = HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
  return {
    decision,
    input: spy.mock.calls.at(-1)?.[0],
    draw: Eval.omahaDrawQuality(own, gs.communityCards, variant === 'plo8'),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('physical Omaha draw credit reaches the actual pricing consumer', () => {
  for (const v of ['plo4', 'plo5', 'plo6', 'plo8'] as const)
    it(`${v}: no draw cannot invent implied equity`, () => {
      const out = price(v);
      expect(out.draw).toMatchObject({ nutty: false, dominatedFlushDraw: false, straightOuts: 0 });
      expect(out.input).toBeDefined();
      expect(out.input!.equity).toBeCloseTo(0.34, 10);
      expect(out.decision.action).toBe('call'); // modeled call retained; no blanket paired-board fold
    });
  it('retains nut-flush draw credit', () => {
    const o = price('plo4', '8s Th As 4h');
    expect(o.draw.nutFlushDraw).toBe(true);
    expect(o.input!.equity).toBeCloseTo(0.39, 10);
    expect(o.decision.action).toBe('call');
  });
  it('retains existing dominated-flush draw credit', () => {
    const o = price('plo4', '8s Th Ad 7s');
    expect(o.draw.dominatedFlushDraw).toBe(true);
    expect(o.input!.equity).toBeCloseTo(0.38, 10);
    expect(o.decision.action).toBe('call');
  });
  it('retains actual wrap credit', () => {
    const o = price('plo5', 'Ks Qs Jc Th 3h', 'Kd 9h 8s 2c');
    expect(o.draw.bigWrap).toBe(true);
    expect(o.input!.equity).toBeCloseTo(0.39, 10);
  });
  it('retains actual nut-low split-pot call', () => {
    const o = price('plo8', 'Ah 2h Jc Qd', '3c 4s Jh Jd');
    expect(o.draw.nutLowDraw).toBe(true);
    expect(o.decision.action).toBe('call');
  });
  it('preserves the NLH reference decision', () => {
    expect(price('nlh', 'Ad Th').decision.action).toBe('fold');
  });
});
