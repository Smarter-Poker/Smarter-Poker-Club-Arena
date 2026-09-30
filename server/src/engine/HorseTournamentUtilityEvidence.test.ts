import { describe, expect, it } from 'vitest';
import { HorseMind, type ReadScope } from './HorseMind.js';
import type { TournamentUtilityInput } from './HorseTournamentUtility.js';
import type { SeatPlayer } from '../types.js';
import {
  buildHorseTournamentUtilityEvidence,
  captureHorseTournamentUtilityObservations,
  horseTournamentUtilityEvidenceIsValid,
  horseTournamentUtilityInputSha256,
} from './HorseTournamentUtilityEvidence.js';

function input(): TournamentUtilityInput {
  const seat = (user_id: string, n: number): SeatPlayer => ({
    user_id,
    seat: n,
    username: user_id,
    stack: 900,
    bet: 100,
    totalInvested: 100,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  });
  const hero = seat('hero', 1),
    opponent = seat('opponent', 2);
  return {
    street: 'river',
    hero,
    players: [hero, opponent],
    pots: [{ amount: 200, eligiblePlayers: ['hero', 'opponent'] }],
    pot: 200,
    currentBet: 100,
    toCall: 0,
    legalActions: ['check', 'raise', 'all_in'],
    minRaiseTo: 200,
    maxRaiseTo: 1_000,
    bettingStructure: 'no_limit',
    baseline: { action: 'check', thinkTime: 50 },
    heroEquity: 0.5,
    equitySampleSize: 320,
    equityStandardError: 0.028,
    opponents: [{ userId: 'opponent', range: [0.2, 0.8], foldMul: 1.45, actsAfterHero: true }],
    sampledOpponentIds: ['opponent'],
    showdownSamples: Array.from({ length: 16 }, (_, i) => ({
      boards: [
        {
          heroHigh: i % 2 === 0 ? 2 : 0,
          opponentHigh: [1],
          heroLow: null,
          opponentLow: [null],
          opponentDecisionStrength: [i / 16],
        },
      ],
    })),
    context: {
      format: 'mtt',
      playersLeft: 2,
      spotsPaid: 1,
      satellite: false,
      satelliteSeats: 0,
      payoutPct: [100],
      fieldStacks: [1_000, 1_000],
      fieldStackByUser: { hero: 1_000, opponent: 1_000 },
      isPko: false,
      isBounty: false,
      isMysteryBounty: false,
      mysteryBountyStage: 'none',
      bountyFactor: 0,
      bountyByUser: {},
      mysteryMeanCents: 0,
      meanBountyCents: 0,
      prizePoolCents: 10_000,
      bountyPoolCents: 0,
      reentryOpen: false,
      rebuyOpen: false,
      maxReentries: 0,
      maxRebuys: 0,
      addOnPeriodOpen: false,
      addOnCostCents: null,
      addOnChips: null,
      buyInCents: null,
      startingStackChips: null,
      rebuyCostCents: null,
      rebuyChips: null,
      rebuyPrizeContributionCents: null,
      rebuyBountyContributionCents: null,
      reloadsUsed: 0,
      addOnTaken: false,
      rebuyAffordable: false,
      addOnAffordable: false,
    },
  };
}

function reads(scopedHands = 40, scope: ReadScope = 'holdem:hu') {
  const view = HorseMind.createSandbox();
  HorseMind.runInSandbox(view, () => {
    HorseMind.importStats([
      {
        user_id: 'opponent',
        hands: 90,
        vpip: 30,
        pfr: 20,
        folds: 80,
        facedAggr: 90,
        rHands: 12.5,
        rFolds: 3,
        rFacedAggr: 4,
      },
    ]);
    HorseMind.importScoped([
      { user_id: 'opponent', scope, hands: scopedHands, vpip: 8, pfr: 3, folds: 10, facedAggr: 30 },
    ]);
  });
  return view;
}

