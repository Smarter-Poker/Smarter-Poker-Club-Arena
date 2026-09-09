/**
 * Daily agreement probe for the promoted certified V31 NLH corpus.
 *
 * The compact store cannot be treated as a bag of answers: a cell is only
 * eligible after the ordinary HorseLogic state classifier proves the exact
 * public line. This probe therefore runs deterministic duplicate-deal hands
 * through the same memory-only decision path and records the reference mix,
 * sampled action, final legalized action, action regret, and complete source
 * seal for every V31 hit. No database or network call occurs here.
 *
 * This is agreement and execution-liveness evidence, not exploitability. The
 * independently held-out and paired-league release gates remain the authority
 * for promotion quality.
 */

import { createHash } from 'node:crypto';

import { buildGtoV31EvaluationScenarios } from './GtoV31CandidateEvaluation.js';
import { runMatchup, type LeagueMatchup } from './HorseLeague.js';
import type {
  GtoV31DecisionReceipt,
  GtoV31DecisionStateReceipt,
  HorseDecideOpts,
} from '../engine/HorseLogic.js';
import {
  gtoPostflopV31Count,
  gtoPostflopV31Dataset,
  type GtoV31SourceSeal,
} from '../engine/GtoPostflopV31.js';
import { stableSolverPolicyJson } from '../gto/SolverPolicyContract.js';

export const GTO_V31_AGREEMENT_REFERENCE = 'gto_v31_certified' as const;
const DEFAULT_MAX_SPOTS = 600;
const MAX_SPOTS = 5_000;
const MIN_SPOTS = 9;
const MAX_PAIRS_PER_SCENARIO = 512;
const FAMILIES = ['cash', 'spin', 'tourney_ev', 'tourney_icm'] as const;
const PIO_ACTION_ID = /^(?:c|f|b[1-9][0-9]{0,78})$/;

export interface GtoV31AgreementDecisionState extends GtoV31DecisionStateReceipt {
  probeScenario: string;
  probeOrdinal: number;
  sampledActionId: string;
  sampledActionFamily: string;
  sampledAmount: number | null;
  finalAction: string;
  finalAmount: number | null;
  executedAsIntended: boolean;
}

export interface GtoV31AgreementDecision {
  stateKey: string;
  decisionState: GtoV31AgreementDecisionState;
  stage: GtoV31DecisionStateReceipt['street'];
  gameFamily: GtoV31DecisionStateReceipt['gameFamily'];
  objective: GtoV31DecisionStateReceipt['objective'];
  utilityContext: GtoV31DecisionStateReceipt['utilityContext'];
  tableSize: number;
  potType: GtoV31DecisionStateReceipt['potType'];
  heroPosition: GtoV31DecisionStateReceipt['heroPosition'];
  opponentPosition: GtoV31DecisionStateReceipt['opponentPosition'];
  depthBucket: number;
  textureClass: string;
  nodeRole: GtoV31DecisionStateReceipt['nodeRole'];
  facingKind: GtoV31DecisionStateReceipt['facingKind'];
  facingSizeBucket: GtoV31DecisionStateReceipt['facingSizeBucket'];
  cell: string;
  handKey: string;
  sampledActionId: string;
  sampledActionFamily: string;
  finalAction: string;
  executedAsIntended: boolean;
  referenceDistribution: Record<string, number>;
  chosenProbability: number;
  actionRegretBb: number | null;
  regretEligible: boolean;
  pureMiss: boolean;
  sourceSeal: GtoV31SourceSeal;
}

export interface GtoV31AgreementResult {
  spots: number;
  agreement: number;
  pureMisses: number;
  reference: typeof GTO_V31_AGREEMENT_REFERENCE | null;
  eligibleSpots: number;
  reconciledSpots: number;
  actionRegretBb: number | null;
  regretEligibleSpots: number;
  decisionChecksum: string | null;
  decisions: GtoV31AgreementDecision[];
}

type DatasetIdentity = { id: string; checksum: string };
type MatchupRunner = typeof runMatchup;

export interface GtoV31AgreementDependencies {
  dataset?: () => DatasetIdentity | null;
  cellCount?: () => number;
  run?: MatchupRunner;
}

export interface GtoV31AgreementHooks {
  shouldContinue?: () => boolean;
  onProgress?: () => void;
  dependencies?: GtoV31AgreementDependencies;
}

function emptyResult(): GtoV31AgreementResult {
  return {
    spots: 0,
    agreement: 0,
    pureMisses: 0,
    reference: null,
    eligibleSpots: 0,
    reconciledSpots: 0,
    actionRegretBb: null,
    regretEligibleSpots: 0,
    decisionChecksum: null,
    decisions: [],
  };
}

function probeSeed(datasetChecksum: string, scenario: string): number {
  return (
    createHash('sha256')
      .update(`gto-v31-agreement:${datasetChecksum}:${scenario}`)
      .digest()
      .readUInt32BE(0) || 1
  );
}

