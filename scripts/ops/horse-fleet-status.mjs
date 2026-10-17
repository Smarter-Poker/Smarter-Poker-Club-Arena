// scripts/ops/horse-fleet-status.mjs
// Real-time status matrix and dashboard for all 17 Horse Brain qualification leagues.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REPO = 'repos/Smarter-Poker/smarter-poker-club-arena';

export const KNOWN_FLEET_RUNS = [
  // Phase 10 (1 variant)
  { phase: 10, variant: 'plo4', runId: '38936316718', expectedShards: 111, initialVerdict: 'qualified' },

  // Phase 11 (3 variants)
  { phase: 11, variant: 'plo8', runId: '38988207185', expectedShards: 114, initialVerdict: 'qualified' },
  { phase: 11, variant: 'plo5', runId: '38988212952', expectedShards: 243, initialVerdict: 'qualified' },
  { phase: 11, variant: 'plo6', runId: '38988218988', expectedShards: 244 },

  // Phase 13 Omaha Group (5 variants)
  { phase: 13, variant: 'plo8', runId: '38988224699', expectedShards: 138 },
  { phase: 13, variant: 'plo4', runId: '38988230226', expectedShards: 153 },
  { phase: 13, variant: 'nlh', runId: '38988235466', expectedShards: 105 },
  { phase: 13, variant: 'plo5', runId: '38988241229', expectedShards: 159 },
  { phase: 13, variant: 'plo6', runId: '38988247155', expectedShards: 141 },

  // Phase 13 Specialty Group (4 variants)
  { phase: 13, variant: 'flo8', runId: '38988259560', expectedShards: 81 },
  { phase: 13, variant: 'flh', runId: '38988265241', expectedShards: 69 },
  { phase: 13, variant: 'pineapple', runId: '38988271092', expectedShards: 51 },
  { phase: 13, variant: 'short_deck', runId: '38988276582', expectedShards: 42 },

  // Phase 12 Specialty Group (4 variants)
  { phase: 12, variant: 'flh', runId: '38936329432', expectedShards: 42, initialVerdict: 'qualified' },
  { phase: 12, variant: 'pineapple', runId: '38936334692', expectedShards: 42, initialVerdict: 'qualified' },
  { phase: 12, variant: 'flo8', runId: '38988282054', expectedShards: 42 },
  { phase: 12, variant: 'short_deck', runId: '38988287494', expectedShards: 36 },
];

/**
 * Generates an ASCII progress bar string.
 */
