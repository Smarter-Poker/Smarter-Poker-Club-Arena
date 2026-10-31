import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  classifyTrustedLineage,
  classifyReleaseWindow,
  classifyBracket,
  UNKNOWN_EXIT_CODE,
  readBuildInfoSha,
  requireUnchangedBuildInfoSha,
  requireReadyEngineSha,
  readReadyEngineSha,
} from '../scripts/ci/production-e2e-provenance.mjs';
import { readEngineRelease } from '../scripts/ci/read-engine-release.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const CLI = resolve(process.cwd(), 'scripts/ci/production-e2e-provenance.mjs');

// Exact metadata shape from publisher 35288647065: its selected artifact is
// newer than the workflow trigger. Neither field is interchangeable.
const SOURCE_RUN = '35288647065';
const REPOSITORY_ID = '1132369872';
const TRIGGER = '4dc07c7f661803d4a496bd51bf077c8503d60236';
const SELECTED = '414c12e1654fcd6615bce292590f83d7dc3c18c9';
const selectedArtifact = () => ({
  id: 10525666396,
  name: `club-arena-dist-${SELECTED}`,
  expired: false,
  workflow_run: {
    id: Number(SOURCE_RUN),
    head_sha: TRIGGER,
    head_branch: 'main',
    repository_id: Number(REPOSITORY_ID),
    head_repository_id: Number(REPOSITORY_ID),
  },
});
const artifactPayload = () => ({ total_count: 1, artifacts: [selectedArtifact()] });
const selectArtifact = (payload: unknown, args = [SOURCE_RUN, TRIGGER, REPOSITORY_ID]) =>
  spawnSync(process.execPath, [CLI, 'publisher-artifact', ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });

describe('the publisher hands its selected artifact to post-deploy verification', () => {
  it('returns the exact same-run selected SHA instead of the older trigger SHA', () => {
    const result = selectArtifact(artifactPayload());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(SELECTED);
    expect(result.stdout.trim()).not.toBe(TRIGGER);
  });

  it('allows unrelated same-run reports without choosing them as the client bundle', () => {
    const payload = artifactPayload();
    payload.total_count = 2;
    payload.artifacts.push({ ...selectedArtifact(), name: 'browser-report' });
    expect(selectArtifact(payload).stdout.trim()).toBe(SELECTED);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an unreadable API response', { message: 'Resource not accessible by integration' }],
    ['missing bundle', { total_count: 0, artifacts: [] }],
    ['incomplete pagination', { total_count: 2, artifacts: [selectedArtifact()] }],
    ['duplicate bundles', { total_count: 2, artifacts: [selectedArtifact(), selectedArtifact()] }],
  ])('refuses %s without substituting the trigger or current live revision', (_name, payload) => {
    const result = selectArtifact(payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    [
      'expired bundle',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.expired = true;
      },
    ],
    [
      'malformed artifact SHA',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.name = 'club-arena-dist-414c12e';
      },
    ],
    [
      'different run',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.id += 1;
      },
    ],
    [
      'different trigger',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_sha = A;
      },
    ],
    [
      'PR validation branch',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_branch = 'feature/pr';
      },
    ],
    [
      'different repository',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.repository_id += 1;
      },
    ],
    [
      'fork source',
      (a: ReturnType<typeof selectedArtifact>) => {
        a.workflow_run.head_repository_id += 1;
      },
    ],
  ])('refuses %s', (_name, mutate) => {
    const payload = artifactPayload();
    mutate(payload.artifacts[0]);
    const result = selectArtifact(payload);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('requires exact expected run, trigger and repository arguments', () => {
    for (const args of [
      ['', TRIGGER, REPOSITORY_ID],
      [SOURCE_RUN, '4dc07c7', REPOSITORY_ID],
      [SOURCE_RUN, TRIGGER, ''],
    ]) {
      expect(selectArtifact(artifactPayload(), args).status).not.toBe(0);
    }
  });

  it('passes only source-run artifact metadata through the existing publication gate', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const gate = workflow.slice(
      workflow.indexOf('  publication-gate:'),
      workflow.indexOf('  seo-contract:')
    );
    expect(gate).toContain('client_target_sha: ${{ steps.client-target.outputs.sha }}');
    // A stood-down publisher has no client artifact to resolve.
    expect(gate).toContain(
      "if: github.event_name == 'workflow_run' && steps.origin.outputs.should_run == 'true'"
    );
    expect(gate).toContain('actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100');
    expect(gate).toContain(
      'publisher-artifact "$SOURCE_RUN_ID" "$SOURCE_TRIGGER_SHA" "$REPOSITORY_ID"'
    );
    expect(gate).toContain('SOURCE_TRIGGER_SHA: ${{ github.event.workflow_run.head_sha }}');
    expect(gate).toContain('REPOSITORY_ID: ${{ github.repository_id }}');
    expect(gate).not.toContain('continue-on-error');
  });
});

