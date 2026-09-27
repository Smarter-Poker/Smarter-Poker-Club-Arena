import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnvironmentForCwd } from '../scripts/ci/classify-ci-changes.mjs';

// Subprocess contract suite: every case drives the REAL workflow step bodies
// (bash, git, curl, python3, jq) against a disposable history, so wall time
// scales with machine load. 90s is a real bound that still fails a hung child.
vi.setConfig({ testTimeout: 90_000 });

/**
 * AN OWED ENGINE RELEASE IS OFFERED UNTIL PRODUCTION HOLDS IT (2026-09-27).
 *
 * From 15:09 UTC on 2026-09-26 to 15:03 UTC on 2026-09-27 no engine release
 * reached production. The only request, 9e275e1c1a (run 36250934873), waited
 * through two shut certificates and ended at 17:22. The stager only sent a
 * release when a push changed engine code, and the next 42 pushes changed the
 * database, the client and tests, so every one of them printed "Engine runtime
 * release required: false" while production fell 61 commits behind main.
 *
 * The law: while the live engine does not contain the newest engine-affecting
 * commit on main, a push to main offers that commit again through the one
 * receiver - never while a receiver for it is still running, and never twice
 * inside the offer interval - and a live identity that cannot be read offers
 * nothing on that basis and says so.
 */

const root = resolve(__dirname, '..');
const workflowPath = join(root, '.github/workflows/stage-engine-release.yml');
const stage = parse(readFileSync(workflowPath, 'utf8'));
const detector = stage.jobs.detect.steps.find((step: { id?: string }) => step.id === 'change');
const offer = stage.jobs.signal.steps.find((step: { id?: string }) => step.id === 'offer');
const SERVER_PATHS = [
  'server/**',
  ':(exclude)server/**/*.test.ts',
  ':(exclude)server/sim/**',
  ':(exclude)server/qualification/**',
];

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ca-owed-release-'));
  cleanups.push(cwd);
  const env = {
    ...gitEnvironmentForCwd(),
    GIT_AUTHOR_NAME: 'Owed release fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Owed release fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const commit = (path: string, content: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git('add', '.');
    git('commit', '-qm', `change ${path}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  // live: the release production runs. owed: a later engine change that never
  // landed. before/after: an ordinary client push made after both.
  const live = commit('server/src/GameServer.ts', 'live');
  const owed = commit('server/src/GameServer.ts', 'owed');
  const before = commit('src/pages/ClubHomePage.tsx', 'client one');
  const after = commit('src/pages/ClubHomePage.tsx', 'client two');
  return { cwd, env, git, commit, live, owed, before, after };
}

let seq = 0;
function health(cwd: string, body: string) {
  const file = join(cwd, `health-${++seq}.json`);
  writeFileSync(file, body);
  return `file://${file}`;
}

function detect(
  fx: ReturnType<typeof fixture>,
  opts: { before?: string; after?: string; healthUrl?: string }
) {
  const output = join(fx.cwd, `out-${++seq}`);
  writeFileSync(output, '');
  const env: Record<string, string> = {
    ...fx.env,
    BEFORE_SHA: opts.before ?? fx.before,
    AFTER_SHA: opts.after ?? fx.after,
    GITHUB_OUTPUT: output,
  };
  if (opts.healthUrl !== undefined) env.ENGINE_HEALTH_URL = opts.healthUrl;
  const run = spawnSync('bash', ['-c', detector.run], {
    cwd: fx.cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(run.status, run.stderr).toBe(0);
  const out = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string])
  );
  return { out, stdout: run.stdout };
}

