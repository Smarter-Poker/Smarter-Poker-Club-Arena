/**
 * Messages between the live engine process and its isolated Horse League
 * compute worker.  Only CPU-bound, side-effect-free league work crosses this
 * boundary; job claims and result writes remain in the live engine process.
 */

import type { LeagueMatchup, LeagueResult } from './HorseLeague.js';
import type { AgreementResult } from './HorseSolverAgreement.js';
import type { GtoV31AgreementResult } from './HorseSolverAgreementV31.js';
import type { HorseDecisionWorkerReady } from '../engine/horseDecision/protocol.js';

export type SolverStoreCounts = HorseDecisionWorkerReady['solverStores'];

export type HorseLeagueComputeRequest =
  | {
      type: 'RUN_MATCHUP';
      jobId: number;
      matchup: LeagueMatchup;
      pairs: number;
      runSeed: number;
    }
  | { type: 'SCORE_SOLVER_AGREEMENT'; jobId: number; maxSpots?: number }
  | { type: 'SCORE_GTO_V31_AGREEMENT'; jobId: number; maxSpots?: number }
  | { type: 'CANCEL'; jobId: number };

export type HorseLeagueComputeResponse =
  | { type: 'READY'; solverStores: SolverStoreCounts; executionNice?: number }
  | { type: 'HEARTBEAT'; jobId: number }
  | { type: 'MATCHUP_RESULT'; jobId: number; result: LeagueResult }
  | { type: 'AGREEMENT_RESULT'; jobId: number; result: AgreementResult }
  | { type: 'GTO_V31_AGREEMENT_RESULT'; jobId: number; result: GtoV31AgreementResult }
  | { type: 'ERROR'; jobId: number | null; message: string };
