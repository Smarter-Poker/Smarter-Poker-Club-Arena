import { publishedCashPricing } from '../config/leagueCashPricing.js';
import {
  requestAt,
  workerHarness,
  wager,
  commitOf,
} from '../testing/horseRegression/plan/fixture.js';
import {
  buildHorseDecisionKey,
  validatedHorsePolicySamplingKey,
} from './horseDecision/protocol.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonical,
  HorseQualifiedAuthorityHolder,
  HorsePhase8AuthorityGate,
} from './HorseQualifiedAuthority.js';
import {
  admitHorseFeatureAuthority,
  admittedHorseFeatureFlags,
  featureDomainMatches,
  horseFeatureAcceptanceUsable,
  HORSE_FEATURE_AUTHORITY_VERSION,
  type HorseFeatureDomain,
  type HorseFeatureSelection,
} from './HorseFeatureAuthority.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from './horseDecision/replay/qualifiedAuthority.js';
import { horsePlanPolicyGenerationFromDecision } from './HorsePlanEffectReceipt.js';
import type { HorseDecision } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
const hash = (x: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
const bh = (x: Buffer) => createHash('sha256').update(x).digest('hex');
const now = Date.now();
const domain: HorseFeatureDomain = {
  variant: 'plo4',
  mode: 'cash',
  asset: 'chips',
  boardCount: 1,
  dealtSeats: [2],
  remainingPlayers: [2],
  effectiveStackBB: [20, 100],
  startingStackBB: 100,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  bigBlindAnte: false,
  bettingStructure: 'pot_limit',
  chipUnit: 0.01,
  ...publishedCashPricing({ tournament: false, variant: 'plo4', tableSeats: 6, seats: 2 }),
  sidePots: false,
};
// Unsigned in-memory fixture only. No production selection or population is created.
function fixture(mutate?: (q: any, plan: any, pop: any) => void) {
  const source = Buffer.from('synthetic fixture source');
  const paths = [
    'src/engine/HorseFeatureAuthority.ts',
    'src/engine/HorseLogic.ts',
    'src/engine/horseDecision/workerRuntime.ts',
    'src/engine/horseDecision/client.ts',
  ];
  const files = Object.fromEntries(paths.map((p) => [p, bh(source)]));
  const plan: any = {
    schema: 'horse-incremental-ablation-plan-v2',
    state: 'heldout_locked',
    target: 'combo_draw_pressure',
    population: 'fixture',
    flags: { candidate: { comboDrawPressure: true }, reference: { comboDrawPressure: false } },
    dependencyDigest: bh(source),
    runtimeSourceFiles: files,
    runtimeSourceDigest: hash(files),
  };
  const pop: any = {
    schema: 'horse-public-population-qualification-v1',
    qualified: true,
    activationAllowed: false,
    evidenceClass: 'public_observed_disjoint_holdout',
    selectionOverlap: false,
    rawEvidenceSha256: 'a'.repeat(64),
    providerInventorySha256: 'b'.repeat(64),
    opportunities: 100,
    reasons: [],
    domainDigest: hash(domain),
    populationId: 'fixture',
    uncertaintyDigest: 'c'.repeat(64),
  };
  const q: any = {
    schema: 'horse-feature-live-admission-v1',
    version: HORSE_FEATURE_AUTHORITY_VERSION,
    qualificationKind: 'locked_paired_condition_a',
    qualified: true,
    activationAllowed: false,
    reasons: [],
    sourceSha: 'a'.repeat(40),
    domain,
    compositionDigest: hash(plan.flags),
    populationUncertaintyDigest: pop.uncertaintyDigest,
  };
  mutate?.(q, plan, pop);
  q.domain = {
    ...q.domain,
    ...publishedCashPricing({
      tournament: false,
      variant: q.domain.variant,
      tableSeats: 6,
      seats: 2,
    }),
  };
  q.profileId = `${plan.target}-${q.domain.variant}-6max-2dealt-100bb`;
  plan.profiles = [
    { id: q.profileId, variant: q.domain.variant, seats: 2, stackBB: 100, weight: 1 },
  ];
  plan.liveAdmission = {
    schema: 'horse-feature-live-domain-v1',
    profileId: q.profileId,
    domain: q.domain,
  };
  const assembly = {
    schema: 'horse-feature-ablation-assembly-v1',
    qualified: true,
    activationAllowed: false,
    reasons: [],
    sourceSha: q.sourceSha,
    planDigest: hash(plan),
    target: plan.target,
    summary: {
      qualified: true,
      activationAllowed: false,
      planDigest: hash(plan),
      byVariant: { [q.domain.variant]: { qualified: true } },
    },
    provider: { rawArtifactsRetained: true, inventorySha256: 'd'.repeat(64) },
  };
  const records = new Map<string, Buffer>();
  const bound = (name: string, value: unknown) => {
    const path = `docs/evidence/feature-activation/${name}.json`,
      bytes = Buffer.from(JSON.stringify(value));
    records.set(path, bytes);
    return { path, sha256: bh(bytes) };
  };
  q.plan = bound('plan', plan);
  q.assembly = bound('assembly', assembly);

  const binding = bound('qualification', q);
  const selection: HorseFeatureSelection = {
    schema: 'horse-feature-release-selection-v1',
    qualificationPath: binding.path,
    qualificationSha256: binding.sha256,
    sourceSha: q.sourceSha,
    approvalGeneration: 1,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    withdrawn: null,
  };
  const reader = {
    read: (p: string) => {
      const b = records.get(p);
      if (!b) throw Error('missing');
      return b;
    },
  };
  return {
    selection,
    reader,
    source,
    paths,
    admit: (s = selection, src = source) =>
      admitHorseFeatureAuthority(
        s,
        reader,
        now,
        () => src,
        () => paths
      ),
  };
}
function state() {
  return {
    gameVariant: 'plo4',
    gameMode: 'cash',
    asset: 'chips',
    boardCount: 1,
    dealtSeatIds: [0, 1],
    players: [
      { seat: 0, stack: 200, bet: 0, totalInvested: 0, is_folded: false },
      { seat: 1, stack: 200, bet: 0, totalInvested: 0, is_folded: false },
    ],
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    bigBlindAnte: false,
    bettingStructure: 'pot_limit',
    chipUnit: 0.01,
    rakeConfig: domain.rakeConfig,
    bbjConfig: domain.bbjConfig,
    pots: [],
    straddleActive: false,
    bombPot: false,
    allInOrFold: false,
  } as unknown as HorseGameStateV2;
}
describe('feature authority connected admission and receipt', () => {
  it('admits exact evidence, derives flags, and refuses economics or caller subsets', () => {
    const f = fixture(),
      a = f.admit();
    expect(a.status).toBe('admitted');
    if (a.status !== 'admitted') throw Error();
    expect(admittedHorseFeatureFlags(a.authority, true, state(), {}).comboDrawPressure).toBe(true);
    expect(
      admittedHorseFeatureFlags(a.authority, true, state(), { comboDrawPressure: false })
        .comboDrawPressure
    ).toBe(false);
    for (const patch of [
      { bigBlind: 4 },
      { ante: 2 },
      { gameMode: 'tournament' },
      { rakeConfig: { ...domain.rakeConfig, cap: 10 } },
      { bbjConfig: { enabled: true, feeBB: 1, minPotBB: 1, minPlayersDealt: 2 } },
      { straddleActive: true },
    ])
      expect(featureDomainMatches(domain, { ...state(), ...patch } as HorseGameStateV2)).toBe(
        false
      );
  });
  it('binds main, worker, effects and exact replay; withdrawal and restart refuse', () => {
    const f = fixture(),
      a = f.admit();
    if (a.status !== 'admitted') throw Error();
    const holder = new HorseQualifiedAuthorityHolder(
      '11111111-1111-4111-8111-111111111111',
      HORSE_FEATURE_AUTHORITY_VERSION
    );
    holder.apply(a);
    const gate = new HorsePhase8AuthorityGate(
      () => a,
      'fixture-main',
      HORSE_FEATURE_AUTHORITY_VERSION
    );
    gate.refresh();
    gate.observeWorker(holder.receipt());
    const decision = {
      action: 'check',
      thinkTime: 0,
      featureAuthority: {
        version: 'horse-feature-decision-v1',
        authority: gate.stamp(holder.receipt()),
        flags: a.authority.featureFlags!,
        domain: a.authority.featureDomain!,
        compositionDigest: a.authority.featureCompositionDigest!,
      },
    } as HorseDecision;
    expect(horseFeatureAcceptanceUsable(decision, gate)).toBe(true);
    expect(
      horsePlanPolicyGenerationFromDecision(decision).candidates.some((x) => x.owner === 'features')
    ).toBe(true);
    const raw = {
      ...decision,
      featureAuthority: { ...decision.featureAuthority!, authority: holder.receipt() },
    };
    const replay = qualifiedReplayAuthorityHolders(raw, 'plo4', {
      ...qualifiedReplayAdmissions,
      admitFeatureAuthority: () => a,
    })('features', null, HORSE_FEATURE_AUTHORITY_VERSION, 'new');
    expect(replay.receipt()).toEqual(holder.receipt());
    expect(() =>
      qualifiedReplayAuthorityHolders(raw, 'plo4', {
        ...qualifiedReplayAdmissions,
        admitFeatureAuthority: () => ({
          status: 'refused',
          reason: 'unselected',
          transient: false,
        }),
      })('features', null, HORSE_FEATURE_AUTHORITY_VERSION, 'new')
    ).toThrow();
    expect(
      horseFeatureAcceptanceUsable(
        {
          ...decision,
          featureAuthority: { ...decision.featureAuthority!, compositionDigest: 'bad' },
        },
        gate
      )
    ).toBe(false);
    gate.forgetWorker(holder.receipt().epoch);
    expect(horseFeatureAcceptanceUsable(decision, gate)).toBe(false);
    gate.observeWorker(holder.receipt());
    gate.withdraw('qualification withdrawn');
    expect(horseFeatureAcceptanceUsable(decision, gate)).toBe(false);
  });
  it('new exact small blind capture changes full identity without resampling baseline', () => {
    const prior = requestAt(),
      captured = structuredClone(prior);
    captured.gameState.smallBlind = 1;
    captured.decisionKey = buildHorseDecisionKey(captured);
    expect(captured.decisionKey).not.toBe(prior.decisionKey);
    expect(validatedHorsePolicySamplingKey(captured)).toBe(validatedHorsePolicySamplingKey(prior));
  });
  it('actual worker derives flags, journals receipt and rejects caller grants', async () => {
    const f = fixture((q, p, pop) => {
      q.domain = { ...domain, variant: 'nlh', bettingStructure: 'no_limit' };
      pop.domainDigest = hash(q.domain);
    });
    // Fixture assembler variant is updated by the fixture builder below.
    const a = f.admit();
    expect(a.status).toBe('admitted');
    for (const admitted of [false, true]) {
      const seen: any[] = [];
      const h = workerHarness({
        admitFeatureAuthority: () =>
          admitted ? a : { status: 'refused', reason: 'unselected', transient: false },
        decide: (_p, _g, _s, _m, o) => {
          seen.push(o);
          return wager();
        },
      });
      try {
        const r = requestAt();
        Object.assign(r.gameState, {
          ...domain,
          variant: undefined,
          gameVariant: 'nlh',
          mode: undefined,
          gameMode: 'cash',
          bettingStructure: 'no_limit',
          straddleActive: false,
          bombPot: false,
          allInOrFold: false,
        });
        r.player.stack = 194;
        r.gameState.players.forEach((p) => (p.stack = 194));
        r.gameState.rakeConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).rakeConfig;
        r.gameState.bbjConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).bbjConfig;
        r.opts = { comboDrawPressure: true, multiwayRiverBluffCheckRaise: true };
        r.decisionKey = buildHorseDecisionKey(r);
        r.player.stack = 194;
        r.gameState.players.forEach((p) => (p.stack = 194));
        r.gameState.rakeConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).rakeConfig;
        r.gameState.bbjConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).bbjConfig;
        r.decisionKey = buildHorseDecisionKey(r);
        const result = await h.fast(r);
        expect(seen.at(-1).comboDrawPressure).toBe(admitted);
        expect(seen.at(-1).multiwayRiverBluffCheckRaise).toBe(false);
        expect(!!result.decision.featureAuthority).toBe(admitted);
        expect(!!(h.captures.at(-1)?.decision as HorseDecision).featureAuthority).toBe(admitted);
      } finally {
        await h.close();
      }
    }
  });
  it('withdrawal before worker effect commit refuses mutation, while duplicate applied receipts remain idempotent', async () => {
    const f = fixture((q, p, pop) => {
      q.domain = { ...domain, variant: 'nlh', bettingStructure: 'no_limit' };
      pop.domainDigest = hash(q.domain);
    });
    for (const appliedFirst of [false, true]) {
      const h = workerHarness({ admitFeatureAuthority: () => f.admit() });
      try {
        const r = requestAt();
        Object.assign(r.gameState, {
          smallBlind: 1,
          asset: 'chips',
          chipUnit: 0.01,
          boardCount: 1,
          ante: 0,
          bigBlindAnte: false,
          bbjConfig: domain.bbjConfig,
          rakeConfig: domain.rakeConfig,
          straddleActive: false,
          bombPot: false,
          allInOrFold: false,
        });
        r.decisionKey = buildHorseDecisionKey(r);
        r.player.stack = 194;
        r.gameState.players.forEach((p) => (p.stack = 194));
        r.gameState.rakeConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).rakeConfig;
        r.gameState.bbjConfig = publishedCashPricing({
          tournament: false,
          variant: 'nlh',
          tableSeats: 6,
          seats: 2,
        }).bbjConfig;
        r.decisionKey = buildHorseDecisionKey(r);
        const result = await h.fast(r);
        expect(result.decision.featureAuthority).toBeDefined();
        expect(result.effects.length).toBeGreaterThan(0);
        if (appliedFirst) {
          h.runtime.receive(commitOf(result, 900));
          await h.runtime.drain();
          expect(h.applied()).toBe(1);
        }
        (
          h.runtime as unknown as { featureAuthority: HorseQualifiedAuthorityHolder }
        ).featureAuthority.withdraw('test withdrawal');
        h.runtime.receive(commitOf(result, 901));
        await h.runtime.drain();
        expect(h.applied()).toBe(appliedFirst ? 1 : 0);
        expect(h.messages.find((m) => 'requestId' in m && m.requestId === 901)?.type).toBe(
          appliedFirst ? 'ACK' : 'ERROR'
        );
      } finally {
        await h.close();
      }
    }
  });
  it('refuses source drift and stress-only reports while accepting an exactly bound near-nut fixture', () => {
    const f = fixture();
    expect(f.admit(f.selection, Buffer.from('changed')).status).toBe('refused');
    expect(
      admitHorseFeatureAuthority(
        f.selection,
        f.reader,
        now,
        () => f.source,
        () => [...f.paths, 'src/newDependency.ts']
      ).status
    ).toBe('refused');
    expect(
      fixture((q, p) => {
        p.target = 'small_pot_near_nut_value_raise';
        p.flags = {
          candidate: { smallPotNearNutRiverValue: true },
          reference: { smallPotNearNutRiverValue: false },
        };
        q.compositionDigest = hash(p.flags);
      }).admit().status
    ).toBe('admitted');
    expect(fixture((q) => (q.schema = 'horse-feature-ablation-assembly-v1')).admit().status).toBe(
      'refused'
    );
    expect(f.admit({ ...f.selection, expiresAt: new Date(now - 1).toISOString() }).status).toBe(
      'refused'
    );
  });
});
