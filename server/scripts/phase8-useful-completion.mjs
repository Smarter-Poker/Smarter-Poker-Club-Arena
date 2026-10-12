#!/usr/bin/env node
/**
 * P8.1 USEFUL-COMPLETION DIAGNOSTIC (Horse Brain Phase 8, 2026-10-01)
 *
 * Runs a frozen population of NLH tournament postflop decisions through the
 * COMPILED live decision worker runtime (dist/engine/horseDecision/
 * workerRuntime.js, the class production's worker thread runs) and reports,
 * per decision, whether Phase 8 was eligible, fired and completed, the NAMED
 * final-gate refusal when it did not complete, and its work and wall timings.
 *
 *   npm run build   (tsc -> dist; the diagnostic never runs TypeScript source)
 *   node scripts/phase8-useful-completion.mjs build --out=<population.json>
 *   node scripts/phase8-useful-completion.mjs run --population=<population.json> --pass=cold --out=<result.json>
 *   node scripts/phase8-useful-completion.mjs run --population=<population.json> --pass=warm --out=<result.json>
 *   node scripts/phase8-useful-completion.mjs digest --population=<population.json> --out=<digest.json>
 *   node scripts/phase8-useful-completion.mjs compare --population=<population.json> --a=dist-before --b=dist --reps=5 --out=<compare.json>
 *
 * Fixed inputs: the population file is frozen and hashed (sha256 over its
 * canonical request list); the run refuses a population whose hash does not
 * match. The worker derives each decision's RNG from the request itself, the
 * equity governor is pinned to the declared scale 1 (no load scaling), and the
 * decisions run in population order, one per event-loop turn, through the
 * runtime's own envelope validation. Nothing here touches a network, database,
 * journal or plan effect; no limit is changed: PHASE8_POLICY's 4 ms work, 5 ms
 * wall and 2 ms policy limits and the existing sample/trial counts are read
 * from the compiled source and recorded in the result.
 *
 * cold: a fresh process; each decision runs once, in order, immediately after
 *       worker readiness (the fixed card preparation runs before readiness,
 *       exactly as in production).
 * warm: a fresh process; the whole population runs once unrecorded, then the
 *       measured pass runs the same requests again in the same process.
 *
 * The process-wide Phase 8 safety latch is production's and stays live. A
 * decision refused because the latch had already tripped is reported under
 * its own name (`disabled_<reason>`), never folded into a computation result.
 * Timings are this machine's; they are not fleet latency.
 *
 * compare: loads two compiled trees into ONE process and runs every decision
 * through each tree's HorseLogic.decide with the clock frozen at 0 (full
 * work, no deadline), alternating A-B-B-A per decision and repetition, and
 * times each call with process.hrtime (not the frozen clock). Pairing within
 * one process and one decision cancels slow host contention that a separate
 * cold/warm process run cannot; it measures work demand, not completion.
 *
 * digest: runs the same population through HorseLogic.decide with the clock
 * frozen at 0 (no deadline can stop work) and prints a per-decision digest of
 * the complete decision, utility and continuation receipts. Two source trees
 * with equal digests produce identical selected actions, distributions, sample
 * orders and receipts for the population (the equivalence proof for any
 * optimization of the continuation path).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Offline only (the phase6c-replay pattern): the imported modules construct a
// Supabase client at load time, so they get an address that resolves to
// nothing and a key that is not one. No loader, journal or store refresh
// starts. The equity governor is fixed before any engine module loads.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase8-useful-completion-offline-placeholder';
process.env.EQUITY_GOVERNOR = 'off';
delete process.env.HORSE_DECISION_JOURNAL_DIR;

const here = path.dirname(fileURLToPath(import.meta.url));
// P81_DIST selects another compiled tree (the before/after comparison).
const dist = path.resolve(here, '..', process.env.P81_DIST ?? 'dist');
const load = (p) => import(path.join(dist, p));

const POPULATION_SCHEMA = 'horse-phase8-useful-completion-population-v1';
const RESULT_SCHEMA = 'horse-phase8-useful-completion-result-v1';
const LEAGUE_SEED = 8101101;
const LEAGUE_PAIRS = Number(process.env.P81_LEAGUE_PAIRS ?? 4);
const DECISION_TIME_MS = 1_790_000_000_000;
const GOVERNOR_SCALE = 1;

function args() {
  const [mode, ...rest] = process.argv.slice(2);
  const out = { mode };
  for (const a of rest) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`unrecognized argument ${a}`);
    out[m[1]] = m[2];
  }
  return out;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, canonical(v[k])])
        )
      : v;
const populationHash = (requests) => sha256(JSON.stringify(canonical(requests)));

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
}

/** Complete a fixture/league tournament state into the live worker contract.
 * Every value Phase 7/8 already read is kept; only absent descriptive fields
 * receive the declared neutral value below. */
