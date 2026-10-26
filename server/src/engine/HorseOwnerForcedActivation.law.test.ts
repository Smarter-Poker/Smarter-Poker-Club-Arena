/**
 * EVERY HORSE BRAIN PHASE IS ACTIVE (Dan 2026-10-26: "FORCE ACTIVATE EVERY
 * PHASE NOW WITHOUT QUALIFYING").
 *
 * Before this order Phases 8, 10, 11, 12, 13 and 14 ran in shadow on every
 * live decision, because no protected release selection was committed. This
 * law drives the REAL decision worker with its production admission wiring and
 * proves, for every game, that the phase pack for that game makes the
 * decision (candidate mode), that the engine's receipt check accepts what the
 * worker returns, and that the main-thread gate rechecks the authority as
 * usable, so nothing falls back to the engine's safety default.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { HorseMind } from './HorseMind.js';
import {
  defaultHorseDecisionWorkerDependencies as defaults,
  HorseDecisionWorkerRuntime,
} from './horseDecision/workerRuntime.js';
import {
  buildHorseDecisionKey,
  type HorseDecisionWorkerResponse,
} from './horseDecision/protocol.js';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { captureHorseHandJournalContext } from './HorseDecisionHandBinding.js';
import { applyTableCommitmentCap } from './ServerTableEngineTurns.js';
import { seedFastRandom } from './HorseEval.js';
import {
  admitHorsePhase8LiveAuthority,
  admitHorsePhase8ReleaseAuthority,
  HorsePhase8AuthorityGate,
  liveHorsePhase8Authority,
} from './HorseQualifiedAuthority.js';
import {
  admitHorsePhase10LiveAuthority,
  liveHorsePhase10Authority,
} from './HorsePhase10Authority.js';
import {
  admitHorsePhase11LiveAuthority,
  HORSE_PHASE11_VARIANTS,
  liveHorsePhase11Authorities,
} from './HorsePhase11Authority.js';
import {
  admitHorsePhase12LiveAuthority,
  HORSE_PHASE12_VARIANTS,
  liveHorsePhase12Authorities,
} from './HorsePhase12Authority.js';
import {
  admitHorsePhase13LiveAuthority,
  HORSE_PHASE13_VARIANTS,
  liveHorsePhase13Authorities,
} from './HorsePhase13Authority.js';
import {
  admitHorsePhase14LiveAttachment,
  HORSE_PHASE14_DOMAINS,
  horsePhase14CorrectiveMode,
  liveHorsePhase14Authorities,
} from './HorsePhase14Authority.js';
import {
  HORSE_OWNER_FORCED_ACTIVATION,
  isHorseOwnerForcedAuthority,
} from './HorseOwnerForcedActivation.js';
import type { HandConfig, HorseDecision, SeatPlayer } from '../types.js';

afterEach(() => HorseMind.reset());

describe('the owner order activates every phase (Dan 2026-10-26)', () => {
  it('records the order verbatim and covers all six gated phases', () => {
    expect(HORSE_OWNER_FORCED_ACTIVATION.order).toBe(
      'FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING'
    );
    expect([...HORSE_OWNER_FORCED_ACTIVATION.phases]).toEqual([
      'phase8',
      'phase10',
      'phase11',
      'phase12',
      'phase13',
      'phase14',
    ]);
  });

  it('every live admission is admitted for the running code, while the release admission alone is still unselected', () => {
    expect(admitHorsePhase8ReleaseAuthority().status).toBe('refused');
    const all = [
      admitHorsePhase8LiveAuthority(),
      admitHorsePhase10LiveAuthority(),
      ...HORSE_PHASE11_VARIANTS.map((v) => admitHorsePhase11LiveAuthority(v)),
      ...HORSE_PHASE12_VARIANTS.map((v) => admitHorsePhase12LiveAuthority(v)),
      ...HORSE_PHASE13_VARIANTS.map((v) => admitHorsePhase13LiveAuthority(v)),
    ];
    for (const admission of all) {
      expect(admission.status, JSON.stringify(admission)).toBe('admitted');
      if (admission.status === 'admitted')
        expect(isHorseOwnerForcedAuthority(admission.authority)).toBe(true);
    }
  });

  it('every main-thread gate is usable', () => {
    const gates: HorsePhase8AuthorityGate[] = [
      liveHorsePhase8Authority,
      liveHorsePhase10Authority,
      ...HORSE_PHASE11_VARIANTS.map((v) => liveHorsePhase11Authorities[v]),
      ...HORSE_PHASE12_VARIANTS.map((v) => liveHorsePhase12Authorities[v]),
      ...HORSE_PHASE13_VARIANTS.map((v) => liveHorsePhase13Authorities[v]),
    ];
    for (const gate of gates) {
      gate.ensureAdmitted();
      expect(gate.mainState()).toBe('usable');
    }
  });

  it('Phase 14: every cash domain and every hold em tournament domain runs the corrective kernel', () => {
    const active: string[] = [];
    for (const domain of HORSE_PHASE14_DOMAINS) {
      const attachment = admitHorsePhase14LiveAttachment(domain);
      const gate = liveHorsePhase14Authorities[domain];
      gate.ensureAdmitted();
      if (attachment.admission.status !== 'admitted') continue;
      expect(gate.mainState(), domain).toBe('usable');
      const mode = horsePhase14CorrectiveMode({
        callerMode: undefined,
        domain,
        packDomain: domain,
        verdict: 'usable',
        catalog: attachment.catalog,
      });
      expect(mode.mode, domain).toBe('candidate');
      active.push(domain);
    }
    for (const domain of HORSE_PHASE14_DOMAINS.filter((d) => d.endsWith('-cash')))
      expect(active, domain).toContain(domain);
    for (const domain of ['nlh-mtt', 'nlh-sng', 'nlh-spin', 'nlh-hu_sng'])
      expect(active, domain).toContain(domain);
  });
});

const PACK: Record<string, keyof HorseDecision> = {
  plo4: 'plo4Policy',
  plo5: 'omahaVariantPolicy',
  plo6: 'omahaVariantPolicy',
  plo8: 'omahaVariantPolicy',
  short_deck: 'remainingVariantPolicy',
  pineapple: 'remainingVariantPolicy',
  flh: 'remainingVariantPolicy',
  flo8: 'remainingVariantPolicy',
};

function gateFor(key: keyof HorseDecision, variant: string): HorsePhase8AuthorityGate | undefined {
  if (key === 'plo4Policy') return liveHorsePhase10Authority;
  if (key === 'omahaVariantPolicy')
    return liveHorsePhase11Authorities[variant as keyof typeof liveHorsePhase11Authorities];
  if (key === 'remainingVariantPolicy')
    return liveHorsePhase12Authorities[variant as keyof typeof liveHorsePhase12Authorities];
  if (key === 'jointPolicy')
    return liveHorsePhase13Authorities[variant as keyof typeof liveHorsePhase13Authorities];
  return undefined;
}

/** Plays real cash hands through the production worker for one variant. */
async function playCash(variant: string, hands: number) {
  // A filtered variant must admit its own main-thread gates; another test's
  // admission assertions are not setup for this real-worker exercise.
  const pack = PACK[variant];
  if (pack) gateFor(pack, variant)?.ensureAdmitted();
  gateFor('jointPolicy', variant)?.ensureAdmitted();
  const messages: HorseDecisionWorkerResponse[] = [];
  const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), {
    ...defaults,
    startServices: async () => defaults.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => false,
    journalAcceptedHand: () => {},
    journalLifecycle: () => {},
    noteFeature: () => {},
    noteDecision: () => {},
  });
  await worker.start();
  const seen = {
    decisions: 0,
    invalid: 0,
    refusedAtGate: 0,
    modes: new Map<string, number>(),
    invalidCases: [] as unknown[],
  };
  const bump = (k: string) => seen.modes.set(k, (seen.modes.get(k) ?? 0) + 1);
  let requestId = 1;
  for (let hand = 0; hand < hands; hand++) {
    seedFastRandom(1000 + hand);
    const seats = 2 + (hand % 5);
    const table = `30000000-0000-4000-8000-${String(hand).padStart(12, '0')}`;
    const config: HandConfig = {
      tableId: table,
      handNumber: 5000 + hand,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      isTournament: false,
      rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
    } as HandConfig;
    const players = Array.from({ length: seats }, (_, i) => ({
      seat: i + 1,
      user_id: `40000000-0000-4000-8000-${String(hand * 10 + i).padStart(12, '0')}`,
      username: `H${i}`,
      stack: 200 + 37 * i,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    })) as SeatPlayer[];
    const controller = new HandController(config, players, 1 + (hand % seats));
    controller.start();
    for (let step = 0; step < 80; step++) {
      const live = controller.getState();
      if (live.stage === 'pineapple_discard') {
        for (const p of live.players.filter((x) => !x.is_folded && x.cards.length === 3))
          if (!controller.performDiscard(p.seat, 0)) break;
        controller.flushPineappleSettle();
        continue;
      }
      const spot = controllerDecisionState(controller, variant as never, 'cash', config);
      if (!spot) break;
      spot.state.commitmentCapRemaining = applyTableCommitmentCap(
        controller.getAuthoritativeActionState(spot.hero.user_id)!,
        spot.hero,
        false,
        0,
        config.bigBlind
      ).commitmentCapRemaining;
      const request = {
        type: 'DECIDE_FAST' as const,
        requestId: requestId++,
        generation: 1,
        fence: `${table}:${config.handNumber}:${spot.hero.seat}:${step}:1`,
        decisionKey: '',
        decisionTimeMs: Date.now() + 10000,
        player: spot.hero,
        gameState: spot.state,
        style: 'balanced' as const,
        mods: {},
        handJournalContext: captureHorseHandJournalContext(spot.state.actionHistory!),
      };
      request.decisionKey = buildHorseDecisionKey(request);
      const before = messages.length;
      worker.receive(request);
      await worker.drain();
      const result = messages.slice(before).find((m) => m.type === 'FAST_RESULT') as
        | (HorseDecisionWorkerResponse & { decision: HorseDecision } & Record<string, any>)
        | undefined;
      if (!result) break;
      seen.decisions++;
      const decision = result.decision;
      if (!horseDecisionReceiptIsValid(decision, variant)) {
        seen.invalid++;
        // Retain the first synthetic rejection for diagnosis. The secure deal
        // is intentionally unchanged; the fast RNG seed alone cannot replay it.
        if (seen.invalidCases.length === 0)
          seen.invalidCases.push(
            structuredClone({
              variant,
              hand,
              step,
              fastRandomSeed: 1000 + hand,
              config,
              request,
              decision,
            })
          );
      }
      // Mirror the client: observe every pack's worker receipt, stamp, recheck.
      const r = result as Record<string, any>;
      if (r.phase10Authority) liveHorsePhase10Authority.observeWorker(r.phase10Authority);
      for (const [all, gates] of [
        [r.phase11Authority, liveHorsePhase11Authorities],
        [r.phase12Authority, liveHorsePhase12Authorities],
        [r.phase13Authority, liveHorsePhase13Authorities],
      ] as const)
        if (all)
          for (const [v, receipt] of Object.entries(all))
            (gates as Record<string, HorsePhase8AuthorityGate>)[v]?.observeWorker(receipt);
      for (const key of [PACK[variant], 'jointPolicy'] as const) {
        const receipt = decision[key] as
          | { mode?: string; applied?: boolean; authority?: any; variant?: string }
          | undefined;
        if (!receipt) continue;
        bump(`${String(key)}:${receipt.mode}`);
        if (receipt.applied) {
          const gate = gateFor(key, variant);
          const verdict = gate?.check(gate.stamp(receipt.authority));
          if (verdict !== 'usable') seen.refusedAtGate++;
        }
      }
      const amount =
        decision.action === 'call'
          ? undefined
          : decision.amount === undefined
            ? undefined
            : Number(decision.amount);
      if (!controller.performAction(spot.hero.seat, decision.action, amount)) {
        if (!controller.performAction(spot.hero.seat, spot.baseline.action, spot.baseline.amount))
          break;
      }
    }
  }
  await worker.drain();
  return seen;
}

