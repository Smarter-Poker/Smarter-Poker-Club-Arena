// scripts/ops/horse-qualification-pipeline.mjs
// Automated qualification assembly, validation, and contract integrity pipeline
// for Horse Brain Phase 10, 11, 12, and 13 leagues.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

export const DEFAULT_REPO = 'repos/Smarter-Poker/smarter-poker-club-arena';

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
export function buildAssemblerArgs({ phase, variant, runsDir, outDir, repoRoot, noFormat = true, defectiveFile }) {
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

  if (repoRoot) {
    args.push(`--repo-root=${repoRoot}`);
  }

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

/**
 * Executes gh run download to pull all artifacts into the destination folder.
 */
export function downloadRunArtifacts({ runId, targetDir, repo = DEFAULT_REPO, ghBin = 'gh' }) {
  if (!runId) throw new Error('runId is required for download');
  if (!targetDir) throw new Error('targetDir is required for download');

  mkdirSync(targetDir, { recursive: true });

  const args = ['run', 'download', String(runId), '--dir', targetDir];
  if (repo) {
    args.push('-R', repo.replace(/^repos\//, ''));
  }

  const output = execFileSync(ghBin, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });

  return { targetDir, output };
}

/**
 * Invokes the assembler script in server directory and validates the result.
 */
export function runStrengthAssembler({
  phase,
  variant,
  runsDir,
  outDir,
  repoRoot = process.cwd(),
  noFormat = true,
  defectiveFile,
  nodeBin = 'node',
}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedOutDir = path.isAbsolute(outDir) ? outDir : path.resolve(resolvedRepoRoot, outDir);
  const resolvedRunsDir = path.isAbsolute(runsDir) ? runsDir : path.resolve(resolvedRepoRoot, runsDir);
  const { command, args } = buildAssemblerArgs({
    phase,
    variant,
    runsDir: resolvedRunsDir,
    outDir: resolvedOutDir,
    repoRoot: resolvedRepoRoot,
    noFormat,
    defectiveFile,
  });

  const serverDir = path.resolve(resolvedRepoRoot, 'server');
  const stdout = execFileSync(nodeBin, args, {
    cwd: serverDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });

  const verdict = validateQualificationResult(stdout);
  return { verdict, stdout };
}

/**
 * Queries GitHub Actions for any failed jobs within a run and re-runs only the failed shards.
 */
export function retryFailedShards({ runId, repo = DEFAULT_REPO, ghBin = 'gh' }) {
  if (!runId) throw new Error('runId is required for retrying failed shards');

  const viewArgs = ['run', 'view', String(runId), '--json', 'jobs,status,conclusion'];
  if (repo) {
    viewArgs.push('-R', repo.replace(/^repos\//, ''));
  }

  const raw = execFileSync(ghBin, viewArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  const parsed = JSON.parse(raw);
  const failedJobs = (parsed.jobs || []).filter((j) => j.conclusion === 'failure');

  if (failedJobs.length === 0) {
    return {
      retried: false,
      failedCount: 0,
      failedJobs: [],
      message: 'No failed shards found in run.',
    };
  }

  const rerunArgs = ['run', 'rerun', String(runId), '--failed'];
  if (repo) {
    rerunArgs.push('-R', repo.replace(/^repos\//, ''));
  }

  const output = execFileSync(ghBin, rerunArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });

  return {
    retried: true,
    failedCount: failedJobs.length,
    failedJobs: failedJobs.map((j) => ({ id: j.id, name: j.name })),
    output: output.trim(),
  };
}

/**
 * Polls a running GitHub Actions workflow run until completion.
 */
export async function pollRunCompletion({
  runId,
  repo = DEFAULT_REPO,
  ghBin = 'gh',
  intervalMs = 15000,
  maxWaitMs = 18000000,
  onProgress,
}) {
  if (!runId) throw new Error('runId is required for polling');

  const startTime = Date.now();
  const viewArgs = ['run', 'view', String(runId), '--json', 'status,conclusion,jobs'];
  if (repo) {
    viewArgs.push('-R', repo.replace(/^repos\//, ''));
  }

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const raw = execFileSync(ghBin, viewArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      const parsed = JSON.parse(raw);
      const summary = summarizeRunJobs(parsed.jobs || []);

      if (typeof onProgress === 'function') {
        onProgress({
          runId: String(runId),
          status: parsed.status,
          conclusion: parsed.conclusion,
          ...summary,
        });
      }

      if (parsed.status === 'completed') {
        return {
          completed: true,
          success: parsed.conclusion === 'success',
          conclusion: parsed.conclusion,
          summary,
        };
      }
    } catch (err) {
      if (typeof onProgress === 'function') {
        onProgress({ runId: String(runId), error: err.message });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Run ${runId} timed out after ${Math.round(maxWaitMs / 1000)}s`);
}

/**
 * End-to-end qualification pipeline orchestrator.
 */
export async function executeQualificationPipeline({
  phase,
  variant,
  runId,
  runsDir,
  outDir,
  repoRoot = process.cwd(),
  archiveDir,
  expectedEngineDigest,
  noFormat = true,
  defectiveFile,
  watch = false,
  pollIntervalMs = 15000,
  onProgress,
  repo = DEFAULT_REPO,
  ghBin = 'gh',
}) {
  const config = getPhaseConfig(phase, variant);
  let effectiveRunsDir = runsDir;

  if (runId && watch) {
    const pollResult = await pollRunCompletion({
      runId,
      repo,
      ghBin,
      intervalMs: pollIntervalMs,
      onProgress,
    });
    if (!pollResult.success) {
      throw new Error(`Run ${runId} concluded with status ${pollResult.conclusion}, cannot assemble.`);
    }
  }

  if (runId && (!runsDir || !existsSync(runsDir) || readdirSync(runsDir).length === 0)) {
    const downloadDir = runsDir || path.resolve(repoRoot, '.artifacts', `${config.phase}-${config.variant}-${runId}`);
    downloadRunArtifacts({ runId, targetDir: downloadDir, repo, ghBin });
    effectiveRunsDir = downloadDir;
  }

  if (!effectiveRunsDir || !existsSync(effectiveRunsDir)) {
    throw new Error(`Runs directory not found: ${effectiveRunsDir}`);
  }

  const { verdict } = runStrengthAssembler({
    phase: config.phase,
    variant: config.variant,
    runsDir: effectiveRunsDir,
    outDir,
    repoRoot,
    noFormat,
    defectiveFile,
  });

  if (expectedEngineDigest) {
    const qualContent = JSON.parse(readFileSync(verdict.qualification, 'utf8'));
    const qualDigest = qualContent.policyDigest || qualContent.policy_digest;
    verifyPolicyDigestMatch({
      qualificationDigest: qualDigest,
      expectedEngineDigest,
      variant: config.variant,
      phase: config.phase,
    });
  }

  if (archiveDir) {
    mkdirSync(archiveDir, { recursive: true });
    cpSync(verdict.qualification, path.resolve(archiveDir, path.basename(verdict.qualification)));
    cpSync(path.dirname(verdict.strength), path.resolve(archiveDir, path.basename(path.dirname(verdict.strength))), {
      recursive: true,
    });
  }

  return {
    success: true,
    config,
    verdict,
  };
}

// CLI runner
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v] = arg.replace(/^--/, '').split('=');
      return [k, v === undefined ? true : v];
    })
  );

  // Standalone failed shards retry mode
  if (args['retry-failed']) {
    if (!args.runId) {
      console.error('Usage: node scripts/ops/horse-qualification-pipeline.mjs --retry-failed --runId=<id>');
      process.exit(1);
    }
    try {
      const retryResult = retryFailedShards({ runId: args.runId });
      console.log(JSON.stringify(retryResult, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('Failed to retry shards:', err.message);
      process.exit(1);
    }
  }

  if (!args.phase) {
    console.error('Usage: node scripts/ops/horse-qualification-pipeline.mjs --phase=<10|11|12|13> [--variant=<name>] --runs=<dir> --out=<dir> [--runId=<id>] [--watch]');
    process.exit(1);
  }

  try {
    const result = await executeQualificationPipeline({
      phase: args.phase,
      variant: args.variant,
      runId: args.runId,
      runsDir: args.runs,
      outDir: args.out,
      archiveDir: args.archive,
      noFormat: args.noFormat !== 'false',
      watch: Boolean(args.watch),
      expectedEngineDigest: args.expectedDigest || args.expectedEngineDigest || args['expected-digest'],
      onProgress: (p) => {
        if (p.error) {
          console.error(`[Watch ${p.runId}] Error: ${p.error}`);
        } else {
          console.log(`[Watch ${p.runId}] ${p.status} - ${p.completed}/${p.total} shards completed (${p.in_progress} in progress, ${p.queued} queued)`);
        }
      },
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Pipeline execution error:', err.message);
    process.exit(1);
  }
}