describe('production E2E uses exact trusted provenance', () => {
  it('waits for maintenance and resume waves before creating live-table fixtures', () => {
    const full = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const live = full.slice(full.indexOf('  live-table-e2e:'));
    const wait = live.indexOf('- name: Wait for the same engine to resume gameplay');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(live.indexOf('- name: Provision an isolated production E2E account'));
    expect(
      live.slice(wait, live.indexOf('- name: Provision an isolated production E2E account'))
    ).toContain('node scripts/ci/await-engine-gameplay.mjs "$EXPECTED_ENGINE_SHA"');
    expect(full.slice(0, full.indexOf('  live-table-e2e:'))).not.toContain('await-engine-gameplay');
  });

  it('admits only the exact running engine before browser fixture creation', () => {
    expect(
      requireReadyEngineSha(JSON.stringify({ releaseSha: A, running: true, liveness: 'ok' }), A)
    ).toBe(A);
  });

  it.each([
    ['an old engine', { releaseSha: B, running: true, liveness: 'ok' }],
    ['a stopped engine', { releaseSha: A, running: false, liveness: 'ok' }],
    ['coerced readiness', { releaseSha: A, running: 'true', liveness: 'ok' }],
    ['failed liveness', { releaseSha: A, running: true, liveness: 'stalled' }],
    ['a short engine SHA', { releaseSha: 'abc1234', running: true, liveness: 'ok' }],
    ['a missing engine SHA', { running: true, liveness: 'ok' }],
    ['an array', [{ releaseSha: A, running: true, liveness: 'ok' }]],
  ])('refuses %s as a certification prerequisite', (_label, value) => {
    expect(() => requireReadyEngineSha(JSON.stringify(value), A)).toThrow();
  });

  it('rejects malformed engine health and expected identity', () => {
    expect(() => requireReadyEngineSha('{', A)).toThrow();
    expect(() => requireReadyEngineSha('{}', 'abc1234')).toThrow();
  });

  it('keeps the exact engine prerequisite in its own job before its browser fixtures', () => {
    const fullWorkflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
      'utf8'
    );
    const workflow = fullWorkflow.slice(fullWorkflow.indexOf('  live-table-e2e:'));
    const gate = workflow.indexOf(
      '- name: Require the exact engine before opening production browser fixtures'
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(workflow.indexOf('- name: Install Chromium and WebKit'));
    expect(gate).toBeLessThan(
      workflow.indexOf('- name: Provision an isolated production E2E account')
    );
    const stanza = workflow.slice(gate, workflow.indexOf('- name: Install Chromium and WebKit'));
    expect(stanza).toContain('set -euo pipefail');
    // The read waits through the engine's own announced :55 restart instead of
    // calling a scheduled 502 a production failure (run 36717851302), but the
    // gate it feeds is still an exact equality that the job cannot pass past.
    expect(stanza).toContain('scripts/ci/read-engine-release.mjs');
    expect(stanza).toContain('[ "$READY_SHA" = "$EXPECTED_ENGINE_SHA" ]');
    expect(stanza).toContain('exit 1');
    expect(stanza).not.toContain('continue-on-error');
    expect(stanza).not.toContain('|| true');
  });

  it('records the healthy serving engine without substituting an unshipped main commit', () => {
    expect(
      readReadyEngineSha(JSON.stringify({ releaseSha: B, running: true, liveness: 'ok' }))
    ).toBe(B);
    for (const value of [
      { releaseSha: B, running: false, liveness: 'ok' },
      { releaseSha: 'abc123', running: true, liveness: 'ok' },
      { releaseSha: B, running: true, liveness: 'bad' },
    ]) {
      expect(() => readReadyEngineSha(JSON.stringify(value))).toThrow();
    }
  });

  it('uses the same exact engine parser from the workflow CLI', () => {
    const run = (sha: string) =>
      spawnSync(process.execPath, [CLI, 'engine-ready', A], {
        input: JSON.stringify({ releaseSha: sha, running: true, liveness: 'ok' }),
        encoding: 'utf8',
      });
    expect(run(A).status).toBe(0);
    expect(run(B).status).not.toBe(0);
  });

  it('reads one full lowercase SHA from a JSON object', () => {
    expect(readBuildInfoSha(JSON.stringify({ ca_sha: A }))).toBe(A);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an array', JSON.stringify([{ ca_sha: A }])],
    ['a missing field', JSON.stringify({ sha: A })],
    ['a short SHA', JSON.stringify({ ca_sha: 'abc1234' })],
    ['an uppercase SHA', JSON.stringify({ ca_sha: 'A'.repeat(40) })],
    ['a decorated SHA', JSON.stringify({ ca_sha: `${A}x` })],
  ])('rejects %s', (_label, raw) => {
    expect(() => readBuildInfoSha(raw)).toThrow();
  });

  it('accepts a final build-info document only when production stayed on the recorded SHA', () => {
    expect(requireUnchangedBuildInfoSha(JSON.stringify({ ca_sha: A }), A)).toBe(A);
  });

  it.each([
    ['malformed final build-info', '{'],
    ['a changed final SHA', JSON.stringify({ ca_sha: B })],
  ])('rejects %s so a moving or unreadable release cannot pass', (_label, raw) => {
    expect(() => requireUnchangedBuildInfoSha(raw, A)).toThrow();
  });

  it('rejects a malformed expected SHA instead of weakening the final comparison', () => {
    expect(() => requireUnchangedBuildInfoSha(JSON.stringify({ ca_sha: A }), 'abc1234')).toThrow();
  });

  it('makes the exact workflow CLI reject malformed or changed HTTP bodies', () => {
    const run = (raw: string) =>
      spawnSync(process.execPath, [CLI, 'unchanged', A], { input: raw, encoding: 'utf8' });

    const exact = run(JSON.stringify({ ca_sha: A }));
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout.trim()).toBe(A);
    expect(run(`not-json "ca_sha": "${A}"`).status).not.toBe(0);
    expect(run(JSON.stringify({ ca_sha: B })).status).not.toBe(0);
  });

  it('accepts an identical live and checkout commit without guessing', () => {
    const commitExists = vi.fn();
    const isAncestor = vi.fn();
    expect(classifyTrustedLineage(A, A, { commitExists, isAncestor })).toBe('same');
    expect(commitExists).not.toHaveBeenCalled();
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('accepts a known live ancestor', () => {
    expect(
      classifyTrustedLineage(A, B, {
        commitExists: () => true,
        isAncestor: () => true,
      })
    ).toBe('ancestor');
  });

  it('rejects an unknown production SHA', () => {
    expect(() =>
      classifyTrustedLineage(A, B, {
        commitExists: () => false,
        isAncestor: () => true,
      })
    ).toThrow('does not resolve');
  });

  // 2026-09-30. Production being AHEAD of the checkout used to land here and
  // read `is not an ancestor`, which was true and useless: it is the ordinary
  // shape of a repository whose publisher fires on every merge. Run
  // 36673263757 died on it. It is now its own lineage, and the caller
  // re-targets the suite onto the live commit instead of refusing.
  it('names a live commit that is AHEAD of the checkout as a forward release', () => {
    expect(
      classifyTrustedLineage(A, B, {
        commitExists: () => true,
        isAncestor: (ancestor) => ancestor === B,
      })
    ).toBe('descendant');
  });

  it('still rejects a production SHA that shares no lineage with the checkout', () => {
    expect(() =>
      classifyTrustedLineage(A, B, {
        commitExists: () => true,
        isAncestor: () => false,
      })
    ).toThrow('shares no lineage');
  });

  it('certifies a release window that never left the recorded SHA', () => {
    expect(
      classifyReleaseWindow(JSON.stringify({ ca_sha: A }), A, {
        commitExists: () => true,
        isAncestor: () => true,
      })
    ).toEqual({ verdict: 'certified', sha: A });
  });

  // A forward publish during forty minutes of browsers is a NON-VERDICT, not a
  // defect report. Twelve of the twenty runs sampled on 2026-09-30 were red
  // for this and nothing else.
  it('calls a forward publish during certification superseded, not failed', () => {
    expect(
      classifyReleaseWindow(JSON.stringify({ ca_sha: B }), A, {
        commitExists: () => true,
        isAncestor: (ancestor, descendant) => ancestor === A && descendant === B,
      })
    ).toEqual({ verdict: 'superseded', sha: B });
  });

  it.each([
    [
      'a rollback or an off-lineage release',
      { commitExists: () => true, isAncestor: () => false },
      'not a forward release',
    ],
    [
      'a release that resolves to no trusted commit',
      { commitExists: () => false, isAncestor: () => true },
      'does not resolve',
    ],
  ])('still refuses %s outright', (_label, evidence, message) => {
    expect(() => classifyReleaseWindow(JSON.stringify({ ca_sha: B }), A, evidence)).toThrow(
      message
    );
  });

  // CLAUDE.md 10.86 rule 1: UNKNOWN gets its own code. Sharing one with GREEN
  // would certify a run that could not tell; sharing one with a real anomaly
  // would put a rollback and an ordinary publish in the same bucket again.
  // THE ENGINE'S OWN :55 RESTART IS NOT A PRODUCTION FAILURE.
  //
  // Run 36717851302 started at 12:54:24Z and died 72 seconds later on a bare
  // `curl: (22) The requested URL returned error: 502` from an engine that was
  // keeping the maintenance schedule CLAUDE.md section 13 sets for it. These
  // pin the three outcomes the reader must keep apart, and in particular that
  // an answer it CAN read is never polled past.
  describe('reading the engine release through its announced break', () => {
    const healthy = JSON.stringify({ releaseSha: A, running: true, liveness: 'ok' });

    it('waits through a scheduled restart and returns the release that comes back', async () => {
      let clock = 0;
      let attempts = 0;
      const result = await readEngineRelease('https://engine.invalid/health', {
        now: () => clock,
        pollMs: 0,
        budgetMs: 60_000,
        fetchImpl: async () => {
          attempts += 1;
          clock += 5_000;
          if (attempts < 3) return { ok: false, status: 502 };
          return { ok: true, text: async () => healthy };
        },
      });
      expect(result).toEqual({ verdict: 'ready', sha: A });
      expect(attempts).toBe(3);
    });

    it('calls a permanently silent engine UNKNOWN rather than healthy or broken', async () => {
      let clock = 0;
      const result = await readEngineRelease('https://engine.invalid/health', {
        now: () => clock,
        pollMs: 0,
        budgetMs: 30_000,
        fetchImpl: async () => {
          clock += 5_000;
          return { ok: false, status: 502 };
        },
      });
      expect(result.verdict).toBe('unknown');
      expect(result.reason).toContain('502');
    });

    // 10.86 rule 2: an answer that arrived is a verdict, and an unhealthy one
    // must never be retried until the engine happens to agree with us.
    it('refuses an engine that answers, but not with one healthy release', async () => {
      let calls = 0;
      await expect(
        readEngineRelease('https://engine.invalid/health', {
          now: () => 0,
          pollMs: 0,
          budgetMs: 600_000,
          fetchImpl: async () => {
            calls += 1;
            return {
              ok: true,
              text: async () => JSON.stringify({ releaseSha: A, running: false, liveness: 'ok' }),
            };
          },
        })
      ).rejects.toThrow('not running with healthy liveness');
      expect(calls).toBe(1);
    });
  });

  it('gives UNKNOWN an exit code of its own, distinct from certified and from error', () => {
    expect(UNKNOWN_EXIT_CODE).toBe(3);
    const run = (raw: string) =>
      spawnSync(process.execPath, [CLI, 'release-window', A], { input: raw, encoding: 'utf8' });

    const certified = run(JSON.stringify({ ca_sha: A }));
    expect(certified.status, certified.stderr).toBe(0);
    expect(certified.stdout.trim()).toBe(`certified ${A}`);

    // `B` is not a real commit in this repository, so the CLI's git evidence
    // refuses it as unresolvable - a 1, never a 3 and never a 0.
    expect(run(JSON.stringify({ ca_sha: B })).status).toBe(1);
    expect(run('not-json').status).toBe(1);
  });

  // 2026-10-07. The seal's client evidence is a bracket around its own three
  // journeys, not the whole forty-minute job. Both passing client lanes of
  // 2026-10-06/07 (37587015087, 37598789558) ended `superseded` on the whole
  // window, so the seal was never owed.
  describe('the release bracket around one group of suites', () => {
    const doc = (sha: string) => JSON.stringify({ ca_sha: sha });
    const C = 'c'.repeat(40);
    const forward = {
      commitExists: () => true,
      isAncestor: (ancestor: string, descendant: string) =>
        (ancestor === A && (descendant === B || descendant === C)) ||
        (ancestor === B && descendant === C),
    };
    const unused = {
      commitExists: () => {
        throw new Error('certifying both reads of the recorded SHA must not need history');
      },
      isAncestor: () => {
        throw new Error('certifying both reads of the recorded SHA must not need history');
      },
    };

    it('certifies only the SHA the run recorded, read on both sides of the group', () => {
      expect(classifyBracket(doc(A), doc(A), A, unused)).toEqual({ verdict: 'certified', sha: A });
    });

    // Never certify a commit that was not tested: the specs came from A, so a
    // group that met B on either side certifies neither A nor B.
    it.each([
      ['closed on a later release', A, B],
      ['opened on a later release', B, B],
      ['moved forward twice inside the group', B, C],
    ])('calls a group that %s superseded, never certified', (_label, before, after) => {
      expect(classifyBracket(doc(before), doc(after), A, forward)).toEqual({
        verdict: 'superseded',
        sha: after,
      });
    });

    it.each([
      ['a missing opening read', '', doc(A)],
      ['a missing closing read', doc(A), ''],
      ['an unreadable document', 'not-json', doc(A)],
      ['a document without one full ca_sha', JSON.stringify({ ca_sha: 'abc' }), doc(A)],
    ])('calls %s COULD NOT TELL, never certified', (_label, before, after) => {
      expect(classifyBracket(before, after, A, forward)).toEqual({ verdict: 'unknown', sha: null });
    });

    it.each([
      [
        'a rollback before the expected release',
        { commitExists: () => true, isAncestor: () => false },
        'not a forward release',
      ],
      [
        'a commit that does not resolve',
        { commitExists: () => false, isAncestor: () => true },
        'does not resolve',
      ],
    ])('still refuses %s outright', (_label, evidence, message) => {
      expect(() => classifyBracket(doc(A), doc(B), A, evidence)).toThrow(message);
    });

    it('refuses a bracket that moved backwards inside itself', () => {
      expect(() => classifyBracket(doc(C), doc(B), A, forward)).toThrow('inside one bracket');
    });

    it('gives the CLI the same three exit codes, and reads a file that was never written as unknown', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-bracket-'));
      try {
        const before = join(dir, 'before.json');
        const after = join(dir, 'after.json');
        const run = () =>
          spawnSync(process.execPath, [CLI, 'bracket', A, before, after], { encoding: 'utf8' });
        writeFileSync(before, doc(A));
        writeFileSync(after, doc(A));
        const certified = run();
        expect(certified.status, certified.stderr).toBe(0);
        expect(certified.stdout.trim()).toBe(`certified ${A}`);
        rmSync(after);
        const unknown = run();
        expect(unknown.status).toBe(UNKNOWN_EXIT_CODE);
        expect(unknown.stdout.trim()).toBe('unknown unreadable');
        // B is no commit in this repository: an anomaly, never a non-verdict.
        writeFileSync(after, doc(B));
        expect(run().status).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// Run 38170604116 (2026-10-11): a retaining publisher's certificate started
// its browsers 48 minutes after the publish, production had moved three
// protected-main commits forward, and a bare `test "$LIVE" = <retained>` sent
// the whole client lane red before one page was opened. A later release is a
// thing to align with, not a defect; only a non-forward move stays red.
describe('a retained runtime superseded before the browsers start', () => {
  const STEP = '- name: Take the specs from the commit production is actually serving';
  const workflow = readFileSync(
    resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
    'utf8'
  );
  const alignSteps = (): string[] => {
    const out: string[] = [];
    let at = workflow.indexOf(STEP);
    while (at >= 0) {
      const body = workflow.slice(at, workflow.indexOf('\n      - name:', at + STEP.length));
      const script = body.slice(body.indexOf('run: |') + 'run: |'.length);
      out.push(
        script
          .split('\n')
          .map((line) => line.replace(/^ {10}/, ''))
          .join('\n')
      );
      at = workflow.indexOf(STEP, at + STEP.length);
    }
    return out;
  };

  it('is present in both browser lanes, with no bare equality against the retained runtime', () => {
    const steps = alignSteps();
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step).not.toContain(
        'test "$LIVE" = \'${{ needs.publication-gate.outputs.client_target_sha }}\''
      );
      expect(step).toContain('git merge-base --is-ancestor "$RETAINED" "$LIVE"');
    }
  });

  // A git hook runs this suite with GIT_DIR, GIT_INDEX_FILE and friends set
  // for the repository being pushed. The fixture must never inherit them.
  const isolatedEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const name of spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .stdout.trim()
      .split(/\s+/))
      delete env[name];
    return env;
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...isolatedEnv(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const commit = (cwd: string, label: string) => {
    writeFileSync(join(cwd, 'tests/e2e/spec.txt'), label);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', label);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  const runAlign = (step: string, live: string, here: string, retained: string, cwd: string) => {
    const script = step
      .replaceAll('${{ steps.live.outputs.sha }}', live)
      .replaceAll('${{ needs.publication-gate.outputs.verification_sha }}', here)
      .replaceAll('${{ needs.publication-gate.outputs.client_target_sha }}', retained)
      .replace(/\$\{\{[^}]*\}\}/g, 'x')
      .replaceAll('node scripts/ci/production-e2e-provenance.mjs', `node ${CLI}`)
      .replaceAll('node scripts/ci/client-runtime-retention.mjs harness', 'true');
    const output = join(cwd, '..', 'output');
    const summary = join(cwd, '..', 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: { ...isolatedEnv(), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    return { ...r, output: readFileSync(output, 'utf8') };
  };

  it('aligns client fixture source and artwork with both older and newer page assertions', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-fixture-source-'));
    const repo = join(root, 'repo');
    try {
      for (const path of ['tests/e2e/support', 'src/components/lobby', 'public/assets'])
        mkdirSync(join(repo, path), { recursive: true });
      git(repo, 'init', '-q');
      const fixtureCommit = (label: string) => {
        writeFileSync(join(repo, 'src/components/lobby/existing.css'), label);
        writeFileSync(join(repo, 'public/assets/fixture.svg'), label);
        writeFileSync(join(repo, 'tests/e2e/global-setup.ts'), label);
        writeFileSync(join(repo, 'tests/e2e/support/auth.txt'), label);
        return commit(repo, label);
      };
      const retained = fixtureCommit('retained');
      const older = fixtureCommit('older-page');
      const here = fixtureCommit('trusted-harness');
      writeFileSync(join(repo, 'src/components/lobby/LobbyFilterLabel.css'), 'new-live-label');
      const later = fixtureCommit('newer-page');
      const clientStep = alignSteps()[0];
      for (const [live, label] of [
        [older, 'older-page'],
        [later, 'newer-page'],
      ]) {
        git(repo, 'checkout', '-q', '-f', here);
        const result = runAlign(clientStep, live, here, retained, repo);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(result.output).toContain(`specs=${live}`);
        expect(readFileSync(join(repo, 'tests/e2e/spec.txt'), 'utf8')).toBe(label);
        expect(readFileSync(join(repo, 'src/components/lobby/existing.css'), 'utf8')).toBe(label);
        expect(readFileSync(join(repo, 'public/assets/fixture.svg'), 'utf8')).toBe(label);
        const expectedHarness = live === older ? 'trusted-harness' : label;
        expect(readFileSync(join(repo, 'tests/e2e/global-setup.ts'), 'utf8')).toBe(expectedHarness);
        expect(readFileSync(join(repo, 'tests/e2e/support/auth.txt'), 'utf8')).toBe(
          expectedHarness
        );
        if (live === later)
          expect(
            readFileSync(join(repo, 'src/components/lobby/LobbyFilterLabel.css'), 'utf8')
          ).toBe('new-live-label');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // Isolated SSD runs on 2026-10-12 took 5.3-7.4 seconds. Keep all assertions
  // and allow bounded headroom for Git/filesystem work, rather than timing out
  // after the check already completed its synchronous work.
  it('aligns with a forward release, keeps the exact retained path, and refuses a rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'retained-superseded-'));
    const repo = join(root, 'repo');
    try {
      spawnSync('mkdir', ['-p', join(repo, 'tests/e2e'), join(repo, 'src'), join(repo, 'public')]);
      writeFileSync(join(repo, 'src/fixture.css'), 'source');
      writeFileSync(join(repo, 'public/fixture.svg'), 'art');
      git(repo, 'init', '-q');
      const before = commit(repo, 'before');
      const retained = commit(repo, 'retained');
      const here = commit(repo, 'verification');
      const later = commit(repo, 'later');
      git(repo, 'checkout', '-q', here);

      for (const step of alignSteps()) {
        const forward = runAlign(step, later, here, retained, repo);
        expect(forward.status, forward.stderr + forward.stdout).toBe(0);
        expect(forward.output).toContain(`specs=${later}`);
        git(repo, 'checkout', '-q', here, '--', 'tests/e2e');

        const exact = runAlign(step, retained, here, retained, repo);
        expect(exact.status, exact.stderr + exact.stdout).toBe(0);
        expect(exact.output).toContain(`specs=${here}`);

        const rollback = runAlign(step, before, here, retained, repo);
        expect(rollback.status).toBe(1);
        expect(rollback.stdout).toContain('not a forward release from retained runtime');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// Runs 38206133852 and 38244592617 (2026-10-12): the Lightning operator spec
// compared build-info.json with the SHA recorded at the start of the job and
// failed whenever production published a LATER protected-main commit while
// its browsers ran. That is could-not-tell (CLAUDE.md 10.86 rule 1). The step
// is now bracketed by two build-info reads and classified by the same
// `bracket` classifier as the Phase 1 journeys: exact verifies, a forward move
// is an UNKNOWN non-verdict, a rollback or off-lineage SHA is a named red.
describe('the Lightning operator certificate classifies a release that moved under it', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
    'utf8'
  );
  const stepBody = (name: string): string => {
    const at = workflow.indexOf(`- name: ${name}`);
    expect(at, `step "${name}" must exist`).toBeGreaterThanOrEqual(0);
    return workflow.slice(at, workflow.indexOf('\n      - name:', at + name.length));
  };
  const scriptOf = (body: string): string =>
    body
      .slice(body.indexOf('run: |') + 'run: |'.length)
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n');
  const certify = stepBody('Certify the authenticated Lightning operator cold loads');
  const classify = stepBody('Classify the release the Lightning operator certificate ran against');

  it('brackets its own browsers with two build-info reads and hands the spec no LIVE_SHA', () => {
    const before = certify.indexOf('read_release release-bracket/lightning-before.json');
    const run = certify.indexOf(
      'npx playwright test tests/e2e/production-lightning-operator.spec.ts'
    );
    const after = certify.indexOf('read_release release-bracket/lightning-after.json');
    expect(before).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(run);
    // The browser verdict is preserved through the closing read.
    expect(certify).toContain('rc=$?');
    expect(certify).toContain('exit $rc');
    expect(certify).not.toContain('LIVE_SHA');
    expect(classify).toContain('EXPECTED_LIVE_SHA: ${{ steps.live.outputs.sha }}');
    expect(classify).toContain(
      'production-e2e-provenance.mjs bracket "$EXPECTED_LIVE_SHA" \\\n            release-bracket/lightning-before.json release-bracket/lightning-after.json'
    );
  });

  it('keeps no bare SHA equality in the spec itself', () => {
    const spec = readFileSync(
      resolve(process.cwd(), 'tests/e2e/production-lightning-operator.spec.ts'),
      'utf8'
    );
    expect(spec).not.toMatch(/toBe\(\s*process\.env\.LIVE_SHA\s*\)/);
    expect(spec).not.toContain('LIVE_SHA');
  });

  // A git hook runs this suite with GIT_DIR, GIT_INDEX_FILE and friends set
  // for the repository being pushed. The fixture must never inherit them.
  const isolatedEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const name of spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .stdout.trim()
      .split(/\s+/))
      delete env[name];
    return env;
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...isolatedEnv(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const commit = (cwd: string, label: string) => {
    writeFileSync(join(cwd, 'marker.txt'), label);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', label);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  const runClassify = (cwd: string, expected: string, before: string, after: string) => {
    spawnSync('mkdir', ['-p', join(cwd, 'release-bracket')]);
    writeFileSync(
      join(cwd, 'release-bracket/lightning-before.json'),
      JSON.stringify({ ca_sha: before })
    );
    writeFileSync(
      join(cwd, 'release-bracket/lightning-after.json'),
      JSON.stringify({ ca_sha: after })
    );
    const script = scriptOf(classify)
      .replaceAll('timeout 30s git fetch --no-tags origin main', 'true')
      .replaceAll('node scripts/ci/production-e2e-provenance.mjs', `node ${CLI}`);
    const output = join(cwd, '..', 'output');
    const summary = join(cwd, '..', 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...isolatedEnv(),
        EXPECTED_LIVE_SHA: expected,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return {
      ...r,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    };
  };

  it('verifies an exact release, calls a forward publish UNKNOWN, and refuses a rollback or an off-line SHA by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'lightning-release-'));
    const repo = join(root, 'repo');
    try {
      spawnSync('mkdir', ['-p', repo]);
      git(repo, 'init', '-q');
      const earlier = commit(repo, 'earlier');
      const recorded = commit(repo, 'recorded');
      const later = commit(repo, 'later');

      const exact = runClassify(repo, recorded, recorded, recorded);
      expect(exact.status, exact.stderr + exact.stdout).toBe(0);
      expect(exact.output).toContain('certified=true');
      expect(exact.stdout).not.toContain('UNKNOWN');

      const forward = runClassify(repo, recorded, recorded, later);
      expect(forward.status, forward.stderr + forward.stdout).toBe(0);
      expect(forward.output).not.toContain('certified=true');
      expect(forward.stdout).toContain(
        `::warning::UNKNOWN: production advanced during certification (superseded ${later})`
      );
      expect(forward.summary).toContain('NON-VERDICT: production advanced from');

      const rollback = runClassify(repo, recorded, recorded, earlier);
      expect(rollback.status).toBe(1);
      expect(rollback.stdout).toContain('::error::Lightning operator release mismatch');
      expect(rollback.stderr).toContain('not a forward release');

      const offLine = runClassify(repo, recorded, recorded, 'f'.repeat(40));
      expect(offLine.status).toBe(1);
      expect(offLine.stdout).toContain('::error::Lightning operator release mismatch');
      expect(offLine.stderr).toContain('does not resolve');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