describe('the real worker decides every game with its phase pack in charge', () => {
  for (const variant of Object.keys(PACK))
    it(`${variant}: the ${PACK[variant]} pack runs as candidate and every decision is accepted`, async () => {
      const seen = await playCash(variant, 6);
      expect(seen.decisions).toBeGreaterThan(5);
      expect(
        seen.invalid,
        JSON.stringify({ modes: [...seen.modes], invalidCases: seen.invalidCases }).slice(
          0,
          256 * 1024
        )
      ).toBe(0);
      expect(seen.refusedAtGate).toBe(0);
      expect(
        seen.modes.get(`${PACK[variant]}:candidate`) ?? 0,
        JSON.stringify([...seen.modes])
      ).toBeGreaterThan(0);
      expect(seen.modes.get(`${PACK[variant]}:shadow`) ?? 0, JSON.stringify([...seen.modes])).toBe(
        0
      );
    }, 120_000);

  it('nlh: the joint multiway owner runs as candidate and every decision is accepted', async () => {
    const seen = await playCash('nlh', 8);
    expect(seen.decisions).toBeGreaterThan(5);
    expect(
      seen.invalid,
      JSON.stringify({ modes: [...seen.modes], invalidCases: seen.invalidCases }).slice(
        0,
        256 * 1024
      )
    ).toBe(0);
    expect(seen.refusedAtGate).toBe(0);
    expect(seen.modes.get('jointPolicy:shadow') ?? 0, JSON.stringify([...seen.modes])).toBe(0);
  }, 120_000);
});
