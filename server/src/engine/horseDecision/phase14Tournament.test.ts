import { qualifiedReplayAdmissions } from './replay/qualifiedAuthority.js';
import { HorseFleetPhaseInterpreter } from '../../services/horseDecisionJournal/phaseProof.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../services/horseDecisionJournal/record.js';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  retireHorseExecutionWitness,
  recordHorsePhase14Verdict,
} from '../HorseExecutionWitness.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { reconcileHorseJournalHand } from '../../services/horseDecisionJournal/review.js';
import { readHorseJournalFleet } from '../../services/horseDecisionJournal/fleet.js';
import { HorseDecisionJournalStore } from '../../services/horseDecisionJournal/store.js';
import { runtimeHorseJournalArchiveOptions } from '../../services/horseDecisionJournal/config.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../HorseTournamentPayoutTerms.js';
import { journalHash } from '../../services/horseDecisionJournal/record.js';
import { evidenceDigest } from '../../services/horseCorrectiveReview/authority.js';
import type { TournamentRiverReferenceInput } from '../../services/horseCorrectiveReview/tournamentRiverReference.js';
import {
  TOURNAMENT_RIVER_CORRECTION_KERNEL as kernel,
  TOURNAMENT_RIVER_DECISION_MODEL as model,
  TOURNAMENT_KERNEL_OBJECTIVE as objective,
  TOURNAMENT_KERNEL_UTILITY_UNIT as utilityUnit,
} from '../../services/horseCorrectiveReview/kernelTournamentDefinition.js';
import {
  tournamentKernelApprovalSigningBytes,
  verifyTournamentCorrectiveKernelApproval,
  type TournamentCorrectiveKernelApproval,
} from '../../services/horseCorrectiveReview/kernelTournamentApproval.js';
import {
  TOURNAMENT_KERNEL_CATALOG_VERSION,
  tournamentKernelCatalogDigest,
  type TournamentCorrectiveKernelCatalog,
} from '../../services/horseCorrectiveReview/kernelTournamentCatalog.js';
import { admitCorrectiveKernelAttachment } from '../../services/horseCorrectiveReview/kernelAdmission.js';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  phase14SelectionIdentityDigest,
} from '../../services/horseCorrectiveReview/kernelGenerationLedger.js';
import {
  PHASE14_GENERATION_DOMAINS,
  PHASE14_GENERATION_LEDGER_SCHEMA,
} from '../../services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
  type HorseDecisionWorkerDependencies,
} from './workerRuntime.js';
import {
  HorseQualifiedAuthorityHolder,
  HorsePhase8AuthorityGate,
  sha256,
} from '../HorseQualifiedAuthority.js';
import { qualifiedTestAdmission, testSelection } from '../HorseQualifiedAuthority.test-support.js';
import { request as cashRequest } from './phase14Worker.test-support.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type HorseDecisionWorkerResponse,
} from './protocol.js';
import { buildTournamentMState } from '../HorseTournamentPreflop.js';
import { correctiveKernelReceiptIsValid } from '../../services/horseCorrectiveReview/kernelReceipt.js';
import { horseDecisionReceiptIsValid } from './responseValidation.js';
import { proposeOriginalTournamentRiverCorrection } from '../../services/horseCorrectiveReview/tournamentRiverKernel.js';
const protectedBaseline = vi.hoisted(() => ({ selection: null as unknown }));
vi.mock('../HorseQualifiedAuthority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../HorseQualifiedAuthority.js')>()),
  get PHASE8_PROTECTED_RELEASE_SELECTION() {
    return protectedBaseline.selection;
  },
}));
protectedBaseline.selection = testSelection();
afterEach(() => vi.restoreAllMocks());
const cards = (text: string): Card[] =>
  text.split(' ').map(
    (x) =>
      ({
        rank: x[0],
        suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[x[1] as 's'],
      }) as Card
  );
