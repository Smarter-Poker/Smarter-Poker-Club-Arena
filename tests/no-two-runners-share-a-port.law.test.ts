/**
 * LAW: no E2E surface binds a port that another runner could be holding.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04, from a red required check on a pull request whose diff
 * could not have caused it:
 *
 *   Error: http://127.0.0.1:5188/hub/club-arena/ is already used, make sure
 *   that nothing is running on the port/url or set reuseExistingServer:true
 *
 * Three Playwright surfaces bound FIXED ports - 4173 (the CSS Beat preview),
 * 5188 (Table Studio) and 5189 (financial decisions). That was safe while
 * those jobs ran on GitHub-hosted runners, because each job got a private VM.
 * It stopped being safe the hour CI moved onto the estate: three 16-core boxes
 * with TWELVE runners each, sharing one network namespace. At this push rate
 * two pull requests reaching the same step together is the normal case, not a
 * race - and CSS Beat E2E is the critical path, so the flake it produces costs
 * a full re-run of the slowest job in the pipeline.
 *
 * THE OBVIOUS FIX IS THE DANGEROUS ONE. The error itself suggests
 * `reuseExistingServer: true`. That would make one pull request's specs run
 * against ANOTHER pull request's build, silently, and pass. The customization
 * config already carried a comment warning about exactly that outcome. This
 * law pins the safe fix instead: a unique port per runner
 * (`scripts/ci/e2e-port.mjs`), never a shared one.
 *
 * The general form of the mistake is worth naming, because this estate keeps
 * making it: A NUMBER TUNED TO ONE MACHINE OUTLIVES THAT MACHINE. The 8-core
 * concurrency caps became the bottleneck the hour the boxes became 16-core,
 * and these ports became a flake the hour twelve runners started sharing a
 * host. Derive from the environment; do not write the number down.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { portFor } from '../scripts/ci/e2e-port.mjs';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PLAYWRIGHT_CONFIGS = readdirSync(ROOT).filter((f) => /^playwright.*\.config\.ts$/.test(f));

/**
 * A config only matters here if it STARTS A SERVER IN CI. `playwright.config.ts`
 * wraps its `webServer` in `...(isCI ? {} : { ... })` - in CI those specs run
 * against BASE_URL (production, or the preview the workflow started), and the
 * block below it is a local `npm run dev` convenience. Its
 * `reuseExistingServer: true` on 5173 is correct for that: a developer with a
 * dev server already open should not have a second one fought over.
 *
 * The distinction is the whole point, so it is encoded rather than hardcoded
 * as an exemption list: reusing a server is fine when the only other candidate
 * is YOUR OWN dev server, and never fine when eleven other runners on the box
 * could have started one.
 */
function startsAServerInCI(code: string): boolean {
  if (!/webServer\s*:/.test(code)) return false;
  return !/isCI\s*\?\s*\{\}/.test(code);
}

describe('no two runners share a port', () => {
  it('there is at least one Playwright config to check', () => {
    expect(PLAYWRIGHT_CONFIGS.length).toBeGreaterThan(0);
  });

  it('no CI Playwright config hardcodes a port', () => {
    let checked = 0;
    for (const file of PLAYWRIGHT_CONFIGS) {
      const code = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (!startsAServerInCI(code)) continue;
      expect(code, `${file} must derive its port from scripts/ci/e2e-port.mjs`).toContain(
        'portFor'
      );
      expect(code, `${file} still binds a literal port`).not.toMatch(
        /--port\s+\d{4}|127\.0\.0\.1:\d{4}(?!\$)/
      );
      checked++;
    }
    expect(checked, 'no CI-starting Playwright config was checked').toBeGreaterThan(0);
  });

  it('no CI Playwright config reuses a server it did not start', () => {
    let checked = 0;
    for (const file of PLAYWRIGHT_CONFIGS) {
      // Comments stripped: the configs EXPLAIN in prose why
      // `reuseExistingServer: true` is the wrong fix here, and a law that
      // cannot tell a comment from code forbids its own explanation.
      const code = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (!startsAServerInCI(code)) continue;
      checked++;
      // reuseExistingServer:true on a shared host means running THIS branch's
      // specs against ANOTHER branch's build, silently, and passing. It is the
      // fix the "port is already used" error suggests, and it is the one thing
      // that must never be done in a job that shares a box.
      expect(code, `${file} must not reuse another job's server`).not.toMatch(
        /reuseExistingServer:\s*true/
      );
    }
    // If this ever drops to zero, the rule above is checking nothing and would
    // pass on an empty repo. That is the shape of guard this estate keeps
    // catching: sixteen invariants that printed "all passed" and ran none.
    expect(checked, 'no CI-starting Playwright config was checked').toBeGreaterThan(0);
  });

  it('the workflow computes the preview port instead of writing it down', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('scripts/ci/e2e-port.mjs');
    // The beats job's preview, its readiness poll and the two base URLs all
    // have to use the same computed value, or the server and the specs end up
    // on different ports and the job hangs until it times out.
    expect(ci).not.toMatch(/127\.0\.0\.1:4173/);
    expect(ci).not.toMatch(/--port 4173/);
  });

  it('route-performance starts its own preview on a per-runner port', () => {
    const src = read('scripts/ci/route-performance.mjs');
    expect(src).toContain('portFor(4173)');
    expect(src).not.toMatch(/const PORT = 4173/);
  });

  it('two runners get two ports, and two bases never collide', () => {
    const a = { ...process.env, RUNNER_NAME: 'estate-ci-eu3-3' };
    const b = { ...process.env, RUNNER_NAME: 'estate-ci-eu3-7' };
    const withEnv = <T>(env: NodeJS.ProcessEnv, fn: () => T): T => {
      const saved = process.env;
      process.env = env;
      try {
        return fn();
      } finally {
        process.env = saved;
      }
    };
    const a4173 = withEnv(a, () => portFor(4173));
    const b4173 = withEnv(b, () => portFor(4173));
    expect(a4173).not.toBe(b4173);

    // Offsets are multiples of 10, so bases one apart stay one apart. If that
    // ever stops being true, Table Studio and the financial-decisions harness
    // can be mapped onto the same port on some runner and collide with
    // themselves - a flake that would appear on one box and nowhere else.
    for (const name of ['a', 'b', 'estate-ci-eu1-11', 'estate-ci-1-2', 'runner-xyz']) {
      const env = { ...process.env, RUNNER_NAME: name };
      expect(withEnv(env, () => portFor(5189)) - withEnv(env, () => portFor(5188))).toBe(1);
    }
  });

  it('a developer with no RUNNER_NAME gets the base port unchanged', () => {
    const saved = process.env;
    process.env = { ...process.env };
    delete process.env.RUNNER_NAME;
    delete process.env.CA_E2E_PORT_OFFSET;
    try {
      expect(portFor(4173)).toBe(4173);
      expect(portFor(5188)).toBe(5188);
    } finally {
      process.env = saved;
    }
  });
});
