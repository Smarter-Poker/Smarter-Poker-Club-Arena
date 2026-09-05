/**
 * ONE BUILD, THREE SUITES — AND THE HARNESS NEVER SHIPS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Measured 2026-09-05, Club Arena push-to-live:
 *
 *   PR created -> merged        p50 6.8m
 *   ci.yml wall time            p50 6.8m   <- the same number; CI *is* the wait
 *   runner queue wait           p50 2s     <- not a capacity problem
 *   publish-club-arena.yml      p50 3.1m
 *
 * Inside that 6.8m, one job is the critical path:
 *
 *   CSS Beat E2E                p50 334s, max 420s
 *   Client Unit Tests           p50 252s
 *   Server Engine               p50 141s
 *   Production Build            p50 110s
 *   TypeScript Check            p50  99s
 *
 * And inside THAT job, on runs 8843 and 8844:
 *
 *   Build this commit                          39s / 79s
 *   Run the beats                              52s / 98s
 *   Table Studio ... gate                    141s / 200s   <- half the job
 *   Insurance and Rabbit Hunt gate             11s /  15s
 *
 * The Table Studio suite was not slow because of what it tests. It was slow
 * because it started a Vite DEV server and compiled the whole app a second
 * time, in a job that had already built the app and was already serving it.
 * The only thing standing in the way was VITE_CUSTOMIZATION_TEST_HARNESS, a
 * build-time flag gating a lazy dev route.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRADE, AND THE LINE THIS LAW HOLDS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * CI builds once WITH the harness flags and points every suite at that preview.
 * The obvious cheaper-looking alternative - making the harness a RUNTIME toggle
 * so one bundle serves everything - was rejected: it would put a switch in the
 * players' bundle that turns on internal routes, and the reason those routes
 * are gated at all is that they should not exist in production.
 *
 * So the flags stay build-time, and the safety of the whole change reduces to
 * ONE property: **the harness flags appear in the CSS Beat job and nowhere
 * else.** `Production Build` and `publish-club-arena.yml` build without them.
 * That property is what this file exists to hold. If it ever fails, the fix is
 * not to relax the assertion - it is that a throwaway CI flag has reached the
 * bundle players download.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PUBLISH = readFileSync(join(ROOT, '.github/workflows/publish-club-arena.yml'), 'utf8');

const HARNESS_FLAGS = ['VITE_CUSTOMIZATION_TEST_HARNESS', 'VITE_FINANCIAL_DECISION_TEST_HARNESS'];

/** A named job's block, from its key to the next top-level job key. */
function job(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:`);
  expect(start, `job ${name} not found - re-point this law`).toBeGreaterThan(-1);
  const next = yml.slice(start + 1).search(/\n {2}[a-z_][a-z0-9_-]*:\n/);
  return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

/** The block for one `- name:` step, up to the next step at the same indent. */
function step(yml: string, name: string): string {
  const start = yml.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" not found - re-point this law`).toBeGreaterThan(-1);
  const next = yml.indexOf('\n      - name:', start + 1);
  return next === -1 ? yml.slice(start) : yml.slice(start, next);
}

describe('the harness never reaches a bundle a player downloads', () => {
  it('the publisher builds without either harness flag', () => {
    // THE ONE PROPERTY THE WHOLE CHANGE RESTS ON. publish-club-arena.yml is
    // what rsyncs dist/ to the origin players are served from.
    for (const flag of HARNESS_FLAGS) {
      expect(
        PUBLISH,
        `${flag} appears in publish-club-arena.yml - the harness routes would ship to players`
      ).not.toMatch(new RegExp(flag));
    }
  });

  it('the flags appear only in the CSS Beat job', () => {
    // Any OTHER job setting them is either shipping them or wasting the build
    // cache on a bundle that differs from the one it is meant to verify.
    const beats = job(CI, 'css-beats-e2e');
    for (const flag of HARNESS_FLAGS) {
      const everywhere = (CI.match(new RegExp(flag, 'g')) || []).length;
      const inBeats = (beats.match(new RegExp(flag, 'g')) || []).length;
      expect(inBeats, `${flag} is not set in the css-beats-e2e job`).toBeGreaterThan(0);
      expect(
        everywhere,
        `${flag} appears ${everywhere}x in ci.yml but only ${inBeats}x in css-beats-e2e - ` +
          `a harness flag outside that job is either shipping or misleading`
      ).toBe(inBeats);
    }
  });

  it('the Production Build job does not set them', () => {
    const build = job(CI, 'build');
    for (const flag of HARNESS_FLAGS) {
      expect(build).not.toMatch(new RegExp(flag));
    }
  });
});

describe('one preview, shared, and reaped', () => {
  it('the preview is started in its own step, not inside the beats', () => {
    // Started under `trap ... EXIT` inside the beats step it died with that
    // step, which is precisely why each harness suite had to compile its own
    // copy of the app. If it moves back, the 141-200s comes back with it.
    const serve = step(CI, 'Serve one build to every suite');
    expect(serve).toMatch(/vite preview/);
    expect(serve).toMatch(/arena-preview\.pid/);
    const beats = step(CI, "Run the beats against this commit's CSS");
    expect(
      beats,
      'the beats step must not start its own preview - one build, three suites'
    ).not.toMatch(/vite preview/);
  });

  it('both harness suites point at that shared preview', () => {
    for (const name of [
      'Table Studio real-component purchase, sync, and accessibility gate',
      'Insurance and Rabbit Hunt 375px decision gate',
    ]) {
      expect(step(CI, name)).toMatch(/ARENA_SHARED_PREVIEW_URL/);
    }
  });

  it('the preview is reaped even when a suite fails', () => {
    // --strictPort means an orphan does not fall back to another port; it fails
    // every later job on this runner. The reaper is the whole reason it is safe
    // to start a server that outlives its step.
    const stop = step(CI, 'Stop the shared preview');
    expect(stop).toMatch(/if:\s*always\(\)/);
    expect(stop).toMatch(/kill/);
  });

  it('both configs still start their own server when the variable is absent', () => {
    // A developer running `npm run test:e2e:customization` locally has no
    // shared preview. The fallback is not decoration - without it this change
    // makes the suites unrunnable outside CI.
    for (const f of [
      'playwright.customization.config.ts',
      'playwright.financial-decisions.config.ts',
    ]) {
      const cfg = readFileSync(join(ROOT, f), 'utf8');
      expect(cfg).toMatch(/ARENA_SHARED_PREVIEW_URL/);
      expect(cfg, `${f} must keep its webServer fallback`).toMatch(/webServer:/);
      expect(cfg, `${f} must only skip the server when the shared preview exists`).toMatch(
        /SHARED_PREVIEW\s*\n?\s*\?\s*\{\}/
      );
    }
  });
});