async function workerSnapshot(hero, gs, index, source) {
  const { buildTournamentMState } = await load('engine/HorseTournamentPreflop.js');
  const { buildHorseDecisionKey } = await load('engine/horseDecision/protocol.js');
  const { calculateContestablePot } = await load('engine/PokerEngine.js');
  const t = gs.tournament;
  const stacks = (t.stacks ?? []).slice();
  const sorted = stacks.slice().sort((a, b) => a - b);
  const avg = stacks.length ? stacks.reduce((s, x) => s + x, 0) / stacks.length : 0;
  const ante = gs.ante ?? t.currentAnte ?? 0;
  // The live contract derives anteType from the hand's ante and the next
  // level's ante (assertPhase6TournamentSnapshot). The league schedule labels a
  // zero current ante 'none' even when its declared next level has an ante.
  const anteType =
    gs.bigBlindAnte === true
      ? 'big_blind'
      : ante > 0 || (t.nextAnte ?? 0) > 0
        ? 'per_player'
        : 'none';
  const opponents = gs.players
    .filter((p) => p.user_id !== hero.user_id)
    .map((p) => ({ userId: p.user_id, stackChips: p.stack }));
  const tournament = {
    sourceAgeMs: 0,
    tournamentId: `phase8-p81-${source}`,
    tournamentType: gs.format === 'spin' ? 'SPIN' : gs.format === 'sng' ? 'SNG' : 'MTT',
    tournamentStatus: 'RUNNING',
    gameVariant: 'nlh',
    entrants: t.playersLeft,
    nearBubble: false,
    inMoney: false,
    avgStackChips: Math.round(avg),
    medianStackChips: Math.round(median(sorted)),
    seatsPerTable: Math.max(2, Math.min(10, t.seatsPerTable ?? gs.players.length)),
    currentLevel: t.currentLevel ?? 1,
    levelDurationMin: t.levelDurationMin ?? 10,
    levelElapsedMin: t.levelElapsedMin ?? 0,
    registrationOpen: false,
    lateRegistrationOpen: false,
    registrationRequiresAuthorization: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    reentryAllowed: false,
    rebuyAllowed: false,
    addOnAvailable: false,
    addOnCost: null,
    addOnChips: null,
    addOnLevels: null,
    onBreak: false,
    handForHand: false,
    handForHandExpected: false,
    bountyFactor: 0,
    mysteryChestsLeft: 0,
    mysteryMeanCents: 0,
    mysteryTopCents: 0,
    mysteryTopLive: false,
    meanBountyCents: 0,
    finalTable: false,
    nextBlindMult: 2,
    satellite: false,
    satelliteSeats: 0,
    bountyByUser: {},
    maxReentries: 0,
    maxRebuys: 0,
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    ...t,
    anteType,
    currentAnte: ante,
    playersAtTable: Math.max(2, gs.players.length),
  };
  tournament.m = buildTournamentMState({
    stackChips: hero.stack,
    smallBlind: tournament.currentSmallBlind,
    bigBlind: tournament.currentBigBlind,
    ante,
    anteType,
    playersAtTable: tournament.playersAtTable,
    nextSmallBlind: tournament.nextSmallBlind,
    nextBigBlind: tournament.nextBigBlind,
    nextAnte: tournament.nextAnte,
    minutesToNextLevel: tournament.nextBlindInMin,
    opponentStacks: opponents,
  });
  // Live canonical snapshot contract (workerRuntime.assertCanonicalDecisionSnapshot):
  // toCall is currentBet minus hero's street bet, fold is always offered, and
  // no-limit states carry explicit null fixed-limit fields. The four replay
  // reconstructions cap toCall at hero's stack and omit fold when checking;
  // they are normalized here and nowhere else.
  const toCall = Math.round(Math.max(0, gs.currentBet - hero.bet) * 100) / 100;
  const legalActions = gs.legalActions.includes('fold')
    ? gs.legalActions.slice()
    : ['fold', ...gs.legalActions];
  const gameState = {
    ...gs,
    ante,
    boardCount: 1,
    toCall,
    legalActions,
    fixedBetSize: gs.fixedBetSize ?? null,
    wagersCapped: gs.wagersCapped ?? false,
    commitmentCapRemaining: gs.commitmentCapRemaining ?? null,
    rakeConfig: gs.rakeConfig ?? { percent: 0, cap: 0, noFlopNoDrop: true },
    contestablePot: calculateContestablePot(gs.players, hero.user_id, toCall),
    tournament,
  };
  const request = {
    type: 'DECIDE_FAST',
    requestId: index + 1,
    generation: 1,
    fence: `phase8-p81:${index}:${hero.seat}:${gs.stage}`,
    decisionKey: '',
    decisionTimeMs: DECISION_TIME_MS,
    player: hero,
    gameState,
    style: 'balanced',
    mods: {},
    opts: { mind: false },
  };
  request.decisionKey = buildHorseDecisionKey(request);
  return request;
}

