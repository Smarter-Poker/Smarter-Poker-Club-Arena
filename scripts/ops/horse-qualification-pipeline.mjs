// scripts/ops/horse-qualification-pipeline.mjs
// Automated qualification assembly, validation, and contract integrity pipeline
// for Horse Brain Phase 10, 11, 12, and 13 leagues.

import { execFileSync } from 'node:crypto';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export const SUPPORTED_PHASES = [10, 11, 12, 13];

export const PHASE_VARIANTS = {
  10: ['plo4'],
  11: ['plo5', 'plo6', 'plo8'],
  12: ['flh', 'flo8', 'pineapple', 'short_deck'],
  13: ['plo8', 'plo4', 'nlh', 'plo5', 'plo6', 'flo8', 'flh', 'pineapple', 'short_deck'],
};

export const ASSEMBLER_SCRIPTS = {
  10: 'scripts/phase10-strength-assemble.mjs',
  11: 'scripts/phase11-strength-assemble.mjs',
  12: 'scripts/phase12-strength-assemble.mjs',
  13: 'scripts/phase13-strength-assemble.mjs',
};

/**
 * Validates phase and variant combination.
 */
export function getPhaseConfig(phase, variant) {
  const p = Number(phase);
  if (!SUPPORTED_PHASES.includes(p)) {
    throw new Error(`Unsupported phase ${phase}. Must be one of: ${SUPPORTED_PHASES.join(', ')}`);
  }
  const allowed = PHASE_VARIANTS[p];
  const normalizedVariant = variant ? String(variant).toLowerCase() : allowed[0];
  if (!allowed.includes(normalizedVariant)) {
    throw new Error(
      `Invalid variant "${variant}" for Phase ${phase}. Allowed: ${allowed.join(', ')}`
    );
  }
  return {
    phase: p,
    variant: normalizedVariant,
    script: ASSEMBLER_SCRIPTS[p],
    needsVariantFlag: p !== 10,
  };
}

/**
 * Builds the exact CLI arguments for the assembler invocation.
 */
export function buildAssemblerArgs({ phase, variant, runsDir, outDir, noFormat = true, defectiveFile }) {
  const config = getPhaseConfig(phase, variant);
  if (!runsDir) throw new Error('runsDir is required');
  if (!outDir) throw new Error('outDir is required');

  const args = [
    '--import',
    'tsx',
    config.script,
    `--runs=${runsDir}`,
    `--out=${outDir}`,
  ];

  if (config.needsVariantFlag) {
    args.push(`--variant=${config.variant}`);
  }

  if (noFormat) {
    args.push('--no-format');
  }

  if (defectiveFile) {
    args.push(`--defective=${defectiveFile}`);
  }

  return {
    command: 'node',
    args,
    config,
  };
}

/**
 * Validates the raw JSON output from a strength assembler execution.
 * Ensures the verdict is positive, not refused, and free of disqualifying reasons.
 */
export function validateQualificationResult(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') {
    throw new Error('Empty assembler output');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput.trim());
  } catch (err) {
    throw new Error(`Failed to parse assembler output as JSON: ${err.message}\nRaw: ${rawOutput}`);
  }

  if (parsed.refused === true) {
    throw new Error(`Assembler execution refused: ${JSON.stringify(parsed.reasons || [])}`);
  }

  if (parsed.qualified !== true) {
    throw new Error(
      `Qualification verdict FAILED: qualified=${parsed.qualified}, reasons=${JSON.stringify(parsed.reasons || [])}`
    );
  }

  if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) {
    throw new Error(`Disqualifying reasons encountered: ${parsed.reasons.join(', ')}`);
  }

  return {
    refused: false,
    qualified: true,
    reasons: [],
    variant: parsed.variant,
    strength: parsed.strength,
    qualification: parsed.qualification,
    evidenceSha256: parsed.evidenceSha256,
  };
}

/**
 * Checks policy digest consistency between qualification result and running engine code.
 */
export function verifyPolicyDigestMatch({ qualificationDigest, expectedEngineDigest, variant, phase }) {
  if (!qualificationDigest || !expectedEngineDigest) {
    throw new Error(
      `Missing digest for Phase ${phase} ${variant}: qualification=${qualificationDigest}, expected=${expectedEngineDigest}`
    );
  }
  if (qualificationDigest !== expectedEngineDigest) {
    throw new Error(
      `Policy digest mismatch for Phase ${phase} ${variant}: qualification contains ${qualificationDigest}, but running engine computes ${expectedEngineDigest}`
    );
  }
  return true;
}

/**
 * Parses shard statuses from GitHub Actions jobs array.
 */
export function summarizeRunJobs(jobs = []) {
  const summary = {
    total: jobs.length,
    completed: 0,
    in_progress: 0,
    queued: 0,
    failed: 0,
    isAllDone: false,
    isGreen: false,
  };

  for (const job of jobs) {
    if (job.status === 'completed') {
      summary.completed++;
      if (job.conclusion === 'failure') {
        summary.failed++;
      }
    } else if (job.status === 'in_progress') {
      summary.in_progress++;
    } else if (job.status === 'queued') {
      summary.queued++;
    }
  }

  summary.isAllDone = summary.completed === summary.total && summary.total > 0;
  summary.isGreen = summary.isAllDone && summary.failed === 0;

  return summary;
}