export function calculateProgressBar(completed, total, width = 10) {
  if (!total || total <= 0) return `[${' '.repeat(width)}]   0%`;
  const pct = Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${String(pct).padStart(3)}%`;
}

/**
 * Calculates human-readable elapsed duration.
 */
export function formatDuration(createdAt, updatedAt) {
  if (!createdAt) return '-';
  const start = new Date(createdAt).getTime();
  const end = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const diffSec = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Fetches status for an individual run using gh run view.
 */
export function fetchRunStatus(runId, { repo = DEFAULT_REPO, ghBin = 'gh' } = {}) {
  const args = ['run', 'view', String(runId), '--json', 'status,conclusion,createdAt,updatedAt,jobs'];
  if (repo) {
    args.push('-R', repo.replace(/^repos\//, ''));
  }

  try {
    const raw = execFileSync(ghBin, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
    });
    const parsed = JSON.parse(raw);
    const jobs = parsed.jobs || [];

    let completed = 0;
    let inProgress = 0;
    let queued = 0;
    let failed = 0;

    for (const job of jobs) {
      if (job.status === 'completed') {
        completed++;
        if (job.conclusion === 'failure') failed++;
      } else if (job.status === 'in_progress') {
        inProgress++;
      } else if (job.status === 'queued') {
        queued++;
      }
    }

    return {
      runId: String(runId),
      status: parsed.status,
      conclusion: parsed.conclusion,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      totalJobs: jobs.length,
      completed,
      inProgress,
      queued,
      failed,
      duration: formatDuration(parsed.createdAt, parsed.updatedAt),
    };
  } catch (err) {
    return {
      runId: String(runId),
      status: 'error',
      conclusion: 'error',
      error: err.message,
      totalJobs: 0,
      completed: 0,
      inProgress: 0,
      queued: 0,
      failed: 0,
      duration: '-',
    };
  }
}

/**
 * Fetches status for a list of runs.
 */
export function fetchFleetStatus({ runs = KNOWN_FLEET_RUNS, repo = DEFAULT_REPO, ghBin = 'gh' } = {}) {
  return runs.map((entry) => {
    const live = fetchRunStatus(entry.runId, { repo, ghBin });
    const total = live.totalJobs > 0 ? live.totalJobs : entry.expectedShards || 0;
    let completed = live.completed;
    let status = live.status;
    let verdict = entry.initialVerdict || '-';

    if (live.status === 'error' && entry.initialVerdict === 'qualified') {
      status = 'completed';
      completed = total;
      verdict = 'qualified';
    } else if (live.conclusion === 'success') {
      verdict = 'qualified';
    } else if (live.conclusion === 'failure') {
      verdict = 'failed';
    } else if (live.inProgress > 0 || live.status === 'in_progress') {
      verdict = 'running';
    } else if (live.status === 'queued') {
      verdict = 'queued';
    }

    return {
      phase: entry.phase,
      variant: entry.variant,
      runId: entry.runId,
      status,
      conclusion: live.conclusion,
      shardsCompleted: completed,
      shardsTotal: total,
      inProgress: live.inProgress,
      queued: live.queued,
      failed: live.failed,
      duration: live.duration,
      verdict,
      progressBar: calculateProgressBar(completed, total, 10),
    };
  });
}

/**
 * Formats the fleet status list into a clean printable table.
 */
export function formatFleetTable(fleet) {
  const header = [
    'Phase'.padEnd(6),
    'Variant'.padEnd(12),
    'Run ID'.padEnd(13),
    'Status'.padEnd(12),
    'Shards'.padEnd(11),
    'Progress'.padEnd(18),
    'Verdict'.padEnd(11),
    'Duration'.padEnd(9),
  ].join(' | ');

  const separator = '-'.repeat(header.length);

  const rows = fleet.map((f) => {
    const shardsStr = `${f.shardsCompleted}/${f.shardsTotal}`.padStart(9);
    return [
      `P${f.phase}`.padEnd(6),
      f.variant.padEnd(12),
      f.runId.padEnd(13),
      f.status.padEnd(12),
      shardsStr.padEnd(11),
      f.progressBar.padEnd(18),
      f.verdict.padEnd(11),
      f.duration.padEnd(9),
    ].join(' | ');
  });

  const totalShards = fleet.reduce((acc, f) => acc + (f.shardsTotal || 0), 0);
  const totalCompleted = fleet.reduce((acc, f) => acc + (f.shardsCompleted || 0), 0);
  const overallBar = calculateProgressBar(totalCompleted, totalShards, 16);

  const footer = [
    separator,
    `Total Fleet: 17 Leagues | Completed Shards: ${totalCompleted}/${totalShards} ${overallBar}`,
  ].join('\n');

  return [header, separator, ...rows, footer].join('\n');
}

// CLI runner
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v] = arg.replace(/^--/, '').split('=');
      return [k, v === undefined ? true : v];
    })
  );

  const known = KNOWN_FLEET_RUNS.find((r) => r.runId === String(args.runId));
  const runsToQuery = args.runId
    ? [known ? { ...known } : { phase: Number(args.phase || 0), variant: args.variant || 'custom', runId: String(args.runId) }]
    : KNOWN_FLEET_RUNS;

  const runOnce = () => {
    const fleet = fetchFleetStatus({ runs: runsToQuery });
    if (args.json) {
      console.log(JSON.stringify(fleet, null, 2));
    } else {
      console.log(`\n=== HORSE BRAIN FLEET QUALIFICATION MATRIX (${new Date().toISOString()}) ===\n`);
      console.log(formatFleetTable(fleet));
    }
  };

  runOnce();
}
