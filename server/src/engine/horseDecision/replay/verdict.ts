/**
 * Phase 6C verdict shape. One fixed object per replayed decision; every field
 * is present on every verdict so a reader never has to guess what a missing
 * key means. `null` means "not measured", never "zero".
 */
import type { HorsePolicyNode } from '../../HorsePolicyGraph.js';
import type { Phase6ReferenceRoute } from '../../HorsePhase6Attribution.js';

export type HorseReplayStatus = 'reproduced' | 'diverged' | 'refused';

export interface HorseReplayAction {
  action: string;
  amount: number | null;
}

export type HorseReplayCheckStatus = 'agreed' | 'disagreed' | 'not_applicable';

export interface HorseReplayCheck {
  status: HorseReplayCheckStatus;
  /** What the independent verifier derived from the journaled inputs. */
  expected: unknown;
  /** What the journaled decision (or its canonical state) claimed. */
  observed: unknown;
  detail: string | null;
}

export interface HorseReplayReference {
  ref: string;
  status: 'available' | 'unavailable';
  detail: string | null;
}

export interface HorseReplayQualification {
  /** `agreed` only when every applicable check agreed and every cited reference is available. */
  status: 'agreed' | 'disagreed' | 'refused' | 'not_applicable';
  checks: {
    pot_odds: HorseReplayCheck;
    m_state: HorseReplayCheck;
    ante_mode: HorseReplayCheck;
    atlas_coordinate: HorseReplayCheck;
    route: HorseReplayCheck;
  };
  references: HorseReplayReference[];
  /** Same accepted action and same route between original and replay. */
  route: { original: Phase6ReferenceRoute | null; replayed: Phase6ReferenceRoute | null };
  /** Atlas cell the original cited and the cell the replay cited. */
  atlasCell: { original: string | null; replayed: string | null };
  rng: {
    before: { original: number; replayed: number | null };
    after: { original: number; replayed: number | null };
  };
  /** Digest of the whole decision receipt with wall-clock fields removed. */
  receiptDigest: { original: string; replayed: string | null };
}

export interface HorseReplayLatency {
  /** Round trip through the worker runtime, measured by the replay harness. */
  wallMs: number | null;
  /** The runtime's own computeMs for the replayed decision. */
  computeMs: number | null;
  /** The runtime's computeMs recorded in the journal for the original decision. */
  originalComputeMs: number | null;
}

export interface HorseReplayWork {
  /** Policy-graph node visits in the replayed decision (the graph has eight nodes). */
  nodeVisits: number | null;
  originalNodeVisits: number | null;
  /** simulateEquity calls and Monte Carlo iterations granted during the replay. */
  equityCalls: number | null;
  equitySamples: number | null;
  /** Brain telemetry fires during the replay, when telemetry could be armed. */
  telemetryFires: number | null;
  /** Governor scale pinned for the replay (the journaled value). */
  governorScale: number | null;
}

/** The module that owns the accepted action: the last policy node that changed
 * it, else the node that produced it, qualified by the reference route or the
 * variant owner where one applies. `brain_exception` is the safety net. */
export interface HorseReplayAuthorityOwner {
  module: string;
  node: HorsePolicyNode | 'brain_exception' | null;
  route: Phase6ReferenceRoute | null;
  variantOwner: string | null;
}

export interface HorseReplayAuthority {
  original: HorseReplayAuthorityOwner;
  replayed: HorseReplayAuthorityOwner | null;
  same: boolean | null;
}

export interface HorseDecisionReplayVerdict {
  decisionId: string;
  /** Git SHA of the decision code that executed the replay. */
  engineSha: string;
  /** `sourceRelease` on the journal record: the release that made the original decision. */
  recordedRelease: string | null;
  status: HorseReplayStatus;
  reason?: string;
  originalAction: HorseReplayAction | null;
  replayedAction: HorseReplayAction | null;
  qualification: HorseReplayQualification;
  latency: HorseReplayLatency;
  work: HorseReplayWork;
  authority: HorseReplayAuthority;
  /** Coordinates of the decision for population reporting. */
  context: {
    atMs: number | null;
    gameMode: string | null;
    /** `gameState.format` (cash, mtt, sng, spin, hu_sng) as the snapshot carries it. */
    format: string | null;
    gameVariant: string | null;
    stage: string | null;
    tableSize: number | null;
    isHorse: boolean | null;
  };
}