function fixture(): TournamentRiverReferenceInput {
  const hero = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 80,
    bet: 10,
    totalInvested: 20,
    cards: cards('3s 5s'),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const opponent = {
    ...hero,
    user_id: 'villain',
    seat: 2,
    stack: 0,
    bet: 30,
    totalInvested: 40,
    cards: [] as Card[],
    is_all_in: true,
  };
  const source = {
    version: 1,
    tournamentId: 'spin',
    cacheId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    readStartedAtMs: 90,
    readCompletedAtMs: 100,
    contextDigest: 'a'.repeat(64),
    contextStatus: 'complete',
    contextIssues: [],
  };
  const tournament = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    sourceAgeMs: 0,
    tournamentId: 'spin',
    tournamentStatus: 'RUNNING',
    gameVariant: 'nlh',
    tournamentType: 'SPIN',
    playersLeft: 2,
    entrants: 3,
    playersAtTable: 2,
    spotsPaid: 1,
    payoutPct: [100],
    registrationOpen: false,
    lateRegistrationOpen: false,
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    reentryAllowed: false,
    rebuyAllowed: false,
    addOnAvailable: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    satellite: false,
    bountyPoolCents: 0,
    onBreak: false,
    prizePoolCents: 10001,
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    stackByUser: { hero: 100, villain: 40 },
    stacks: [100, 40],
    ...captureHorseTournamentPayoutTerms(
      {
        id: 'spin',
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: 100.01,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      [{ place: 1, percentage: 100 }],
      3,
      false
    ),
    contextProvenance: {
      version: 1,
      readAtMs: 100,
      status: 'complete',
      issues: [],
      ageMs: 0,
      source,
      projection: {
        tableId: 'table',
        handNumber: 1,
        actorId: 'hero',
        actorSeat: 1,
        dealerSeat: 2,
        dealtSeatIds: [1, 2],
        smallBlind: 1,
        bigBlind: 2,
        ante: 0,
        gameVariant: 'nlh',
      },
    },
  };
  // Like the cache publication, bind the context including its captured payout
  // terms before adding decision provenance. This is a synthetic source
  // interval, never a signed qualification or an atomic database receipt.
  const { contextProvenance: _projection, ...capturedContext } = tournament;
  source.contextDigest = createHash('sha256').update(JSON.stringify(capturedContext)).digest('hex');
  return {
    version: 'horse-wta-spin-river-reference-v1',
    original: {
      readFrame: { publicReads: [] },
      snapshot: {
        type: 'DECIDE_FAST',
        requestId: 1,
        generation: 1,
        fence: 'table:1:1:river',
        decisionTimeMs: 100,
        decisionKey: 'test',
        player: hero,
        gameState: {
          stateSchemaVersion: 1,
          gameVariant: 'nlh',
          format: 'spin',
          gameMode: 'tournament',
          stage: 'river',
          bettingStructure: 'no_limit',
          asset: 'chips',
          chipUnit: 1,
          ante: 0,
          bigBlind: 2,
          dealerSeat: 2,
          heroSeat: 1,
          currentPlayerSeat: 1,
          players: [{ ...hero, cards: [] }, opponent],
          dealtSeatIds: [1, 2],
          pot: 60,
          currentBet: 30,
          toCall: 20,
          legalActions: ['fold', 'call'],
          communityCards: cards('2c 4d 7h 9s Jc'),
          tournament,
        },
      } as unknown as TournamentRiverReferenceInput['original']['snapshot'],
    },
    range: [{ cards: cards('Ks Kh'), weight: 1 }],
    rangeReadFrameDigest: evidenceDigest({ publicReads: [] }),
  };
}

