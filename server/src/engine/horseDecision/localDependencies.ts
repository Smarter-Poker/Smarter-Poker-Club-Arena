/**
 * Production LOCAL authority bindings. Only worker.ts loads this module.
 * The generic runtime and local lifecycle composer never import this graph.
 * Supabase, persisted mind and additive telemetry remain owned by this lane.
 */
import { performance } from 'node:perf_hooks';

import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { restoreFastRandom, saveFastRandom } from '../HorseEval.js';
import { equityGovernor } from '../EquityLoadGovernor.js';
import { noteDecisionMs, noteFire } from '../BrainTelemetry.js';
import { gtoChartCount } from '../GtoCharts.js';
import { gtoPostflopCount } from '../GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../GtoPostflopV31.js';
import { hydrateHorseMind } from '../../services/HorseMindHydrator.js';
import {
  hydrateHorseMindFromDb,
  startHorseMindPersistence,
  stopHorseMindPersistence,
} from '../../services/HorseMindPersistence.js';
import {
  startBrainTelemetryFlush,
  stopBrainTelemetryFlush,
} from '../../services/BrainTelemetryFlush.js';
import {
  loadGtoCharts,
  startGtoChartLoader,
  stopGtoChartLoader,
} from '../../services/GtoChartLoader.js';
import {
  loadGtoPostflop,
  startGtoPostflopLoader,
  stopGtoPostflopLoader,
} from '../../services/GtoPostflopLoader.js';
import {
  loadGtoPostflopV31,
  startGtoPostflopV31Loader,
  stopGtoPostflopV31Loader,
} from '../../services/GtoPostflopV31Loader.js';
import {
  solverPolicyArtifactStatus,
  startSolverPolicyArtifactLoader,
  stopSolverPolicyArtifactLoader,
} from '../../gto/SolverPolicyArtifactLoader.js';
import { withLocalHorseDecisionServices } from './localServices.js';

export const localHorseDecisionWorkerDependencies = withLocalHorseDecisionServices(
  {
    decide: HorseLogic.decide.bind(HorseLogic),
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: (effects) => HorseMind.applyDecisionEffects(effects),
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    workerReadiness: () => ({
      solverStores: {
        charts: gtoChartCount(),
        postflop: gtoPostflopCount(),
        postflopV31: gtoPostflopV31Count(),
        postflopV31Dataset: gtoPostflopV31Dataset(),
      },
      solverPolicyArtifact: solverPolicyArtifactStatus(),
      governor: equityGovernor.snapshot(),
    }),
    observeCompletedHand: (request) =>
      HorseMind.observeHandComplete(
        request.handKey,
        request.actions,
        request.bigBlind,
        request.showdown,
        request.scope
      ),
    noteDecision: noteDecisionMs,
    noteFeature: noteFire,
    now: () => performance.now(),
  },
  {
    startMindPersistence: startHorseMindPersistence,
    stopMindPersistence: stopHorseMindPersistence,
    startTelemetry: startBrainTelemetryFlush,
    stopTelemetry: stopBrainTelemetryFlush,
    startGovernor: () => equityGovernor.startSampling(),
    stopGovernor: () => equityGovernor.stopSampling(),
    startPolicyLoader: startSolverPolicyArtifactLoader,
    stopPolicyLoader: stopSolverPolicyArtifactLoader,
    hydrateMindFromDb: hydrateHorseMindFromDb,
    hydrateMind: hydrateHorseMind,
    loadCharts: loadGtoCharts,
    loadPostflop: loadGtoPostflop,
    loadPostflopV31: loadGtoPostflopV31,
    startChartLoader: startGtoChartLoader,
    stopChartLoader: stopGtoChartLoader,
    startPostflopLoader: startGtoPostflopLoader,
    stopPostflopLoader: stopGtoPostflopLoader,
    startPostflopV31Loader: startGtoPostflopV31Loader,
    stopPostflopV31Loader: stopGtoPostflopV31Loader,
  }
);