async function buildPopulation(outPath, opts) {
  const { HorseLogic } = await load('engine/HorseLogic.js');
  const { reconstructPhase8Hand } = await load('engine/HorsePhase8ReplayFixture.js');
  const { runTournamentLeague, TOURNAMENT_LEAGUE_OBJECTIVES } = await load(
    'benchmark/HorseTournamentLeague.js'
  );
  const fixturePath = path.resolve(here, '../src/engine/fixtures/phase8-production-hands.json');
  const fixtureText = readFileSync(fixturePath, 'utf8');
  const members = [];
  for (const hand of JSON.parse(fixtureText)) {
    const { hero, gs } = reconstructPhase8Hand(hand);
    members.push({ source: `replay_${hand.reviewId}`, hero, gs });
  }
  // Maintained league fixtures: the hero's own shadow-mode postflop decisions
  // in LEAGUE_PAIRS seeded paired tournaments per declared objective (the hero rotates by pair) (play unchanged).
  const objectives = opts.objectives
    ? opts.objectives.split(',')
    : [...TOURNAMENT_LEAGUE_OBJECTIVES];
  const decide = HorseLogic.decide;
  let capture = null;
  HorseLogic.decide = function (hero, gs, style, mods, opts) {
    if (
      capture &&
      opts?.phase8Postflop &&
      opts.phase8Postflop !== 'off' &&
      ['flop', 'turn', 'river'].includes(gs.stage)
    )
      capture.push({ hero: structuredClone(hero), gs: structuredClone(gs) });
    return decide.call(this, hero, gs, style, mods, opts);
  };
  try {
    for (const objective of objectives) {
      capture = [];
      const result = await runTournamentLeague({
        objective,
        pairs: LEAGUE_PAIRS,
        seed: LEAGUE_SEED,
        candidateMode: 'shadow',
      });
      if (!result.complete || result.illegalActions || result.conservationErrors)
        throw new Error(`league fixture ${objective} did not complete cleanly`);
      for (const m of capture) members.push({ source: `league_${objective}`, ...m });
      console.error(`league ${objective}: ${capture.length} hero postflop decisions`);
    }
  } finally {
    HorseLogic.decide = decide;
    capture = null;
  }
  const requests = [];
  const seen = new Set();
  const sources = [];
  for (const m of members) {
    const request = await workerSnapshot(m.hero, m.gs, requests.length, m.source);
    if (seen.has(request.decisionKey)) continue;
    seen.add(request.decisionKey);
    requests.push(request);
    sources.push(m.source);
  }
  const population = {
    schema: POPULATION_SCHEMA,
    builtAt: new Date().toISOString(),
    command: `node scripts/phase8-useful-completion.mjs build --out=${path.basename(outPath)}`,
    sources: {
      replayFixture: {
        path: 'server/src/engine/fixtures/phase8-production-hands.json',
        sha256: sha256(fixtureText),
        note: 'four captured production public lines; field explicitly reconstructed',
      },
      league: {
        owner: 'server/src/benchmark/HorseTournamentLeague.ts::runTournamentLeague',
        seed: LEAGUE_SEED,
        pairs: LEAGUE_PAIRS,
        candidateMode: 'shadow',
        objectives,
      },
    },
    declared: {
      decisionTimeMs: DECISION_TIME_MS,
      governorScale: GOVERNOR_SCALE,
      opts: { mind: false },
      completedFields:
        'absent descriptive Phase 6 context fields receive neutral declared values; every value the league or fixture supplied is kept',
    },
    count: requests.length,
    bySource: sources.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}),
    requestSources: sources,
    sha256: populationHash(requests),
    requests,
  };
  writeFileSync(outPath, JSON.stringify(population));
  console.log(
    JSON.stringify({
      count: population.count,
      sha256: population.sha256,
      bySource: population.bySource,
    })
  );
}