describe('Phase 7 actual utility input and read provenance', () => {
  it('copies only detached statistics during active intent capture without weakening full-frame ownership', () => {
    const value = input();
    HorseMind.runInSandbox(reads(), () => {
      const priorScope = HorseMind.currentScope();
      try {
        HorseMind.setDecisionScope('holdem:hu');
        const captured = HorseMind.captureDecisionEffects(() => {
          expect(() => HorseMind.snapshotDecisionReads(value.players, null)).toThrow(
            'invalid boundary'
          );
          return captureHorseTournamentUtilityObservations(value.players.slice(1), true);
        });
        expect(captured.effects).toEqual([]);
        HorseMind.getStats('opponent')!.hands = 500;
        HorseMind.getScopedStats('opponent', 'holdem:hu')!.hands = 600;
        expect(captured.value.reads.stats.get('opponent')!.hands).toBe(90);
        expect(captured.value.reads.scoped.get('holdem:hu|opponent')!.hands).toBe(40);
        expect(Object.keys(captured.value.reads).sort()).toEqual(['scoped', 'stats']);
        expect(
          buildHorseTournamentUtilityEvidence(value, captured.value).opponents[0].statistics.source
        ).toBe('family_size');
      } finally {
        HorseMind.setDecisionScope(priorScope);
      }
    });
  });

  it('keeps unknown historical windows, calibration and scope isolation explicit', () => {
    const receipt = buildHorseTournamentUtilityEvidence(input());
    expect(receipt.observations).toEqual({
      status: 'unavailable',
      scope: null,
      window: { status: 'not_recorded', from: null, to: null },
      tableIsolation: 'not_established',
      formatIsolation: 'not_established',
      exactVariantIsolation: 'not_established',
    });
    expect(receipt.opponents[0].statistics).toEqual({
      source: 'unavailable',
      scope: null,
      counters: null,
    });
    expect(receipt.responseModel).toEqual({
      id: 'mdf-strength-v1',
      calibration: 'uncalibrated',
      modelErrorBound: null,
    });
    expect(receipt.confidence).toEqual({
      basis: 'conditional_sampling_equity_icm',
      responseModelErrorIncluded: false,
    });
    expect(horseTournamentUtilityEvidenceIsValid(structuredClone(receipt), ['opponent'])).toBe(
      true
    );
  });

  it.each([39, 40])(
    'matches the actual scoped threshold at %s hands while keeping recency pooled',
    (hands) => {
      const receipt = buildHorseTournamentUtilityEvidence(input(), {
        scope: 'holdem:hu',
        reads: reads(hands),
        mindEnabled: true,
      });
      expect(receipt.opponents[0].statistics).toMatchObject(
        hands < 40
          ? { source: 'pooled', scope: null, counters: { hands: 90, folds: 80 } }
          : { source: 'family_size', scope: 'holdem:hu', counters: { hands: 40, folds: 10 } }
      );
      expect(receipt.opponents[0].recency).toEqual({
        source: 'pooled',
        counters: { rHands: 12.5, rFolds: 3, rFacedAggr: 4 },
      });
      expect(receipt.opponents[0]).toMatchObject({
        range: [0.2, 0.8],
        foldMul: 1.45,
        actsAfterHero: true,
      });
    }
  );

  it('does not turn another family or another table/format request into exact-scope observation authority', () => {
    const source = reads(80, 'omaha:hu');
    const receipt = buildHorseTournamentUtilityEvidence(input(), {
      scope: 'holdem:hu',
      reads: source,
      mindEnabled: true,
    });
    expect(receipt.opponents[0].statistics.source).toBe('pooled');
    expect(receipt.observations).toMatchObject({
      tableIsolation: 'not_established',
      formatIsolation: 'not_established',
      exactVariantIsolation: 'not_established',
    });
    const differentFormat = input();
    differentFormat.context.format = 'spin';
    const spin = buildHorseTournamentUtilityEvidence(differentFormat, {
      scope: 'holdem:hu',
      reads: source,
      mindEnabled: true,
    });
    expect(spin.inputSha256).not.toBe(receipt.inputSha256);
    expect(spin.observations).toEqual(receipt.observations);
    expect(spin.opponents).toEqual(receipt.opponents);
  });

  it('labels the literal scoped recency fallback and does not infer missing evidence as zero', () => {
    const source = reads();
    source.stats.delete('opponent');
    const receipt = buildHorseTournamentUtilityEvidence(input(), {
      scope: 'holdem:hu',
      reads: source,
      mindEnabled: true,
    });
    expect(receipt.opponents[0].recency.source).toBe('family_size_fallback');
    const unknown = buildHorseTournamentUtilityEvidence(input(), {
      scope: 'sixplus:full',
      reads: source,
      mindEnabled: true,
    });
    expect(unknown.opponents[0].statistics.counters).toBeNull();
    const disabled = buildHorseTournamentUtilityEvidence(input(), {
      scope: 'holdem:hu',
      reads: reads(),
      mindEnabled: false,
    });
    expect(disabled.opponents[0].statistics).toEqual({
      source: 'disabled',
      scope: null,
      counters: null,
    });
  });

  it('snapshots nested evidence without aliasing live counters or the input ranges', () => {
    const source = reads(),
      value = input();
    const receipt = buildHorseTournamentUtilityEvidence(value, {
      scope: 'holdem:hu',
      reads: source,
      mindEnabled: true,
    });
    const serialized = JSON.stringify(receipt);
    source.scoped.get('holdem:hu|opponent')!.hands = 400;
    source.stats.get('opponent')!.rHands = 99;
    value.opponents[0].range![0] = 0.6;
    expect(JSON.stringify(receipt)).toBe(serialized);
    expect(Object.isFrozen(receipt.opponents[0].statistics.counters)).toBe(true);
    expect(Object.isFrozen(receipt.opponents[0].range)).toBe(true);
    expect(Object.isFrozen(receipt.observations.window)).toBe(true);
    expect('showdownSamples' in receipt).toBe(false);
    expect(Buffer.byteLength(serialized)).toBeLessThan(2_048);
  });

  it.each([
    'stack',
    'pot_right',
    'payout',
    'bounty',
    'sample',
    'range',
    'fold',
    'baseline',
    'settlement',
    'field',
    'continuation',
  ] as const)('binds the actual %s input instead of a descriptive model label', (field) => {
    const value = input(),
      original = horseTournamentUtilityInputSha256(value);
    if (field === 'stack') value.players[1].stack++;
    if (field === 'pot_right') value.pots[0].eligiblePlayers.reverse();
    if (field === 'payout') value.context.payoutPct[0]--;
    if (field === 'bounty') value.context.bountyByUser.opponent = 100;
    if (field === 'sample') value.showdownSamples[0].boards[0].opponentDecisionStrength[0] = 0.9;
    if (field === 'range') value.opponents[0].range![0] = 0.3;
    if (field === 'fold') value.opponents[0].foldMul = 1;
    if (field === 'baseline') value.baseline = { action: 'raise', amount: 200, thinkTime: 50 };
    if (field === 'settlement') value.settlement = { chipUnit: 1, dealerSeat: 2, splitLow: false };
    if (field === 'field') value.context.fieldStackByUser.opponent++;
    if (field === 'continuation') value.continuation = { dealerSeat: 2, bigBlind: 100 };
    expect(horseTournamentUtilityInputSha256(value)).not.toBe(original);
  });

  it('uses canonical object ordering and excludes think time and deadline callbacks', () => {
    const a = input(),
      b = input();
    b.context = Object.fromEntries(Object.entries(b.context).reverse()) as typeof b.context;
    b.baseline.thinkTime = 9_999;
    b.withinBudget = () => {
      throw Error('evidence must not run a deadline callback');
    };
    expect(horseTournamentUtilityInputSha256(b)).toBe(horseTournamentUtilityInputSha256(a));
    b.continuation = { dealerSeat: 2, bigBlind: 100, withinBudget: b.withinBudget };
    a.continuation = { dealerSeat: 2, bigBlind: 100 };
    expect(horseTournamentUtilityInputSha256(b)).toBe(horseTournamentUtilityInputSha256(a));
  });

  it.each([
    'calibration',
    'window',
    'isolation',
    'duplicate',
    'range',
    'counter',
    'scope',
    'digest',
    'extra',
  ] as const)(
    'refuses malformed or overstated %s evidence at a structured-clone boundary',
    (field) => {
      const value = structuredClone(
        buildHorseTournamentUtilityEvidence(input(), {
          scope: 'holdem:hu',
          reads: reads(),
          mindEnabled: true,
        })
      ) as any;
      if (field === 'calibration') value.responseModel.calibration = 'calibrated';
      if (field === 'window') value.observations.window.from = 123;
      if (field === 'isolation') value.observations.tableIsolation = 'verified';
      if (field === 'duplicate') value.opponents.push(value.opponents[0]);
      if (field === 'range') value.opponents[0].range = [0.8, 0.2];
      if (field === 'counter') value.opponents[0].statistics.counters.hands = NaN;
      if (field === 'scope') value.opponents[0].statistics.scope = 'omaha:hu';
      if (field === 'digest') value.inputSha256 = 'abc';
      if (field === 'extra') value.observations.sourceTableId = 'invented';
      expect(horseTournamentUtilityEvidenceIsValid(value, ['opponent'])).toBe(false);
    }
  );

  it('rejects foreign or ambiguous opponent identities and nonfinite hashed inputs', () => {
    const value = input(),
      receipt = buildHorseTournamentUtilityEvidence(value);
    expect(horseTournamentUtilityEvidenceIsValid(receipt, ['other'])).toBe(false);
    expect(horseTournamentUtilityEvidenceIsValid(receipt, ['opponent', 'opponent'])).toBe(false);
    value.heroEquity = NaN;
    expect(() => horseTournamentUtilityInputSha256(value)).toThrow('invalid');
  });
});
