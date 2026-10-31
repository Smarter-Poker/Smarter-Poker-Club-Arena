import { CATASTROPHE_GUARD_VERSION } from '../HorseTournamentCatastropheGuard.js';
/** Synthetic real-runtime control around original public review399839.
 * The historical full field was not retained: reconstructPhase8Hand supplies
 * an explicitly reconstructed field. Nothing here is natural/source-qualified
 * production proof. No seed search, strategy answer substitution or table IO.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { reconstructPhase8Hand, type CapturedPhase8Hand } from '../HorsePhase8ReplayFixture.js';
import { HorseLogic, type HorseDecideOpts } from '../HorseLogic.js';
import { buildTournamentMState } from '../HorseTournamentPreflop.js';
import { calculatePots, calculateContestablePot } from '../PokerEngine.js';
import { HorseMind } from '../HorseMind.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { saveFastRandom, restoreFastRandom } from '../HorseEval.js';
import { drainFires, enableBrainTelemetry, restoreFires } from '../BrainTelemetry.js';
import { prepareTournamentFutureHandFacts } from '../HorseTournamentFutureHand.js';
import { solverPolicyArtifactStatus } from '../../gto/SolverPolicyArtifactLoader.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { withPhase6Provenance } from '../../testing/horseRegression/merged/fixture.js';
import {
  guardTestAdmission,
  GUARD_TEST_NOW,
} from '../HorseTournamentCatastropheGuardAuthority.test-support.js';
import {
  HorseQualifiedAuthorityHolder,
  HorsePhase8AuthorityGate,
  type HorseAuthorityAdmission,
} from '../HorseQualifiedAuthority.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type FastHorseDecisionResult,
  type DeepHorseDecisionRequest,
  type DeepHorseDecisionResult,
  type HorseDecisionWorkerResponse,
} from './protocol.js';
import { currentReplaySolverStores } from './replay/references.js';
import { qualifiedReplayAdmissions } from './replay/qualifiedAuthority.js';
import { withFrozenHorseReplayClock } from './replay/exactReplay.js';
import {
  horseJournalJson,
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../services/horseDecisionJournal/record.js';
import {
  createHorseExecutionWitness,
  expectedHorseExecutionAmount,
  settleHorseExecutionWitness,
  recordHorsePhase8GuardVerdict,
} from '../HorseExecutionWitness.js';

// V61 (2026-10-29) shades hold'em one-pair river calls by default; these
// captured replays keep the explicit off arm so the recorded receipts and
// admissions still mean what they meant when they were captured.
export const GUARD_LIVE_TEST_SOURCE = '5'.repeat(40);
export const GUARD_LIVE_TEST_TABLE = '10000000-0000-4000-8000-000000000001';
export const GUARD_LIVE_TEST_HAND = '30000000-0000-4000-8000-000000000001';
const PRODUCER = '40000000-0000-4000-8000-000000000001';
export function guardLiveRequest(): FastHorseDecisionRequest {
  const hands: CapturedPhase8Hand[] = JSON.parse(
    readFileSync(new URL('../fixtures/phase8-production-hands.json', import.meta.url), 'utf8')
  );
  const hand = hands.find((row) => row.reviewId === 399839);
  if (!hand) throw Error('guard public fixture missing');
  const { hero, gs } = reconstructPhase8Hand(hand);
  // This closed-field synthetic control supplies explicit current protocol
  // metadata; none is represented as a captured historical tournament fact.
  const stacks = gs.tournament!.stacks!.slice().sort((a, b) => a - b);
  gs.tournament = {
    ...gs.tournament!,
    nearBubble: false,
    inMoney: false,
    registrationRequiresAuthorization: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    mysteryBountyStage: 'none',
    reentryAllowed: false,
    rebuyAllowed: false,
    addOnAvailable: false,
    onBreak: false,
    handForHand: false,
    handForHandExpected: false,
    mysteryTopLive: false,
    satellite: false,
    currentLevel: 0,
    levelDurationMin: 10,
    levelElapsedMin: 5,
    sourceAgeMs: 100,
    maxReentries: 0,
    maxRebuys: 0,
    addOnCost: 0,
    addOnChips: 0,
    addOnLevels: 0,
    nextBlindMult: 2,
    bountyByUser: {},
    bountyFactor: 0,
    mysteryChestsLeft: 0,
    mysteryMeanCents: 0,
    mysteryTopCents: 0,
    meanBountyCents: 0,
    satelliteSeats: 0,
    entrants: gs.players.length,
    seatsPerTable: Math.max(2, gs.players.length),
    playersAtTable: gs.players.length,
    avgStackChips: stacks.reduce((a, b) => a + b, 0) / stacks.length,
    medianStackChips: stacks[Math.floor(stacks.length / 2)]!,
    registrationOpen: false,
    lateRegistrationOpen: false,
    finalTable: true,
    tournamentType: 'mtt',
    tournamentStatus: 'running',
    gameVariant: 'nlh',
  };
  const id = (seat: number) => `20000000-0000-4000-8000-00000000000${seat}`;
  const aliases = new Map(gs.players.map((player) => [player.user_id, id(player.seat)]));
  for (const player of gs.players) player.user_id = aliases.get(player.user_id)!;
  hero.user_id = id(hero.seat);
  gs.actionHistory = gs.actionHistory!.map((action) => ({
    ...action,
    userId: aliases.get(action.userId!)!,
    origin: 'player',
  }));
  // Canonical worker records the whole outstanding price; the controller
  // separately caps an accepted call to the remaining stack.
  gs.toCall = Math.max(0, gs.currentBet - hero.bet);
  gs.pots = calculatePots(gs.players);
  gs.contestablePot = calculateContestablePot(gs.players, hero.user_id, gs.toCall ?? 0);
  gs.tournament!.stackByUser = Object.fromEntries(
    Object.entries(gs.tournament!.stackByUser!).map(([key, value]) => [aliases.get(key)!, value])
  );
  Object.assign(gs, {
    dealtSeatIds: gs.players.map((p) => p.seat),
    communityCards2: [],
    communityCards3: [],
    smallBlind: gs.bigBlind / 2,
    blindSeats: { smallBlind: gs.players[1]!.seat, bigBlind: gs.players[2]!.seat },
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    chipUnit: 1,
    asset: 'chips',
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    bbjConfig: null,
  });
  const t = gs.tournament!;
  t.m = buildTournamentMState({
    stackChips: hero.stack,
    smallBlind: t.currentSmallBlind!,
    bigBlind: t.currentBigBlind!,
    ante: t.currentAnte!,
    anteType: t.anteType!,
    playersAtTable: t.playersAtTable!,
    nextSmallBlind: t.nextSmallBlind!,
    nextBigBlind: t.nextBigBlind!,
    nextAnte: t.nextAnte!,
    minutesToNextLevel: t.nextBlindInMin!,
    opponentStacks: gs.players
      .filter((p) => p.user_id !== hero.user_id && !p.is_sitting_out)
      .map((p) => ({ userId: p.user_id, stackChips: p.stack })),
    previousZone: null,
  });
  let request: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${GUARD_LIVE_TEST_TABLE}:12:${hero.seat}:9:7`,
    decisionTimeMs: GUARD_TEST_NOW,
    decisionKey: '',
    player: hero,
    gameState: gs,
    style: 'balanced',
    mods: {},
    opts: { mind: false, v61RiverOnePairShade: false },
    handJournalContext: captureHorseHandJournalContext(gs.actionHistory),
  };
  request = withPhase6Provenance(request);
  const provenance = request.gameState.tournament!.contextProvenance!;
  provenance.readAtMs = GUARD_TEST_NOW;
  if (provenance.source) {
    provenance.source.readStartedAtMs = GUARD_TEST_NOW - 150;
    provenance.source.readCompletedAtMs = GUARD_TEST_NOW - 100;
  }
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}
export function guardLiveReadiness() {
  const { identity, charts, postflop, postflopV31, postflopV31Dataset } =
    currentReplaySolverStores();
  return {
    solverStores: { charts, postflop, postflopV31, postflopV31Dataset },
    solverStoreIdentity: identity,
    solverPolicyArtifact: solverPolicyArtifactStatus(),
    governor: equityGovernor.snapshot(),
  };
}
export function guardLiveHarness(admission: HorseAuthorityAdmission | null = guardTestAdmission()) {
  const messages: HorseDecisionWorkerResponse[] = [],
    captures: Array<{ snapshot: unknown; body: any }> = [],
    lifecycle: Array<{ snapshot: unknown; body: unknown }> = [],
    holders = new Map<string, HorseQualifiedAuthorityHolder>(),
    decisionOptions: HorseDecideOpts[] = [];
  const deps: HorseDecisionWorkerDependencies = {
    ...qualifiedReplayAdmissions,
    admitPhase8GuardAuthority: () =>
      admission ?? { status: 'refused', reason: 'unselected', transient: false },
    journalEnabled: () => true,
    journalDecision: (snapshot, body) => {
      captures.push({ snapshot: structuredClone(snapshot), body: structuredClone(body) });
    },
    journalLifecycle: (snapshot, body) => {
      lifecycle.push({ snapshot: structuredClone(snapshot), body: structuredClone(body) });
    },
    async startServices() {
      prepareTournamentFutureHandFacts();
      return guardLiveReadiness();
    },
    async stopServices() {},
    decide: (player, gs, style, mods, opts) => {
      decisionOptions.push({ ...opts });
      return HorseLogic.decide(player, gs, style, mods, opts);
    },
    prepareOriginalReads: HorseLogic.prepareOriginalReads.bind(HorseLogic),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: () => {
      throw Error('control never applies private plans');
    },
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    atGovernorScale: (fn) => equityGovernor.withDecisionScale(fn),
    workerReadiness: guardLiveReadiness,
    phase8SafetyDisabledReason: () => null,
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: () => {},
    now: () => 0,
  };
  const runtime = new HorseDecisionWorkerRuntime(
    (message) => messages.push(message),
    deps,
    undefined,
    (owner, variant, version, epoch) => {
      const holder = new HorseQualifiedAuthorityHolder(epoch, version);
      holders.set(`${owner}:${variant ?? ''}`, holder);
      return holder;
    }
  );
  return { runtime, messages, captures, lifecycle, holders, decisionOptions, deps };
}
export async function runGuardLiveFast(
  h: ReturnType<typeof guardLiveHarness>,
  request = guardLiveRequest(),
  originalMonotonicClock = false
) {
  const rng = saveFastRandom(),
    parked = drainFires();
  enableBrainTelemetry();
  const originalNow = performance.now.bind(performance);
  try {
    await withFrozenHorseReplayClock(request.decisionTimeMs, async () => {
      // The journal control retains an actual measured original policyMs; the
      // replay freezes its clock, so stableReceipt must normalize only that timing.
      if (originalMonotonicClock)
        Object.defineProperty(performance, 'now', {
          value: originalNow,
          configurable: true,
          writable: true,
        });
      await h.runtime.start();
      h.runtime.receive(request);
      await h.runtime.drain();
    });
    const result = h.messages.find(
      (m): m is FastHorseDecisionResult =>
        m.type === 'FAST_RESULT' && m.requestId === request.requestId
    );
    if (!result) throw Error('real guard FAST control refused');
    return result;
  } finally {
    restoreFastRandom(rng);
    drainFires();
    restoreFires(parked);
  }
}
export async function runGuardLiveDeep(
  h: ReturnType<typeof guardLiveHarness>,
  request: FastHorseDecisionRequest,
  fast: FastHorseDecisionResult
) {
  const deep: DeepHorseDecisionRequest = {
    ...request,
    type: 'DECIDE_DEEP',
    requestId: request.requestId + 1,
    rngBefore: fast.rngBefore,
    deepEquity: 2,
  };
  await withFrozenHorseReplayClock(request.decisionTimeMs, async () => {
    h.runtime.receive(deep);
    await h.runtime.drain();
  });
  const result = h.messages.find(
    (m): m is DeepHorseDecisionResult => m.type === 'DEEP_RESULT' && m.requestId === deep.requestId
  );
  if (!result) throw Error('real guard DEEP control refused');
  return result;
}
/** Synthetic accepted-hand join over a real original worker result. Parent
 * journal/phaseProof tests can retain, reconcile and tamper this exact capture.
 * Acceptance here is an explicit control record, not a historical controller claim. */
