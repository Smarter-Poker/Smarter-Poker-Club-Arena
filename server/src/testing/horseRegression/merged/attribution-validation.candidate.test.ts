import { describe, expect, it } from 'vitest';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import { tournamentPreflopPolicy } from '../../../engine/HorseTournamentPreflop.js';
import {
  horsePhase6AttributionIsValid,
  horsePhase6AttributionMatchesSnapshot,
  observePhase6Lookup,
  createPhase6Attribution,
} from '../../../engine/HorsePhase6Attribution.js';
import { createHorseExecutionWitness } from '../../../engine/HorseExecutionWitness.js';
import { horseDecisionReceiptIsValid } from '../../../engine/horseDecision/responseValidation.js';
import { fixture, request, withPhase6Provenance } from './fixture.js';
export function decision(f = fixture()) {
  seedFastRandom(901791);
  return HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts);
}
const malformed = [
  ['version', (r: any) => (r.version = 'unknown')],
  ['private', (r: any) => (r.cards = ['As', 'Ks'])],
  ['source_authority', (r: any) => (r.inputSource.basis = 'authoritative_live_state')],
  ['source_version', (r: any) => (r.inputSource.stateSchemaVersion = Infinity)],
  ['lookup_claim', (r: any) => (r.atlasEvaluated = false)],
  ['forward_claim', (r: any) => (r.forwardedToIntentEngine = false)],
  ['status', (r: any) => (r.status = 'applied')],
  ['optimality', (r: any) => (r.gtoOptimality = 'verified')],
  ['causal', (r: any) => (r.causalInfluence = 'verified')],
  ['coordinate_nan', (r: any) => (r.lookup.coordinate.stackBB = NaN)],
  ['coordinate_negative', (r: any) => (r.lookup.coordinate.stackBB = -1)],
  ['coordinate_extra', (r: any) => (r.lookup.coordinate.actorId = 'private')],
  ['position', (r: any) => (r.lookup.coordinate.heroPosition = 'XX')],
  ['family', (r: any) => (r.lookup.coordinate.gameFamily = 'omaha')],
  ['source', (r: any) => (r.lookup.policy.source = 'approved_artifact')],
  ['policy_extra', (r: any) => (r.lookup.policy.strategySeed = 3)],
  ['cell', (r: any) => (r.lookup.policy.cell += ':forged')],
  ['depth_weight', (r: any) => (r.lookup.policy.depth.weight = 0.25)],
  ['depth_anchor', (r: any) => (r.lookup.policy.depth.lower = 5)],
  ['shift_nan', (r: any) => (r.lookup.policy.shifts.open = NaN)],
  ['shift_infinite', (r: any) => (r.lookup.policy.shifts.call = Infinity)],
  ['shift_unbounded', (r: any) => (r.lookup.policy.shifts.jam = 2)],
  ['fallback', (r: any) => (r.lookup.policy.fallbackReason = 'incomplete_context')],
  ['reference_shape', (r: any) => (r.referenceProposal.seed = 44)],
  ['reference_amount', (r: any) => (r.referenceProposal.amount = -1)],
] as const;
describe('prepared Phase6 receipt validation and input ownership', () => {
  it('copies source and current-hand provenance through the private accepted-action witness', () => {
    const s = withPhase6Provenance(request());
    seedFastRandom(901791);
    const d = HorseLogic.decide(s.player, s.gameState, 'balanced', {}, fixture().opts);
    const r = d.tournamentPreflopAttribution!;
    expect(r.version).toBe('horse-phase6-attribution-v2');
    expect(r.inputSource.atlasRevision).toBe('horse-tournament-preflop-v1');
    expect(horsePhase6AttributionMatchesSnapshot(d, s)).toBe(true);
    expect(Object.isFrozen(r.inputSource.tournamentContext!.source)).toBe(true);
    expect(Object.isFrozen(s.gameState.tournament!.contextProvenance)).toBe(false);
    const witness = createHorseExecutionWitness(s, d, {
      requestId: s.requestId,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    expect(witness.phase6Attribution).toEqual(r);
    s.gameState.tournament!.contextProvenance!.source!.generation++;
    expect(witness.phase6Attribution!.inputSource.tournamentContext!.source!.generation).toBe(1);
    expect(horsePhase6AttributionMatchesSnapshot(d, s)).toBe(false);
    expect(horsePhase6AttributionMatchesSnapshot({ action: 'fold', thinkTime: 1 }, s)).toBe(false);
    expect(
      horsePhase6AttributionMatchesSnapshot(
        { action: 'fold', thinkTime: 1, policyFallback: 'brain_exception' },
        s
      )
    ).toBe(true);
    const legacy = decision();
    expect(legacy.tournamentPreflopAttribution!.version).toBe('horse-phase6-attribution-v1');
    expect(horsePhase6AttributionMatchesSnapshot(legacy, request())).toBe(true);
    expect(horsePhase6AttributionMatchesSnapshot(legacy, s)).toBe(false);
  });

  it.each(malformed)('rejects malformed %s', (name, mutate) => {
    const d = structuredClone(decision()),
      r = d.tournamentPreflopAttribution!;
    expect(horsePhase6AttributionIsValid(r)).toBe(true);
    mutate(r);
    expect(horsePhase6AttributionIsValid(r), name).toBe(false);
    expect(horseDecisionReceiptIsValid(d), name).toBe(false);
    expect(horsePhase6AttributionMatchesSnapshot(d, request()), name).toBe(false);
  });
  it.each([
    'depth',
    'context',
    'velocity',
    'dealer',
    'history',
    'mode',
    'legacy_option',
    'stage',
  ] as const)('rejects a valid-shaped receipt attached to changed %s input', (fault) => {
    const d = decision(),
      s = request();
    if (fault === 'depth') s.player.stack += 100;
    if (fault === 'context') s.gameState.tournament!.contextStatus = 'stale';
    if (fault === 'velocity') s.gameState.tournament!.m!.velocityMPerMinute += 1;
    if (fault === 'dealer') s.gameState.dealerSeat = 2;
    if (fault === 'history')
      s.gameState.actionHistory!.push({
        seat: 2,
        userId: s.gameState.players[1].user_id,
        action: 'raise',
        amount: 200,
        stage: 'preflop',
        timestamp: 1,
      });
    if (fault === 'mode') s.gameState.gameMode = 'cash';
    if (fault === 'legacy_option') s.opts.v7Preflop = false;
    if (fault === 'stage') s.gameState.stage = 'flop';
    expect(horsePhase6AttributionIsValid(d.tournamentPreflopAttribution)).toBe(true);
    expect(horsePhase6AttributionMatchesSnapshot(d, s)).toBe(false);
  });
  it('binds reference proposal to the graph reference rather than final action', () => {
    const d = structuredClone(decision());
    const r = d.tournamentPreflopAttribution!;
    r.referenceProposal.action = r.referenceProposal.action === 'fold' ? 'call' : 'fold';
    expect(horsePhase6AttributionIsValid(r)).toBe(true);
    expect(horsePhase6AttributionMatchesSnapshot(d, request())).toBe(false);
  });
  it('keeps legacy missing evidence absent and refuses a caught-brain attribution claim', () => {
    const d = decision(),
      legacy = structuredClone(d);
    delete legacy.tournamentPreflopAttribution;
    expect(horseDecisionReceiptIsValid(legacy)).toBe(true);
    expect(horsePhase6AttributionMatchesSnapshot(legacy, request())).toBe(true);
    const fallback = {
      action: 'fold',
      thinkTime: 1500,
      policyFallback: 'brain_exception',
      tournamentPreflopAttribution: d.tournamentPreflopAttribution,
    };
    expect(horseDecisionReceiptIsValid(fallback)).toBe(false);
    expect(horsePhase6AttributionMatchesSnapshot(fallback as any, request())).toBe(false);
  });
  it('owns and freezes the lookup and witness across a structured-clone transport', () => {
    const f = fixture(),
      original = decision(f),
      d = structuredClone(original),
      r = d.tournamentPreflopAttribution!;
    const witness = createHorseExecutionWitness(request(f), d, {
      requestId: 1,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    expect(witness.phase6Attribution).toEqual(r);
    expect(witness.phase6Attribution).not.toBe(r);
    r.lookup!.policy.shifts.open = 0.99;
    expect(witness.phase6Attribution!.lookup!.policy.shifts.open).not.toBe(0.99);
    for (const object of [
      original.tournamentPreflopAttribution,
      original.tournamentPreflopAttribution!.lookup,
      original.tournamentPreflopAttribution!.lookup!.coordinate,
      witness.phase6Attribution,
      witness.phase6Attribution!.lookup!.policy.depth,
      witness.phase6Attribution!.lookup!.policy.shifts,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    for (const privateKey of [
      'cards',
      'coveringOpponents',
      'userId',
      'user_id',
      'decisionKey',
      'seed',
    ])
      expect(JSON.stringify(witness.phase6Attribution)).not.toContain(`"${privateKey}"`);
  });
  it('does not touch unrelated M covering identities during diagnostic capture', () => {
    const f = fixture(),
      actual = decision(f).tournamentPreflopAttribution!;
    const input = { ...actual.lookup!.coordinate, m: f.state.tournament!.m! };
    const policy = tournamentPreflopPolicy(input);
    Object.defineProperty(input.m, 'coveringOpponents', {
      get() {
        throw Error('unrelated private identity read');
      },
    });
    const captured = observePhase6Lookup(input, policy);
    expect(captured.policy).toEqual(policy);
    policy.depth.weight = 0.99;
    expect(captured.policy.depth.weight).toBe(0.5);
  });
  it.each([1, 3.5, 11])(
    'retains an honest finite invalid-coordinate fallback at table size %s',
    (tableSize) => {
      const f = fixture(),
        r = decision(f).tournamentPreflopAttribution!;
      const input = { ...r.lookup!.coordinate, tableSize, m: f.state.tournament!.m! };
      const lookup = observePhase6Lookup(input, tournamentPreflopPolicy(input));
      const receipt = createPhase6Attribution({ route: 'intent_engine', lookup }, f.state, true, {
        action: 'fold',
        thinkTime: 0,
      });
      expect(receipt).toMatchObject({
        status: 'unavailable',
        lookup: {
          policy: {
            source: 'labeled_fallback',
            fallbackReason: 'invalid_coordinate',
            shifts: { open: 0, jam: 0, call: 0, threeBet: 0, fourBet: 0 },
          },
        },
      });
      expect(horsePhase6AttributionIsValid(receipt)).toBe(true);
      const changed = structuredClone(receipt)!;
      changed.lookup!.policy.shifts.call = 0.01;
      expect(horsePhase6AttributionIsValid(changed)).toBe(false);
    }
  );
});