function readPopulation(p) {
  const population = JSON.parse(readFileSync(p, 'utf8'));
  if (population.schema !== POPULATION_SCHEMA) throw new Error('unknown population schema');
  const actual = populationHash(population.requests);
  if (actual !== population.sha256)
    throw new Error(`population hash mismatch: manifest ${population.sha256}, actual ${actual}`);
  return population;
}

async function makeRuntime() {
  const { HorseDecisionWorkerRuntime } = await load('engine/horseDecision/workerRuntime.js');
  const { HorseLogic } = await load('engine/HorseLogic.js');
  const { HorseMind } = await load('engine/HorseMind.js');
  const { equityGovernor } = await load('engine/EquityLoadGovernor.js');
  const { saveFastRandom, restoreFastRandom } = await load('engine/HorseEval.js');
  const { enableBrainTelemetry, drainFires } = await load('engine/BrainTelemetry.js');
  const { prepareTournamentFutureHandFacts } = await load('engine/HorseTournamentFutureHand.js');
  const { liveHorsePhase8Safety } = await load('engine/HorsePhase8Safety.js');
  const messages = [];
  let preparationMs = 0;
  const deps = {
    journalEnabled: () => false,
    async startServices() {
      const t0 = performance.now();
      prepareTournamentFutureHandFacts();
      preparationMs = performance.now() - t0;
      return {
        solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
        solverStoreIdentity: null,
        solverPolicyArtifact: null,
        governor: equityGovernor.snapshot(),
      };
    },
    async stopServices() {},
    decide: HorseLogic.decide.bind(HorseLogic),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: () => {
      throw new Error('the diagnostic never applies plan effects');
    },
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    atGovernorScale: (fn) => equityGovernor.withDecisionScale(fn),
    workerReadiness: () => ({
      solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
      solverStoreIdentity: null,
      solverPolicyArtifact: null,
      governor: equityGovernor.snapshot(),
    }),
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: () => {},
    now: () => performance.now(),
  };
  enableBrainTelemetry();
  equityGovernor.__setScaleForTest(GOVERNOR_SCALE);
  const runtime = new HorseDecisionWorkerRuntime((m) => messages.push(m), deps);
  await runtime.start();
  return {
    runtime,
    messages,
    drainFires,
    safety: liveHorsePhase8Safety,
    preparationMs: () => preparationMs,
  };
}

async function runPass(env, requests, requestIdBase) {
  const rows = [];
  for (let i = 0; i < requests.length; i++) {
    const request = { ...requests[i], requestId: requestIdBase + i + 1 };
    const before = env.messages.length;
    const latchBefore = env.safety.disabledReason;
    const t0 = performance.now();
    env.runtime.receive(request);
    await env.runtime.drain();
    const workerWallMs = performance.now() - t0;
    const reply = env.messages.slice(before).find((m) => m.requestId === request.requestId);
    if (!reply || reply.type !== 'FAST_RESULT') {
      rows.push({ index: i, error: reply?.message ?? 'no worker reply', workerWallMs });
      continue;
    }
    const l = reply.decision.tournamentPostflop;
    rows.push({
      index: i,
      street: request.gameState.stage,
      format: request.gameState.format,
      localPlayers: request.gameState.players.length,
      fieldPlayers: request.gameState.tournament.playersLeft,
      action: reply.decision.action,
      layer: Boolean(l),
      eligible: Boolean(l?.eligible),
      fired: Boolean(l?.fired),
      completed: Boolean(l?.completed),
      changed: Boolean(l?.changed),
      reason: l?.reason ?? 'no_phase8_receipt',
      latchBefore,
      latchAfter: env.safety.disabledReason,
      latencyMs: l?.latencyMs ?? null,
      simulationMs: l?.simulationMs ?? null,
      policyMs: l?.policyMs ?? null,
      work: l?.work ?? null,
      workerWallMs,
    });
  }
  return rows;
}

