import type { Card } from '../../types.js';
import type { RiverReferenceInput } from './riverReference.js';
import { evidenceDigest } from './authority.js';
import { correctiveUtilityContextDigest } from './review.js';
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
export const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[c[1] as 's'],
  }));
export const bind = (i: RiverReferenceInput): RiverReferenceInput => {
  const hero = {
    seat: 1,
    user_id: 'hero',
    username: 'hero',
    cards: i.hero,
    bet: 0,
    totalInvested: 25,
    stack: i.stack,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const opponent = {
    ...hero,
    seat: 2,
    user_id: 'opponent',
    cards: [],
    bet: i.toCall,
    totalInvested: 75,
    stack: 0,
    is_all_in: true,
  };
  i.original = {
    snapshot: {
      type: 'DECIDE_FAST',
      requestId: 1,
      generation: 1,
      fence: 'original',
      decisionTimeMs: 1,
      decisionKey: 'original',
      player: hero,
      gameState: {
        stateSchemaVersion: 1,
        players: [hero, opponent],
        communityCards: i.board,
        stage: i.stage,
        gameVariant: i.domain.variant,
        format: i.domain.format,
        gameMode: i.domain.mode,
        boardCount: 1,
        asset: 'chips',
        chipUnit: 0.01,
        bbjConfig: null,
        dealtSeatIds: [1, 2],
        dealerSeat: 2,
        currentBet: i.toCall,
        toCall: i.toCall,
        pot: i.contestablePot,
        contestablePot: i.contestablePot,
        bigBlind: i.bigBlind,
        legalActions: ['fold', 'call'],
        minRaiseTo: null,
        maxRaiseTo: null,
        rakeConfig: { percent: 5, cap: i.finalRake, noFlopNoDrop: true },
      },
    } as unknown as FastHorseDecisionRequest,
    readFrame: { declaredRange: i.range },
  };
  i.original = structuredClone(i.original);
  i.binding = {
    ...i.binding,
    inputDigest: evidenceDigest(i.original.snapshot),
    readFrameDigest: evidenceDigest(i.original.readFrame),
  };
  i.rangeReadFrameDigest = i.binding.readFrameDigest;
  i.rangeDigest = evidenceDigest(i.range);
  i.utilityContextDigest = correctiveUtilityContextDigest(i.original.snapshot);
  return i;
};
export const riverReferenceFixture = (): RiverReferenceInput =>
  bind({
    evidenceClass: 'synthetic_fixture',
    sourceId: 'river-finite-range-v1',
    qualificationId: 'qualification-required',
    producerDigest: 'a'.repeat(64),
    binding: {
      decisionEventId: 'original-decision',
      decisionDigest: 'b'.repeat(64),
      executionDigest: 'c'.repeat(64),
      acceptedHandDigest: 'd'.repeat(64),
      inputDigest: 'e'.repeat(64),
      readFrameDigest: 'f'.repeat(64),
      sourceRelease: '1'.repeat(40),
    },
    domain: { variant: 'nlh', format: 'cash', mode: 'cash' },
    stage: 'river',
    boardCount: 1,
    opponents: 1,
    opponentAllIn: true,
    hero: cards('As Ah'),
    board: cards('Ac Ad 7h 8d 9c'),
    range: [{ cards: cards('Ks Kh'), weight: 1 }],
    rangeDigest: '0'.repeat(64),
    rangeReadFrameDigest: 'f'.repeat(64),
    contestablePot: 100,
    toCall: 50,
    stack: 50,
    bigBlind: 2,
    finalRake: 4,
    utilityContextDigest: '2'.repeat(64),
    original: null as never,
  });