export async function guardLiveJournalFixture() {
  const request = guardLiveRequest(),
    h = guardLiveHarness(),
    result = await runGuardLiveFast(h, request, true);
  const capture = h.captures.find((c) => c.body.snapshot.type === 'DECIDE_FAST')!.body;
  const mainDecision = structuredClone(result.decision);
  const guard = mainDecision.tournamentCatastropheGuard;
  if (!guard?.applied || !guard.authority)
    throw Error('original public guard control did not apply');
  const main = new HorsePhase8AuthorityGate(
    () => guardTestAdmission(),
    'guard-journal-main',
    CATASTROPHE_GUARD_VERSION
  );
  main.refresh();
  main.observeWorker(result.phase8GuardAuthority!);
  guard.authority = main.stamp(guard.authority);
  const verdict = main.check(guard.authority, GUARD_TEST_NOW);
  if (verdict !== 'usable') throw Error('synthetic main guard authority unavailable');
  const witness = createHorseExecutionWitness(request, mainDecision, {
    requestId: result.requestId,
    lane: 'fast',
    computeMs: result.computeMs,
    governorScale: result.governorScale,
  });
  const accepted = {
    seat: request.player.seat,
    userId: request.player.user_id,
    action: result.decision.action,
    amount: expectedHorseExecutionAmount(request, result.decision) ?? 0,
    timestamp: GUARD_TEST_NOW + 1,
    stage: request.gameState.stage,
  };
  recordHorsePhase8GuardVerdict(witness, verdict);
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: accepted, intended: true }],
  });
  const ordinal = request.gameState.actionHistory!.length;
  const hand = {
    generation: 12,
    fence: `${GUARD_LIVE_TEST_TABLE}:12:9:observe`,
    handKey: `${GUARD_LIVE_TEST_TABLE}:12`,
    committedHandId: GUARD_LIVE_TEST_HAND,
    bigBlind: request.gameState.bigBlind,
    actions: [
      ...request.gameState.actionHistory!,
      {
        ...accepted,
        origin: 'horse_policy',
        publicNode: {
          version: 1,
          status: 'captured',
          actorSeat: request.player.seat,
          street: request.gameState.stage,
        },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId: GUARD_LIVE_TEST_HAND,
          actionOrdinal: ordinal,
          observationId: `${GUARD_LIVE_TEST_HAND}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const handKey = journalHash(`${GUARD_LIVE_TEST_TABLE}:12:9`),
    turnKey = journalHash(
      JSON.stringify([
        request.generation,
        request.fence,
        request.requestId,
        request.decisionKey,
        request.decisionTimeMs,
      ])
    );
  let sequence = 0;
  const make = (kind: HorseJournalRecord['kind'], body: unknown) =>
    makeHorseJournalRecord(
      {
        producerId: PRODUCER,
        sequence: ++sequence,
        sourceRelease: GUARD_LIVE_TEST_SOURCE,
        atMs: GUARD_TEST_NOW,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : turnKey,
      },
      body
    );
  const requested = h.lifecycle.find((row) => (row.body as any).phase === 'requested')!.body,
    terminal = h.lifecycle.find((row) => (row.body as any).phase === 'terminal')!.body;
  const records = [
    make('request_lifecycle', requested),
    make('decision', capture),
    make('request_lifecycle', terminal),
    make('execution', witness),
    make('accepted_hand', hand),
  ];
  return {
    request,
    h,
    result,
    capture,
    mainDecision,
    witness,
    hand,
    handKey,
    records,
    decisionRecord: records[1]!,
    executionRecord: records[3]!,
    originalRequestSha256: journalHash(horseJournalJson(request)),
    synthetic: true as const,
  };
}