const now = Date.parse('2026-10-25T01:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trusted = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function catalogFixture() {
  const catalog: TournamentCorrectiveKernelCatalog = {
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    objective,
    utilityUnit,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    sourceRelease: '1'.repeat(40),
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: evidenceDigest('policy'),
    baselineSelectionsDigest: evidenceDigest('baseline'),
    holdoutDigest: evidenceDigest('holdout'),
    maximumConditionalProbability: 0.05,
    minimumModelGainPrizeShare: kernel.minimumModelGainPrizeShare,
  };
  const approval: TournamentCorrectiveKernelApproval = {
    version: 2,
    role: 'original_state_kernel_holdout',
    objective,
    utilityUnit,
    evidenceClass: 'reviewed_reference',
    qualificationId: 'catalog-synthetic-only',
    domain: { ...catalog.domain },
    sourceRelease: catalog.sourceRelease,
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: catalog.policyDigest,
    baselineSelectionsDigest: catalog.baselineSelectionsDigest,
    catalogDigest: tournamentKernelCatalogDigest(catalog),
    holdoutDigest: catalog.holdoutDigest,
    selectionWindowDigest: evidenceDigest('selection'),
    holdoutWindowDigest: evidenceDigest('window'),
    sourceCustodyDigest: evidenceDigest('custody'),
    numericReviewDigest: evidenceDigest('numeric'),
    rollbackDigest: evidenceDigest('rollback'),
    approvalGeneration: 1,
    issuedAt: '2026-10-25T00:00:00.000Z',
    expiresAt: '2026-10-26T00:00:00.000Z',
    measurement: {
      samples: 10000,
      changed: 10000,
      meanGain: 0.02,
      lowerGain: 0.018,
      familyWiseConfidence: 0.95,
      familySize: 45,
      maximumAbsoluteDelta: 0.05,
    },
  };
  const verified = verifyTournamentCorrectiveKernelApproval(
    {
      approval,
      publicKeyPem,
      signature: sign(null, tournamentKernelApprovalSigningBytes(approval), privateKey).toString(
        'base64'
      ),
    },
    trusted,
    now,
    { allowSynthetic: true }
  );
  expect(verified).not.toBeNull();
  return {
    catalog,
    approval: verified!,
    running: {
      policyDigest: catalog.policyDigest,
      baselineSelectionsDigest: catalog.baselineSelectionsDigest,
      nowMs: now,
    },
  };
}