function quantiles(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null);
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.at(-1) ?? null };
}

function summarize(rows) {
  const refusals = {};
  const eligibleRefusals = {};
  const firedRefusals = {};
  let eligible = 0;
  let fired = 0;
  let completed = 0;
  let changed = 0;
  let errors = 0;
  for (const r of rows) {
    if (r.error) {
      errors++;
      continue;
    }
    eligible += Number(r.eligible);
    fired += Number(r.fired);
    completed += Number(r.completed);
    changed += Number(r.changed);
    if (!r.completed) refusals[r.reason] = (refusals[r.reason] ?? 0) + 1;
    if (r.eligible && !r.completed)
      eligibleRefusals[r.reason] = (eligibleRefusals[r.reason] ?? 0) + 1;
    if (r.fired && !r.completed) firedRefusals[r.reason] = (firedRefusals[r.reason] ?? 0) + 1;
  }
  const el = rows.filter((r) => r.eligible);
  return {
    decisions: rows.length,
    workerErrors: errors,
    eligible,
    fired,
    completed,
    changedInShadow: changed,
    refusalsAll: refusals,
    refusalsAmongEligible: eligibleRefusals,
    finalGateRefusalsAmongFired: firedRefusals,
    latchTrippedAt: rows.findIndex((r) => r.latchAfter && !r.latchBefore),
    latchReason: rows.at(-1)?.latchAfter ?? null,
    eligibleLatencyMs: quantiles(el.map((r) => r.latencyMs)),
    eligibleSimulationMs: quantiles(el.map((r) => r.simulationMs)),
    eligiblePolicyMs: quantiles(el.map((r) => r.policyMs)),
    eligibleWorkerWallMs: quantiles(el.map((r) => r.workerWallMs)),
    budgetStops: el.reduce((a, r) => {
      const k = r.work?.budgetStop ?? 'none';
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {}),
  };
}

async function run(opts) {
  const population = readPopulation(opts.population);
  const pass = opts.pass;
  if (!['cold', 'warm'].includes(pass)) throw new Error('--pass must be cold or warm');
  const { PHASE8_POLICY } = await load('engine/HorseTournamentPostflop.js');
  const { CONTINUATION_POLICY } = await load('engine/HorseTournamentContinuation.js');
  const { FUTURE_HAND_POLICY } = await load('engine/HorseTournamentFutureHand.js');
  const loadStart = os.loadavg();
  const env = await makeRuntime();
  let warmup = null;
  if (pass === 'warm') warmup = summarize(await runPass(env, population.requests, 0));
  const rows = await runPass(env, population.requests, population.requests.length * 2);
  const result = {
    schema: RESULT_SCHEMA,
    pass,
    command: `node scripts/phase8-useful-completion.mjs run --population=${path.basename(opts.population)} --pass=${pass} --out=${path.basename(opts.out)}`,
    sourceRevision: opts.revision ?? null,
    populationSha256: population.sha256,
    populationCount: population.count,
    machine: {
      note: 'local development Mac; not fleet latency',
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      node: process.version,
      loadAverage: { start: loadStart, end: os.loadavg() },
    },
    limits: {
      phase8: PHASE8_POLICY,
      continuation: CONTINUATION_POLICY,
      futureHand: FUTURE_HAND_POLICY,
      governorScale: GOVERNOR_SCALE,
    },
    preparationMs: env.preparationMs(),
    warmup,
    summary: summarize(rows),
    rows: rows.map((r) => ({ ...r, source: population.requestSources[r.index] })),
  };
  await env.runtime.receive({ type: 'SHUTDOWN', requestId: 0, generation: 0, fence: 'end' });
  writeFileSync(opts.out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ pass, ...result.summary }));
}