function exactNumericMap(value: Record<string, number>): boolean {
  const entries = Object.entries(value);
  return (
    entries.length >= 2 &&
    entries.every(
      ([key, item]) =>
        PIO_ACTION_ID.test(key) &&
        typeof item === 'number' &&
        Number.isFinite(item) &&
        item >= 0 &&
        item <= 1
    ) &&
    Math.abs(entries.reduce((sum, [, item]) => sum + item, 0) - 1) <= 0.002
  );
}

export function gtoV31AgreementDecisionFromReceipt(args: {
  receipt: GtoV31DecisionReceipt;
  dataset: DatasetIdentity;
  probeScenario: string;
  probeOrdinal: number;
}): GtoV31AgreementDecision {
  const { receipt, dataset, probeScenario, probeOrdinal } = args;
  const state = receipt.decisionState;
  if (
    receipt.datasetId !== dataset.id ||
    receipt.datasetChecksum !== dataset.checksum ||
    receipt.sourceSeal.dataset_id !== dataset.id ||
    receipt.sourceSeal.dataset_checksum !== dataset.checksum ||
    receipt.sourceSeal.dataset_state !== 'active' ||
    receipt.cell !== state.cell ||
    receipt.handKey !== state.handKey ||
    receipt.nodeRole !== state.nodeRole ||
    !Number.isSafeInteger(probeOrdinal) ||
    probeOrdinal <= 0 ||
    !probeScenario ||
    probeScenario !== state.utilityContext ||
    !exactNumericMap(receipt.referenceDistribution) ||
    !(receipt.actionId in receipt.referenceDistribution)
  ) {
    throw new Error('V31 agreement received a contradictory decision receipt');
  }

  const selectedProbability = receipt.referenceDistribution[receipt.actionId];
  const chosenProbability = receipt.executedAsIntended ? selectedProbability : 0;
  const probabilities = Object.values(receipt.referenceDistribution);
  const maximumProbability = Math.max(...probabilities);
  const actionEvs = receipt.actionEvsBb;
  const evKeys = actionEvs ? Object.keys(actionEvs) : [];
  const regretEligible =
    receipt.executedAsIntended &&
    actionEvs !== null &&
    evKeys.length === Object.keys(receipt.referenceDistribution).length &&
    Object.keys(receipt.referenceDistribution).every(
      (key) => typeof actionEvs[key] === 'number' && Number.isFinite(actionEvs[key])
    );
  const selectedEv = regretEligible ? (actionEvs?.[receipt.actionId] as number) : null;
  const actionRegretBb =
    selectedEv === null
      ? null
      : Math.max(0, Math.max(...Object.values(actionEvs as Record<string, number>)) - selectedEv);
  const pureMiss =
    maximumProbability >= 0.9 && (!receipt.executedAsIntended || selectedProbability < 0.9);
  const decisionState: GtoV31AgreementDecisionState = {
    ...structuredClone(state),
    probeScenario,
    probeOrdinal,
    sampledActionId: receipt.actionId,
    sampledActionFamily: receipt.sampledActionFamily,
    sampledAmount: receipt.sampledAmount,
    finalAction: receipt.finalAction,
    finalAmount: receipt.finalAmount,
    executedAsIntended: receipt.executedAsIntended,
  };
  const stateKey = ['v31', receipt.cell, receipt.handKey, probeScenario, String(probeOrdinal)].join(
    '|'
  );
  if (stateKey.length > 512) throw new Error('V31 agreement state key exceeds its schema bound');

  return {
    stateKey,
    decisionState,
    stage: state.street,
    gameFamily: state.gameFamily,
    objective: state.objective,
    utilityContext: state.utilityContext,
    tableSize: state.tableSize,
    potType: state.potType,
    heroPosition: state.heroPosition,
    opponentPosition: state.opponentPosition,
    depthBucket: state.depthBucket,
    textureClass: state.textureClass,
    nodeRole: state.nodeRole,
    facingKind: state.facingKind,
    facingSizeBucket: state.facingSizeBucket,
    cell: state.cell,
    handKey: state.handKey,
    sampledActionId: receipt.actionId,
    sampledActionFamily: receipt.sampledActionFamily,
    finalAction: receipt.finalAction,
    executedAsIntended: receipt.executedAsIntended,
    referenceDistribution: structuredClone(receipt.referenceDistribution),
    chosenProbability,
    actionRegretBb,
    regretEligible,
    pureMiss,
    sourceSeal: structuredClone(receipt.sourceSeal),
  };
}

function probeOpts(onDecision?: NonNullable<HorseDecideOpts['onGtoV31Decision']>): HorseDecideOpts {
  return {
    mind: false,
    telemetry: false,
    v9: false,
    ...(onDecision ? { onGtoV31Decision: onDecision } : {}),
  };
}

function probeMatchup(
  template: LeagueMatchup,
  onDecision: NonNullable<HorseDecideOpts['onGtoV31Decision']>
): LeagueMatchup {
  return {
    ...template,
    name: `gto_v31_agreement_${template.name}`,
    a: probeOpts(onDecision),
    b: probeOpts(),
  };
}

