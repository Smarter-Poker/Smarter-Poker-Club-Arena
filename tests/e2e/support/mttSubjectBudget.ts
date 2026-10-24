import { HUD_RESERVE_MS, MTT_HUD_LEVEL_CAP_MS } from './tournamentHudWitness';
import {
  MAX_NATURAL_COMPLETION_RESELECTIONS,
  type CaseFailureOutcome,
} from './tournamentBoardEnding';

/** The existing 300s case plus one 90s causal-hand allowance. */
export const MTT_SUBJECT_STARTUP_MS = 390_000;
export const MTT_MAX_SUBJECT_MS = MTT_SUBJECT_STARTUP_MS + MTT_HUD_LEVEL_CAP_MS + HUD_RESERVE_MS;
export const MTT_MAX_CASE_MS = (MAX_NATURAL_COMPLETION_RESELECTIONS + 1) * MTT_MAX_SUBJECT_MS;

/**
 * Only a proven natural ending can admit a fresh MTT subject. Its startup
 * does not inherit the previous board's spent HUD clock. A fresh actual HUD
 * clock may extend that startup deadline, within both finite caps below.
 * No closure is a passing certificate: every replacement repeats the proof.
 */
export function admitMttReplacementBudget(input: {
  outcome: CaseFailureOutcome['kind'];
  reselectionsUsed: number;
  caseElapsedMs: number;
}): { startupTimeoutMs: number; subjectMaxTimeoutMs: number } | null {
  if (
    input.outcome !== 'natural-completion' ||
    !Number.isSafeInteger(input.reselectionsUsed) ||
    input.reselectionsUsed < 0 ||
    input.reselectionsUsed >= MAX_NATURAL_COMPLETION_RESELECTIONS ||
    !Number.isFinite(input.caseElapsedMs) ||
    input.caseElapsedMs < 0
  )
    return null;
  const startupTimeoutMs = Math.min(input.caseElapsedMs + MTT_SUBJECT_STARTUP_MS, MTT_MAX_CASE_MS);
  if (startupTimeoutMs - input.caseElapsedMs < MTT_SUBJECT_STARTUP_MS) return null;
  return {
    startupTimeoutMs,
    subjectMaxTimeoutMs: Math.min(input.caseElapsedMs + MTT_MAX_SUBJECT_MS, MTT_MAX_CASE_MS),
  };
}