async function digest(opts) {
  const population = readPopulation(opts.population);
  const { digestPhase8UsefulCompletion, PHASE8_USEFUL_COMPLETION_DIGEST_SCHEMA } = await load(
    'engine/HorsePhase8UsefulCompletion.js'
  );
  const realNow = performance.now;
  performance.now = () => 0;
  let digested;
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  try {
    digested = digestPhase8UsefulCompletion(population.requests);
  } finally {
    performance.now = realNow;
  }
  const workWallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const workCpuUserMs = process.cpuUsage(cpu0).user / 1000;
  const result = {
    schema: PHASE8_USEFUL_COMPLETION_DIGEST_SCHEMA,
    sourceRevision: opts.revision ?? null,
    populationSha256: population.sha256,
    clock: 'frozen_at_zero',
    sha256: digested.sha256,
    rows: digested.rows,
  };
  if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 1));
  console.log(
    JSON.stringify({
      count: digested.rows.length,
      sha256: digested.sha256,
      workWallMs,
      workCpuUserMs,
      loadAverage: os.loadavg()[0],
    })
  );
}

async function compare(opts) {
  const population = readPopulation(opts.population);
  const reps = Number(opts.reps ?? 5);
  const trees = {};
  for (const side of ['a', 'b']) {
    const root = path.resolve(here, '..', opts[side]);
    const m = await import(path.join(root, 'engine/HorsePhase8UsefulCompletion.js'));
    const { prepareTournamentFutureHandFacts } = await import(
      path.join(root, 'engine/HorseTournamentFutureHand.js')
    );
    prepareTournamentFutureHandFacts();
    trees[side] = m;
  }
  const realNow = performance.now;
  performance.now = () => 0;
  const n = population.requests.length;
  const times = { a: Array.from({ length: n }, () => []), b: Array.from({ length: n }, () => []) };
  const digests = { a: new Array(n), b: new Array(n) };
  const loadStart = os.loadavg();
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (let i = 0; i < n; i++) {
        const order = (rep + i) % 2 === 0 ? ['a', 'b', 'b', 'a'] : ['b', 'a', 'a', 'b'];
        for (const side of order) {
          const t0 = process.hrtime.bigint();
          const d = trees[side].digestPhase8UsefulCompletion([population.requests[i]]);
          times[side][i].push(Number(process.hrtime.bigint() - t0) / 1e6);
          digests[side][i] = d.rows[0].sha256;
        }
      }
    }
  } finally {
    performance.now = realNow;
  }
  const med = (xs) => {
    const s = xs.slice().sort((x, y) => x - y);
    return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
  };
  const rows = times.a.map((ta, i) => ({
    index: i,
    medianMsA: med(ta),
    medianMsB: med(times.b[i]),
    sameDigest: digests.a[i] === digests.b[i],
  }));
  const sumA = rows.reduce((s, r) => s + r.medianMsA, 0);
  const sumB = rows.reduce((s, r) => s + r.medianMsB, 0);
  const result = {
    schema: 'horse-phase8-useful-completion-compare-v1',
    command: `node scripts/phase8-useful-completion.mjs compare --population=${path.basename(opts.population)} --a=${opts.a} --b=${opts.b} --reps=${reps}`,
    populationSha256: population.sha256,
    a: opts.a,
    b: opts.b,
    reps,
    callsPerSide: n * reps * 2,
    measure: 'HorseLogic.decide full work (clock frozen at 0), median per decision, process.hrtime',
    loadAverage: { start: loadStart, end: os.loadavg() },
    identicalDigests: rows.filter((r) => r.sameDigest).length,
    sumOfMediansMsA: sumA,
    sumOfMediansMsB: sumB,
    decisionsFasterInB: rows.filter((r) => r.medianMsB < r.medianMsA).length,
    rows,
  };
  if (opts.out) writeFileSync(opts.out, JSON.stringify(result, null, 1));
  const { rows: _r, ...summary } = result;
  console.log(JSON.stringify(summary));
}

const opts = args();
if (opts.mode === 'build') await buildPopulation(opts.out, opts);
else if (opts.mode === 'run') await run(opts);
else if (opts.mode === 'digest') await digest(opts);
else if (opts.mode === 'compare') await compare(opts);
else throw new Error('mode must be build, run, digest or compare');
process.exit(0);