function attachment() {
  const f = catalogFixture(),
    catalog = f.catalog;
  const approval = { ...f.approval };
  const envelope = {
    approval,
    publicKeyPem,
    signature: sign(null, tournamentKernelApprovalSigningBytes(approval), privateKey).toString(
      'base64'
    ),
  };
  const bytes = Buffer.from(
    JSON.stringify({ schema: 'horse-phase14-kernel-qualification-v2', catalog, approval: envelope })
  );
  const selection = {
    schema: 'horse-qualified-authority-selection-v1' as const,
    phase: 'phase14' as const,
    domain: 'nlh-spin',
    sourceSha: catalog.sourceRelease,
    catalogVersion: catalog.version,
    catalogDigest: tournamentKernelCatalogDigest(catalog),
    holdoutDigest: catalog.holdoutDigest,
    qualificationPath: 'docs/evidence/phase14/tournament-worker-test-only.json',
    qualificationSha256: sha256(bytes),
    approvalGeneration: 1,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
    withdrawn: null,
    trustedSignerKeySha256: trusted,
  };
  const ledger = {
    schema: PHASE14_GENERATION_LEDGER_SCHEMA,
    domains: Object.fromEntries(
      PHASE14_GENERATION_DOMAINS.map((domain) => [
        domain,
        {
          highestPublishedGeneration: domain === 'nlh-spin' ? 1 : 0,
          authorityDigest: domain === 'nlh-spin' ? phase14SelectionIdentityDigest(selection) : null,
          retiredGenerations: [],
        },
      ])
    ),
  };
  const result = admitCorrectiveKernelAttachment(
    'nlh-spin',
    selection,
    {
      read: (path) =>
        path === PHASE14_GENERATION_LEDGER_PATH ? Buffer.from(JSON.stringify(ledger)) : bytes,
    },
    now,
    f.running
  );
  expect(result.admission.status).toBe('admitted');
  return result;
}
function request(): FastHorseDecisionRequest {
  const r = cashRequest(),
    f = fixture().original.snapshot;
  r.player = { ...f.player, cards: cards('Ks 3h') };
  r.gameState = {
    ...r.gameState,
    ...f.gameState,
    boardCount: 1,
    contestablePot: 60,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    bbjConfig: null,
    actionHistory: [],
    pots: [
      { amount: 40, eligiblePlayers: ['hero', 'villain'] },
      { amount: 20, eligiblePlayers: ['villain'] },
    ],
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
  };
  r.fence = 'table:1:1:river';
  r.decisionTimeMs = now;
  r.opts = {
    phase10Plo4: 'off',
    phase11Omaha: 'off',
    phase12Remaining: 'off',
    phase13Joint: 'off',
  };
  const g = r.gameState;
  g.players[1]!.bet = 20;
  g.players[1]!.totalInvested = 30;
  g.currentBet = 20;
  g.toCall = 10;
  g.pot = 50;
  g.contestablePot = 50;
  g.pots = [
    { amount: 40, eligiblePlayers: ['hero', 'villain'] },
    { amount: 10, eligiblePlayers: ['villain'] },
  ];
  const t = g.tournament!;
  t.stackByUser = { hero: 100, villain: 30 };
  t.stacks = [100, 30];
  Object.assign(t, {
    nearBubble: false,
    inMoney: false,
    avgStackChips: 70,
    medianStackChips: 70,
    seatsPerTable: 2,
    currentLevel: 1,
    anteType: 'none',
    nextSmallBlind: 2,
    nextBigBlind: 4,
    nextAnte: 0,
    levelDurationMin: 10,
    levelElapsedMin: 5,
    registrationRequiresAuthorization: false,
    maxReentries: 0,
    maxRebuys: 0,
    addOnCost: null,
    addOnChips: null,
    addOnLevels: null,
    handForHand: false,
    handForHandExpected: false,
    bountyFactor: 0,
    mysteryChestsLeft: 0,
    mysteryMeanCents: 0,
    mysteryTopCents: 0,
    mysteryTopLive: false,
    meanBountyCents: 0,
    finalTable: true,
    nextBlindInMin: 5,
    nextBlindMult: 2,
    satelliteSeats: 0,
    bountyByUser: {},
  });
  t.m = buildTournamentMState({
    stackChips: r.player.stack,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    anteType: 'none',
    playersAtTable: 2,
    nextSmallBlind: 2,
    nextBigBlind: 4,
    nextAnte: 0,
    minutesToNextLevel: 5,
    opponentStacks: [{ userId: 'villain', stackChips: 0 }],
  });
  const p = t.contextProvenance!;
  p.readAtMs = now;
  p.source!.readStartedAtMs = now - 10;
  p.source!.readCompletedAtMs = now;
  const { contextProvenance, ...captured } = t;
  p.source!.contextDigest = createHash('sha256').update(JSON.stringify(captured)).digest('hex');
  r.decisionKey = buildHorseDecisionKey(r);
  return r;
}
function harness(selected = true) {
  const admitted = attachment(),
    messages: HorseDecisionWorkerResponse[] = [],
    records: any[] = [],
    holders = new Map<string, HorseQualifiedAuthorityHolder>();
  const deps: HorseDecisionWorkerDependencies = {
    ...defaultHorseDecisionWorkerDependencies,
    startServices: async () => defaultHorseDecisionWorkerDependencies.workerReadiness(),
    stopServices: async () => {},
    journalEnabled: () => true,
    journalDecision: (_r, b) => records.push(b),
    journalLifecycle: undefined,
    journalExecution: undefined,
    journalPlanReceipt: undefined,
    admitPhase8Authority: () => qualifiedTestAdmission(),
    admitPhase10Authority: undefined,
    admitPhase11Authority: undefined,
    admitPhase12Authority: undefined,
    admitPhase13Authority: undefined,
    admitPhase14Attachment: (domain) =>
      selected && domain === 'nlh-spin'
        ? admitted
        : {
            admission: { status: 'refused', reason: 'unselected', transient: false },
            catalog: null,
          },
    correctiveDraw: vi.fn(() => 0),
    noteFeature: () => {},
    noteDecision: () => {},
    observeCompletedHand: () => {},
  };
  const runtime = new HorseDecisionWorkerRuntime(
    (m) => messages.push(m),
    deps,
    undefined,
    (owner, domain, version, epoch) => {
      const h = new HorseQualifiedAuthorityHolder(
        epoch,
        owner === 'phase14' && domain === 'nlh-spin'
          ? TOURNAMENT_KERNEL_CATALOG_VERSION + '/nlh-spin'
          : version
      );
      holders.set(owner + ':' + (domain ?? ''), h);
      return h;
    }
  );
  return { runtime, messages, records, holders, deps, attachment: admitted };
}
async function runFast(h: ReturnType<typeof harness>, r = request()) {
  await h.runtime.start();
  h.runtime.receive(r);
  await h.runtime.drain();
  const result = h.messages.find((m) => m.type === 'FAST_RESULT');
  if (result?.type !== 'FAST_RESULT')
    throw Error(JSON.stringify(h.messages.filter((m) => m.type === 'ERROR')));
  return result;
}
describe('real worker tournament v2 and selected Phase8 dependency, local fixtures only', () => {
  it('executes actual FAST/DEEP v2 with retained FAST hashes and selected Phase8 baseline receipt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      r = request(),
      a = await runFast(h, r);
    expect(a.decision.correctivePolicy).toMatchObject({
      version: 'horse-corrective-live-kernel-v2',
      objective,
      utilityUnit,
      applied: true,
      baseline: { action: 'call', amount: 10 },
      selected: { action: 'fold', amount: 0 },
      baselineAuthorities: { phase8: { state: 'usable' } },
    });
    expect(correctiveKernelReceiptIsValid(a.decision)).toBe(true);
    expect(horseDecisionReceiptIsValid(a.decision)).toBe(true);
    h.runtime.receive({
      ...r,
      type: 'DECIDE_DEEP',
      requestId: 2,
      rngBefore: a.rngBefore,
      deepEquity: 2,
    });
    await h.runtime.drain();
    const d = h.messages.find((m) => m.type === 'DEEP_RESULT');
    if (d?.type !== 'DEEP_RESULT')
      throw Error(JSON.stringify(h.messages.filter((m) => m.type === 'ERROR')));
    expect(d.decision.correctivePolicy).toMatchObject({
      version: 'horse-corrective-live-kernel-v2',
      objective,
      utilityUnit,
      applied: true,
      inputDigest: evidenceDigest(h.records[0].snapshot),
      readFrameDigest: evidenceDigest(h.records[0].readFrame),
      tournamentContextDigest: evidenceDigest(r.gameState.tournament),
      baselineAuthorities: { phase8: { state: 'usable' } },
    });
    expect(correctiveKernelReceiptIsValid(d.decision)).toBe(true);
    expect(horseDecisionReceiptIsValid(d.decision)).toBe(true);
    expect(h.records).toHaveLength(2);
    expect(h.records[1].originalFastBinding).toEqual({
      inputDigest: evidenceDigest(h.records[0].snapshot),
      readFrameDigest: evidenceDigest(h.records[0].readFrame),
    });
  });
  it.each(['phase8:', 'phase14:nlh-spin'])(
    'withdrawal of selected %s prevents DEEP correction using the earlier original',
    async (owner) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const h = harness(),
        r = request(),
        a = await runFast(h, r);
      expect(a.decision.correctivePolicy?.applied).toBe(true);
      const holder = h.holders.get(owner);
      expect(holder).toBeDefined();
      if (!holder) throw Error('holder missing');
      holder.withdraw('test-local-withdrawal');
      h.runtime.receive({
        ...r,
        type: 'DECIDE_DEEP',
        requestId: 2,
        rngBefore: a.rngBefore,
        deepEquity: 2,
      });
      await h.runtime.drain();
      const d = h.messages.find((m) => m.type === 'DEEP_RESULT');
      if (d?.type !== 'DEEP_RESULT') throw Error('missing DEEP');
      expect(d.decision.correctivePolicy).toBeUndefined();
      expect(d.decision.action).toBe('call');
      expect(h.deps.correctiveDraw).toHaveBeenCalledTimes(1);
    }
  );
  it('feeds actual accepted DEEP v2 callback bytes through SQLite fleet without claiming unobserved horses', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const table = '10000000-0000-4000-8000-000000000001',
      hand = randomUUID();
    const horseIds = Array.from(
      { length: 1000 },
      (_, i) => `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`
    );
    const source = request();
    const id = (value: string) =>
      value === 'hero'
        ? horseIds[0]!
        : value === 'opponent' || value === 'villain'
          ? horseIds[1]!
          : value;
    source.player = { ...source.player, user_id: id(source.player.user_id) };
    source.gameState = {
      ...source.gameState,
      players: source.gameState.players.map((p) => ({ ...p, user_id: id(p.user_id) })),
      pots: source.gameState.pots?.map((pot) => ({
        ...pot,
        eligiblePlayers: pot.eligiblePlayers.map(id),
      })),
    };
    source.fence = `${table}:12:1:9:${source.generation}`;
    const t = source.gameState.tournament!,
      p = t.contextProvenance!;
    t.stackByUser = Object.fromEntries(
      Object.entries(t.stackByUser!).map(([user, funds]) => [
        id(user === 'villain' ? 'opponent' : user),
        funds,
      ])
    );
    p.projection.tableId = table;
    p.projection.handNumber = 12;
    p.projection.actorId = source.player.user_id;
    t.m = buildTournamentMState({
      stackChips: source.player.stack,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      anteType: 'none',
      playersAtTable: 2,
      nextSmallBlind: 2,
      nextBigBlind: 4,
      nextAnte: 0,
      minutesToNextLevel: 5,
      opponentStacks: source.gameState.players
        .filter((p) => p.user_id !== source.player.user_id)
        .map((p) => ({ userId: p.user_id, stackChips: p.stack })),
    });
    const { contextProvenance, ...capturedContext } = t;
    p.source!.contextDigest = createHash('sha256')
      .update(JSON.stringify(capturedContext))
      .digest('hex');

    const priorActions = source.gameState.actionHistory;
    if (!priorActions) throw Error('actual worker fixture requires its original action history');
    source.handJournalContext = captureHorseHandJournalContext(priorActions);
    source.decisionKey = buildHorseDecisionKey(source);
    const producerId = randomUUID(),
      sourceRelease = '1'.repeat(40),
      handKey = journalHash(`${table}:12:9`);
    const rows: HorseJournalRecord[] = [];
    const turn = (r: {
      generation: number;
      fence: string;
      requestId: number;
      decisionKey: string;
      decisionTimeMs: number;
    }) =>
      journalHash(
        JSON.stringify([r.generation, r.fence, r.requestId, r.decisionKey, r.decisionTimeMs])
      );
    const append = (kind: HorseJournalRecord['kind'], body: unknown, turnKey: string) =>
      rows.push(
        makeHorseJournalRecord(
          {
            producerId,
            sequence: rows.length + 1,
            atMs: now,
            sourceRelease,
            kind,
            handKey,
            turnKey,
          },
          body
        )
      );
    const h = harness(),
      journalDecision = h.deps.journalDecision;
    h.deps.journalLifecycle = (snapshot, payload) => {
      if (snapshot.type === 'DECIDE_DISCARD') throw Error('unexpected discard in FAST/DEEP test');
      append('request_lifecycle', payload, turn(snapshot));
    };
    h.deps.journalDecision = (snapshot, payload) => {
      journalDecision?.(snapshot, payload);
      append('decision', payload, turn(snapshot));
    };
    const fast = await runFast(h, source);
    const fastWitness = createHorseExecutionWitness(source, fast.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: fast.computeMs,
      governorScale: fast.governorScale,
    });
    retireHorseExecutionWitness(fastWitness, 'second_look_replaced');
    append('execution', fastWitness, turn(source));
    const deepRequest = {
      ...source,
      type: 'DECIDE_DEEP' as const,
      requestId: 2,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    };
    h.runtime.receive(deepRequest);
    await h.runtime.drain();
    const deep = h.messages.find((m) => m.type === 'DEEP_RESULT');
    if (deep?.type !== 'DEEP_RESULT') throw Error('actual DEEP producer did not return');
    expect(deep.decision.correctivePolicy).toMatchObject({
      version: 'horse-corrective-live-kernel-v2',
      objective,
      utilityUnit,
      baselineAuthorities: { phase8: { state: 'usable' } },
    });
    const witness = createHorseExecutionWitness(deepRequest, deep.decision, {
      requestId: 2,
      lane: 'deep',
      computeMs: deep.computeMs,
      governorScale: deep.governorScale,
    });
    const receipt = deep.decision.correctivePolicy!,
      authority = receipt.authority!;
    const mainGate = new HorsePhase8AuthorityGate(
      () => h.attachment.admission,
      undefined,
      TOURNAMENT_KERNEL_CATALOG_VERSION + '/nlh-spin'
    );
    mainGate.refresh();
    mainGate.observeWorker(authority);
    const verdict = mainGate.check(authority, now);
    expect(verdict).toBe('usable');
    recordHorsePhase14Verdict(witness, verdict);
    const baselineReceipt = receipt.baselineAuthorities!.phase8!;
    const baselineGate = new HorsePhase8AuthorityGate(() => qualifiedTestAdmission());
    baselineGate.refresh();
    baselineGate.observeWorker(baselineReceipt);
    expect(baselineGate.check(baselineReceipt, now)).toBe('usable');
    const acceptedAction = {
      seat: source.player.seat,
      userId: source.player.user_id,
      action: deep.decision.action,
      amount: deep.decision.amount ?? 0,
      stage: 'river' as const,
      timestamp: now,
    };
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [{ record: acceptedAction, intended: true }],
    });
    append('execution', witness, turn(deepRequest));
    const ordinal = priorActions.length;
    append(
      'accepted_hand',
      {
        type: 'OBSERVE_COMPLETED_HAND',
        requestId: 3,
        generation: 12,
        fence: `${table}:12:9:observe`,
        handKey: `${table}:12`,
        committedHandId: hand,
        bigBlind: source.gameState.bigBlind,
        actions: [
          ...priorActions,
          {
            ...acceptedAction,
            origin: 'horse_policy',
            publicNode: {
              version: 1,
              status: 'captured',
              actorSeat: source.player.seat,
              street: 'river',
            },
            observationIdentity: {
              version: 1,
              status: 'bound',
              handId: hand,
              actionOrdinal: ordinal,
              observationId: `${hand}:${ordinal}`,
              sessionKey: 'a'.repeat(64),
            },
          },
        ],
      },
      handKey
    );
    // These are the actual production callback bytes, serialized before any
    // consumer reads them. No original binding, replay flags or effects added.
    const deepRecord = rows.find(
      (r) => r.kind === 'decision' && JSON.parse(r.body).snapshot.type === 'DECIDE_DEEP'
    )!;
    const serializedDeep = JSON.parse(deepRecord.body);
    expect(serializedDeep.originalFastBinding).toEqual(
      JSON.parse(JSON.stringify(h.records[1])).originalFastBinding
    );
    const reconciliation = reconcileHorseJournalHand(rows, handKey);
    expect(reconciliation, JSON.stringify(reconciliation)).toMatchObject({
      status: 'reconciled',
      matchedActions: 1,
      retiredDecisions: 1,
      requestLifecycleVerified: true,
    });
    const directory = mkdtempSync(
      join(
        process.platform === 'darwin' ? resolve(process.cwd(), '../../tmp') : tmpdir(),
        'phase14-native-fleet-'
      )
    );
    try {
      const store = new HorseDecisionJournalStore(directory, {
        archive: runtimeHorseJournalArchiveOptions(directory, {}, { index: 0 }),
      });
      try {
        store.appendBatch(rows);
      } finally {
        store.close();
      }
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase14Attachment').mockReturnValue(h.attachment);
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue(
        qualifiedTestAdmission()
      );
      const result = readHorseJournalFleet(directory, {
        version: 1,
        sourceSha: sourceRelease,
        window: {
          startUtc: new Date(now - 1000).toISOString(),
          endUtc: new Date(now + 1000).toISOString(),
        },
        horseIds,
        handKeys: [handKey],
      });
      expect(result.gaps).toEqual({});
      expect(result.phaseEvidence.phase14).toMatchObject({
        qualification: { verified: 1 },
        application: { accepted: 1 },
      });
      const observed = result.horses.find((horse) => horse.horseId === horseIds[0]);
      expect(
        observed?.phaseStatusCounts.phase14?.[
          result.phaseProofSchema.statusOrder.indexOf('applicable-active')
        ]
      ).toBe(1);
      expect(result).toMatchObject({
        acceptedDecisions: 1,
        observedHorses: 1,
        unobservedHorses: 999,
        reconciledHands: 1,
        allPhasesVerified: false,
        completePopulation: false,
      });
      expect(result.horses.find((horse) => horse.horseId === horseIds[0])?.acceptedDecisions).toBe(
        1
      );
      expect(result.phaseEvidence.phase3).toMatchObject({
        application: { accepted: 1 },
        reasons: { original_accepted_hand_reconciled: 1 },
      });
      expect(result.phaseEvidence.phase5).toMatchObject({
        application: { accepted: 1 },
        reasons: { controller_accepted_action_bound: 1 },
      });
      vi.spyOn(qualifiedReplayAdmissions, 'admitPhase8Authority').mockReturnValue({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
      const staleBaseline = readHorseJournalFleet(directory, {
        version: 1,
        sourceSha: sourceRelease,
        window: {
          startUtc: new Date(now - 1000).toISOString(),
          endUtc: new Date(now + 1000).toISOString(),
        },
        horseIds,
        handKeys: [handKey],
      });
      expect(staleBaseline.phaseEvidence.phase14).toMatchObject({
        qualification: { unknown: 1 },
        application: { unknown: 1 },
        reasons: { protected_qualification_unavailable: 1 },
      });
      expect(
        staleBaseline.horses.find((horse) => horse.horseId === horseIds[0])?.phaseStatusCounts
          .phase14?.[staleBaseline.phaseProofSchema.statusOrder.indexOf('applicable-active')]
      ).toBe(0);
      for (const proof of Object.values(result.phaseEvidence))
        for (const reason of Object.keys(proof.reasons))
          expect(reason).not.toMatch(/^deep_(original_metadata|record_envelope|original_binding)/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('keeps missing original tournament capture unknown and only known nonriver geometry outside', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = harness(),
      r = request(),
      a = await runFast(h, r);
    const witness = createHorseExecutionWitness(r, a.decision, {
      requestId: 1,
      lane: 'fast',
      computeMs: a.computeMs,
      governorScale: a.governorScale,
    });
    settleHorseExecutionWitness(witness, {
      applied: true,
      acceptedActions: [
        {
          intended: true,
          record: {
            seat: r.player.seat,
            userId: r.player.user_id,
            action: a.decision.action,
            amount: a.decision.amount ?? 0,
            stage: 'river',
          },
        },
      ],
    });
    const capture = structuredClone(h.records[0]);
    delete capture.snapshot.gameState.tournament.finalizedPrizeLadder;
    const plans = {
      version: 1,
      scope: 'single_retained_hand',
      acceptedHandRetained: true,
      issued: 0,
      accepted: 0,
      durable: 0,
      applied: 0,
      failed: 0,
      unknown: 0,
      gaps: [] as never[],
      applicationVerified: false,
      replayVerified: false,
      completePopulation: false,
      activationAllowed: false,
    } as const;
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(capture, witness, plans).phase14
    ).toMatchObject({ status: 'unknown', reason: 'corrective_original_metadata_unavailable' });
    const excluded = structuredClone(h.records[0]);
    excluded.snapshot.gameState.stage = 'turn';
    expect(
      new HorseFleetPhaseInterpreter(() => {}).interpret(excluded, witness, plans).phase14.status
    ).toBe('outside-domain');
  });
});