function decide(opts: { reason: string; sha: string; runs?: unknown; ghFails?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'ca-owed-offer-'));
  cleanups.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'gh-calls');
  const runsFile = join(dir, 'runs.json');
  writeFileSync(runsFile, JSON.stringify(opts.runs ?? { workflow_runs: [] }));
  // A stand-in for the GitHub CLI: records every call, answers the runs list
  // from the fixture, and can be made to fail like an unreadable API.
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${calls}'\n` +
      (opts.ghFails ? 'echo "HTTP 403" >&2; exit 1\n' : `cat '${runsFile}'\n`)
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const run = spawnSync('bash', ['-c', offer.run], {
    cwd: dir,
    env: {
      ...gitEnvironmentForCwd(),
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'fixture-token-not-a-credential',
      GITHUB_OUTPUT: output,
      OFFER_REASON: opts.reason,
      REF_SHA: opts.sha,
      REPO: 'fixture/repo',
      OFFER_INTERVAL_SECONDS: String(offer.env.OFFER_INTERVAL_SECONDS),
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  let ghCalls = '';
  try {
    ghCalls = readFileSync(calls, 'utf8');
  } catch {
    ghCalls = '';
  }
  return {
    status: run.status,
    output: readFileSync(output, 'utf8'),
    stdout: run.stdout,
    stderr: run.stderr,
    ghCalls,
  };
}

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

describe('the detector: a release is owed until production holds it', () => {
  it('offers the newest engine commit again when a non-engine push finds production behind it', () => {
    const fx = fixture();
    const { out, stdout } = detect(fx, {
      healthUrl: health(fx.cwd, JSON.stringify({ releaseSha: fx.live, status: 'ok' })),
    });
    expect(out).toMatchObject({
      release_required: 'true',
      offer_reason: 'behind',
      target_sha: fx.owed,
    });
    expect(stdout).toContain('ENGINE RELEASE STILL OWED');
  });

  it('NEGATIVE: offers nothing when production already holds the newest engine commit', () => {
    const fx = fixture();
    for (const served of [fx.owed, fx.after]) {
      const { out } = detect(fx, {
        healthUrl: health(fx.cwd, JSON.stringify({ releaseSha: served })),
      });
      expect(out).toMatchObject({ release_required: 'false', offer_reason: 'current' });
    }
  });

  it('NEGATIVE: an unreadable, malformed or foreign live identity is UNKNOWN and offers nothing', () => {
    const fx = fixture();
    const foreign = 'f'.repeat(40);
    for (const url of [
      undefined, // no health URL at all
      `file://${join(fx.cwd, 'does-not-exist.json')}`,
      health(fx.cwd, 'not json'),
      health(fx.cwd, JSON.stringify({ releaseSha: 'abc123' })),
      health(fx.cwd, JSON.stringify({ releaseSha: foreign })),
    ]) {
      const { out, stdout } = detect(fx, { healthUrl: url });
      expect(out).toMatchObject({ release_required: 'false', offer_reason: 'unknown' });
      expect(stdout).toContain('LIVE ENGINE RELEASE UNKNOWN');
    }
  });

  it('keeps the original path: a push that changes engine code is sent without asking production', () => {
    const fx = fixture();
    const engineBefore = fx.after;
    const engineAfter = fx.commit('server/src/GameServer.ts', 'newer');
    const { out } = detect(fx, {
      before: engineBefore,
      after: engineAfter,
      healthUrl: `file://${join(fx.cwd, 'never-read.json')}`,
    });
    expect(out).toMatchObject({
      release_required: 'true',
      offer_reason: 'changed',
      target_sha: engineAfter,
    });
  });

  it('judges "behind" by containment over the same engine paths the receiver uses', () => {
    const source = readFileSync(workflowPath, 'utf8');
    for (const p of SERVER_PATHS) expect(source).toContain(`'${p}'`);
    expect(source).toContain('git merge-base --is-ancestor "$LATEST_REQUIRED" "$LIVE_SHA"');
    expect(source).toContain('git merge-base --is-ancestor "$LIVE_SHA" "$AFTER_SHA"');
  });
});

describe('the offer: one per window, never racing a receiver', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const run = (id: number, forSha: string, status: string, createdMinutesAgo: number) => ({
    id,
    status,
    display_title: `Engine Release ${forSha}`,
    created_at: minutesAgo(createdMinutesAgo),
  });

  it('offers an owed release that no receiver is holding', () => {
    const none = decide({ reason: 'behind', sha });
    expect(none.status, none.stderr).toBe(0);
    expect(none.output).toContain('send=true');

    const stale = decide({
      reason: 'behind',
      sha,
      runs: { workflow_runs: [run(1, sha, 'completed', 80)] },
    });
    expect(stale.output).toContain('send=true');

    // A running receiver for a DIFFERENT (older) target does not hold this one.
    const olderInFlight = decide({
      reason: 'behind',
      sha,
      runs: { workflow_runs: [run(2, other, 'in_progress', 5)] },
    });
    expect(olderInFlight.output).toContain('send=true');
  });

  it('NEGATIVE: never offers while a receiver for the same SHA is queued or running', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const r = decide({
        reason: 'behind',
        sha,
        runs: { workflow_runs: [run(7, sha, 'completed', 200), run(9, sha, status, 120)] },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.output).toContain('send=false');
      expect(r.stdout).toContain('receiver run 9 is already offering it');
    }
  });

  it('NEGATIVE: never offers the same SHA twice inside the offer interval', () => {
    const r = decide({
      reason: 'behind',
      sha,
      runs: { workflow_runs: [run(3, sha, 'completed', 10)] },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain('send=false');
    expect(Number(offer.env.OFFER_INTERVAL_SECONDS)).toBeGreaterThanOrEqual(30 * 60);
    expect(Number(offer.env.OFFER_INTERVAL_SECONDS)).toBeLessThan(60 * 60);
  });

  it('a push that changed engine code is sent without reading the lane', () => {
    const r = decide({ reason: 'changed', sha, ghFails: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain('send=true');
    expect(r.ghCalls).toBe('');
  });

  it('NEGATIVE: an unreadable run list fails loudly instead of guessing the lane is empty', () => {
    const r = decide({ reason: 'behind', sha, ghFails: true });
    expect(r.status).not.toBe(0);
    expect(r.output).not.toContain('send=');
  });
});

describe('the offer is the existing release, not a second publisher', () => {
  const workflows = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));
  const code = (f: string) =>
    readFileSync(join(root, '.github/workflows', f), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('exactly one workflow sends the engine release event, and exactly one receives it', () => {
    const senders = workflows.filter((f) => /event_type=deploy-club-arena-engine/.test(code(f)));
    expect(senders).toEqual(['stage-engine-release.yml']);
    const receivers = workflows.filter((f) => /types: \[deploy-club-arena-engine\]/.test(code(f)));
    expect(receivers).toEqual(['auto-deploy-hetzner.yml']);
  });

  it('is driven by protected-main pushes only: no timer, no chain off a finished release', () => {
    expect(Object.keys(stage.on)).toEqual(['push']);
    expect(stage.on.push.branches).toEqual(['main']);
    expect(stage.jobs.detect.permissions).toEqual({ contents: 'read' });
  });

  it('gates the one dispatch step on the offer decision, and the detector feeds it', () => {
    const send = stage.jobs.signal.steps.find((s: { name: string }) =>
      /Send the immutable engine release request/.test(s.name)
    );
    expect(send.if).toBe("steps.offer.outputs.send == 'true'");
    expect(offer.env.OFFER_REASON).toBe('${{ needs.detect.outputs.offer_reason }}');
    expect(stage.jobs.detect.outputs.offer_reason).toBe('${{ steps.change.outputs.offer_reason }}');
    expect(detector.env.ENGINE_HEALTH_URL).toBe('https://engine.smarter.poker/health');
  });
});
