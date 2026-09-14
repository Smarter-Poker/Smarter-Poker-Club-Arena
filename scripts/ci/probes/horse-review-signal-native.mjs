/** Offline compiled policy + actual worker-thread proof; never starts DB services. */
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const compiled = (name) => import(pathToFileURL(`${root}/server/dist/${name}.js`));

if (!isMainThread) {
  // Imports may construct clients; any attempted network use fails this proof.
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error('offline proof attempted network');
  };
  const { HorseDecisionWorkerRuntime, defaultHorseDecisionWorkerDependencies: defaults } =
    await compiled('engine/horseDecision/workerRuntime');
  const { HorseMind } = await compiled('engine/HorseMind');
  const { seedFastRandom, saveFastRandom } = await compiled('engine/HorseEval');
  const runtime = new HorseDecisionWorkerRuntime(
    (message) => {
      parentPort.postMessage({ ...message, outerRng: saveFastRandom(), networkAttempts });
      if (message.type === 'STOPPED') parentPort.close();
    },
    {
      ...defaults,
      // Exercise actual validation, RNG, HorseLogic and effect capture. Persistence
      // hydration/flush are deliberately absent; this is not production qualification.
      startServices: async () => defaults.workerReadiness(),
      stopServices: async () => {},
    }
  );
  parentPort.on('message', (message) => {
    HorseMind.reset();
    seedFastRandom(workerData.outerSeed);
    runtime.receive(message);
  });
  await runtime.start();
} else {
  const { jointPolicyFixture } = await compiled('engine/multiway/JointRangeFixture.test-support');
  const { buildHorseDecisionKey, validatedHorsePolicySamplingKey } = await compiled(
    'engine/horseDecision/protocol'
  );
  const { resolveHorseStyle } = await compiled('engine/HorseLogic');
  const { buildTournamentMState } = await compiled('engine/HorseTournamentPreflop');
  const signals = {
    leaks: { coldcall_stackoff: 50, limped_pot_bloat: 20, river_raise_war: 20 },
    leaksHands: 100,
    leaksOmaha: { plo_naked_trips_stackoff: 50 },
    leaksHandsOmaha: 100,
    leaksHoldem: { top_pair_weak_kicker_stackoff: 50, limped_pot_bloat: 20, river_raise_war: 20 },
    leaksHandsHoldem: 100,
    leaksTournament: { preflop_stackoff: 50 },
    leaksHandsTournament: 100,
  };
  const authored = resolveHorseStyle(
    { style: 'balanced', aggression: 1.1, sizingMultiplier: 0.9 },
    'p0'
  );
  const rows = [];
  const timings = [];
  let childrenStopped = 0;
  let requestId = 0;
  let comparisons = 0;
  for (let pass = 0; pass < 2; pass++) {
    const outerSeed = pass ? 4_000_000_001 : 101;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { outerSeed },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    let pending;
    let ready;
    let readyTimer;
    const started = new Promise((resolve, reject) => {
      ready = { resolve, reject };
      readyTimer = setTimeout(() => reject(new Error('worker readiness timeout')), 20_000);
    });
    const exit = new Promise((resolve) => worker.once('exit', resolve));
    worker.on('error', (error) => {
      ready.reject(error);
      pending?.reject(error);
    });
    worker.on('message', (message) => {
      if (message.type === 'READY') {
        clearTimeout(readyTimer);
        ready.resolve();
        return;
      }
      if (pending) {
        clearTimeout(pending.timer);
        const waiter = pending;
        pending = undefined;
        waiter.resolve(message);
      }
    });
    const send = async (message) => {
      assert.equal(pending, undefined);
      return new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(
            () => reject(new Error(`request timeout ${message.requestId}`)),
            20_000
          ),
        };
        worker.postMessage(message);
      });
    };
    try {
      await started;
      let index = 0;
      for (const variant of [
        'nlh',
        'plo4',
        'plo5',
        'plo6',
        'plo8',
        'flo8',
        'flh',
        'pineapple',
        'short_deck',
      ]) {
        for (const street of ['preflop', 'flop', 'turn', 'river']) {
          for (const boardCount of [1, 2, 3]) {
            for (const mode of ['cash', 'tournament']) {
              const fixture = jointPolicyFixture(variant, boardCount, mode, street);
              if (mode === 'tournament') {
                // The policy helper has partial tournament facts; the real worker
                // requires the entire authoritative contract, including orbit M.
                const state = fixture.state;
                Object.assign(state.tournament, {
                  sourceAgeMs: 0,
                  tournamentId: 'offline-review-proof',
                  tournamentType: 'MTT',
                  tournamentStatus: 'RUNNING',
                  entrants: 4,
                  nearBubble: false,
                  inMoney: false,
                  avgStackChips: 105,
                  medianStackChips: 105,
                  seatsPerTable: 4,
                  playersAtTable: 4,
                  currentLevel: 0,
                  nextSmallBlind: 2,
                  nextBigBlind: 4,
                  nextAnte: 0,
                  levelDurationMin: 10,
                  levelElapsedMin: 5,
                  nextBlindInMin: 5,
                  nextBlindMult: 2,
                  registrationOpen: false,
                  lateRegistrationOpen: false,
                  registrationRequiresAuthorization: false,
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
                  finalTable: true,
                  satellite: false,
                  satelliteSeats: 0,
                  bountyByUser: {},
                  m: buildTournamentMState({
                    stackChips: fixture.hero.stack,
                    smallBlind: 1,
                    bigBlind: 2,
                    ante: 0,
                    anteType: 'none',
                    playersAtTable: 4,
                    nextSmallBlind: 2,
                    nextBigBlind: 4,
                    nextAnte: 0,
                    minutesToNextLevel: 5,
                    opponentStacks: state.players
                      .filter((p) => p.user_id !== fixture.hero.user_id && !p.is_sitting_out)
                      .map((p) => ({ userId: p.user_id, stackChips: p.stack })),
                  }),
                });
              }
              const input = {
                generation: 4,
                fence: `review:${index}`,
                decisionTimeMs: 3_599_999,
                player: fixture.hero,
                gameState: fixture.state,
                style: authored.style,
                mods: authored.mods,
                opts: { mind: false },
              };
              const decisions = [];
              const outputs = [];
              for (const change of [
                {},
                { mods: { ...authored.mods, ...signals } },
                { mods: { ...authored.mods, ...signals }, opts: { mind: false, v41Leaks: false } },
              ]) {
                const request = {
                  ...input,
                  ...change,
                  type: 'DECIDE_FAST',
                  requestId: ++requestId,
                };
                request.decisionKey = buildHorseDecisionKey(request);
                const result = await send(request);
                assert.equal(result.type, 'FAST_RESULT', JSON.stringify(result));
                assert.equal(result.networkAttempts, 0);
                assert.equal(result.outerRng, outerSeed);
                timings.push(result.computeMs);
                // Real elapsed-time diagnostics are intentionally excluded; actual
                // actions, amounts, think times, RNG and deferred effects are compared.
                outputs.push({
                  action: result.decision.action,
                  amount: result.decision.amount ?? null,
                  thinkTime: result.decision.thinkTime,
                  rngBefore: result.rngBefore,
                  rngAfter: result.rngAfter,
                  effects: result.effects,
                });
                decisions.push({ request, result });
              }
              assert.notEqual(decisions[0].request.decisionKey, decisions[1].request.decisionKey);
              assert.equal(
                validatedHorsePolicySamplingKey(decisions[0].request),
                validatedHorsePolicySamplingKey(decisions[1].request)
              );
              assert.deepEqual(
                outputs[1],
                outputs[0],
                `${variant}/${street}/${boardCount}/${mode}: reports`
              );
              assert.deepEqual(
                outputs[2],
                outputs[0],
                `${variant}/${street}/${boardCount}/${mode}: switch`
              );
              if (pass) assert.deepEqual(outputs[0], rows[index].output, `restart ${index}`);
              else rows.push({ variant, street, boardCount, mode, output: outputs[0] });
              comparisons += 2 + pass;
              index++;
            }
          }
        }
        console.error(JSON.stringify({ pass, variant, cases: index }));
      }
      const stopped = await send({ type: 'SHUTDOWN' });
      assert.equal(stopped.type, 'STOPPED');
      // Confirm termination after the stop receipt, as the live owner does.
      // Imported stores can retain timers even with persistence startup absent.
      const code = await worker.terminate();
      assert.equal(await exit, code);
      childrenStopped++;
    } finally {
      clearTimeout(readyTimer);
      if (pending) clearTimeout(pending.timer);
      await worker.terminate();
    }
  }
  timings.sort((a, b) => a - b);
  const result = {
    scope:
      'offline compiled HorseLogic and actual worker threads; no persistence hydration or production qualification',
    cases: rows.length,
    passes: 2,
    comparisons,
    decisions: requestId,
    childrenStopped,
    networkAttempts: 0,
    elapsedMs: {
      p50: timings[Math.floor(timings.length * 0.5)],
      p99: timings[Math.floor(timings.length * 0.99)],
      max: timings.at(-1),
    },
    digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    rows,
  };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, rows: undefined }));
  // Parent-side imported policy modules also own timers. All child termination
  // has been confirmed above; this deliberately bounded offline probe now exits.
  process.exit(0);
}