/**
 * Run a bounded, deterministic sample through every Phase 4 family/utility
 * context. The hard pair cap prevents a sparse or malformed active corpus from
 * consuming the league's entire wall-clock budget. Every context must fill
 * its assigned quota; partial context coverage is rejected rather than
 * diluted inside a seemingly healthy aggregate.
 */
export async function scoreGtoV31Agreement(
  maxSpots = DEFAULT_MAX_SPOTS,
  hooks: GtoV31AgreementHooks = {}
): Promise<GtoV31AgreementResult> {
  if (!Number.isSafeInteger(maxSpots) || maxSpots < MIN_SPOTS || maxSpots > MAX_SPOTS) {
    throw new Error(`V31 agreement maxSpots must be an integer from ${MIN_SPOTS} to ${MAX_SPOTS}`);
  }
  const shouldContinue = hooks.shouldContinue ?? (() => true);
  const onProgress = hooks.onProgress ?? (() => {});
  const dataset = (hooks.dependencies?.dataset ?? gtoPostflopV31Dataset)();
  const cellCount = (hooks.dependencies?.cellCount ?? gtoPostflopV31Count)();
  const run = hooks.dependencies?.run ?? runMatchup;
  if (!dataset && cellCount === 0) return emptyResult();
  if (
    !dataset ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dataset.id) ||
    !/^[0-9a-f]{64}$/.test(dataset.checksum) ||
    dataset.checksum === '0'.repeat(64)
  ) {
    throw new Error('V31 agreement cannot prove the active dataset identity');
  }
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) {
    throw new Error('V31 agreement cannot prove the active cell count');
  }

  const templates = FAMILIES.flatMap((family) =>
    buildGtoV31EvaluationScenarios(family, 'league', dataset.checksum)
  );
  if (
    templates.length !== MIN_SPOTS ||
    new Set(templates.map((template) => `${template.family}|${template.key}`)).size !==
      templates.length
  ) {
    throw new Error('V31 agreement scenario coverage is incomplete or duplicated');
  }
  const baseTargetPerScenario = Math.floor(maxSpots / templates.length);
  const extraScenarioTargets = maxSpots % templates.length;
  const decisions: GtoV31AgreementDecision[] = [];
  for (const [templateIndex, template] of templates.entries()) {
    if (!shouldContinue() || decisions.length >= maxSpots) break;
    const targetForScenario =
      baseTargetPerScenario + (templateIndex < extraScenarioTargets ? 1 : 0);
    let scenarioSpots = 0;
    const onDecision = (receipt: GtoV31DecisionReceipt): void => {
      if (scenarioSpots >= targetForScenario || decisions.length >= maxSpots) return;
      if (
        receipt.decisionState.gameFamily !== template.family ||
        receipt.decisionState.utilityContext !== template.key
      ) {
        throw new Error(
          `V31 agreement scenario ${template.family}|${template.key} produced contradictory ${receipt.decisionState.gameFamily}|${receipt.decisionState.utilityContext} evidence`
        );
      }
      const decision = gtoV31AgreementDecisionFromReceipt({
        receipt,
        dataset,
        probeScenario: template.key,
        probeOrdinal: decisions.length + 1,
      });
      decisions.push(decision);
      scenarioSpots++;
    };
    const matchup = probeMatchup(template.matchup, onDecision);
    const continueScenario = (): boolean => {
      onProgress();
      return shouldContinue() && scenarioSpots < targetForScenario && decisions.length < maxSpots;
    };
    await run(
      matchup,
      MAX_PAIRS_PER_SCENARIO,
      probeSeed(dataset.checksum, template.key),
      continueScenario
    );
    if (shouldContinue() && scenarioSpots !== targetForScenario) {
      throw new Error(
        `the active V31 corpus produced ${scenarioSpots}/${targetForScenario} required agreement decisions for ${template.family}|${template.key}`
      );
    }
  }

  if (!shouldContinue()) return emptyResult();
  if (decisions.length === 0) {
    throw new Error('the active V31 corpus produced zero eligible agreement decisions');
  }
  if (decisions.length !== maxSpots) {
    throw new Error(
      `the active V31 corpus produced ${decisions.length}/${maxSpots} required agreement decisions`
    );
  }
  const pureMisses = decisions.filter((decision) => decision.pureMiss).length;
  const regret = decisions.filter(
    (decision): decision is GtoV31AgreementDecision & { actionRegretBb: number } =>
      decision.actionRegretBb !== null
  );
  return {
    spots: decisions.length,
    agreement:
      decisions.reduce((sum, decision) => sum + decision.chosenProbability, 0) / decisions.length,
    pureMisses,
    reference: GTO_V31_AGREEMENT_REFERENCE,
    eligibleSpots: decisions.length,
    reconciledSpots: decisions.length,
    actionRegretBb:
      regret.length > 0
        ? regret.reduce((sum, decision) => sum + decision.actionRegretBb, 0) / regret.length
        : null,
    regretEligibleSpots: regret.length,
    decisionChecksum: createHash('sha256').update(stableSolverPolicyJson(decisions)).digest('hex'),
    decisions,
  };
}
