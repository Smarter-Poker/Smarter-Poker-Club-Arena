/**
 * NO MERGE GATE WITHOUT A PRODUCER, AND NO RELEASE FREEZE (2026-09-11).
 *
 * At 12:20:32 UTC on 2026-09-11 the `main protection` ruleset gained a
 * required status check named "Stage B Release Freeze". No workflow in this
 * repository runs a job with that name, so from that second nothing could
 * merge: #4292, #4296 and #4299 sat green and blocked. Nobody authorized it.
 * Dan, 12:49 UTC: "REMOVE THE Stage B Release Freeze GLOBALLY AND DON'T BRING
 * IT BACK OR ALLOW IT TO COME BACK EVER. NOBODY AUTHORIZED THIS!" The check
 * was removed from the ruleset at 12:47:26 UTC.
 *
 * A required check that nothing produces is a merge freeze by another name.
 * This law pins, for everything this repository can do to the ruleset:
 *
 *   1. Every required check the canonical ruleset writer
 *      (scripts/ci/apply-main-ruleset.mjs) declares, and every check the live
 *      ruleset required on 2026-09-11 after the removal, is the display name of
 *      a job some workflow here actually runs.
 *   2. No required check, workflow or job is named as a freeze.
 *   3. Nothing else under .github/ or scripts/ WRITES a ruleset or a branch
 *      protection. Reading is fine (estate-integrity.sh, pr-status.mjs); only
 *      the two named writers may send PUT/POST/PATCH/DELETE there.
 *
 * What a law cannot do: a token with Administration: write can still edit the
 * ruleset by hand. That door is the token's scope, and it is the owner's call.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '..');
const WORKFLOWS = resolve(root, '.github/workflows');

/** The only files allowed to write a ruleset. Each is run by hand, on purpose. */
const RULESET_WRITERS = new Set([
  'scripts/ci/apply-main-ruleset.mjs',
  'scripts/ci/remove-world-hub-bypass.mjs',
]);

/** The live `main protection` required checks after the 12:47:26 removal. */
const LIVE_REQUIRED_CHECKS_2026_09_11 = [
  'TypeScript Check',
  'Client Unit Tests (vitest)',
  'Server Engine (typecheck + tests)',
  'Production Build',
  'CSS Beat E2E (multi-table + animations)',
  'Silent Revert Guard',
];

const FREEZE = /freeze/i;

type Workflow = { name?: unknown; jobs?: Record<string, { name?: unknown }> };

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(WORKFLOWS, f));
}

/** Workflow names and every job's display name (its `name:`, else its id). */
function producedNames(): { workflows: string[]; jobs: Set<string> } {
  const workflows: string[] = [];
  const jobs = new Set<string>();
  for (const file of workflowFiles()) {
    const doc = parse(readFileSync(file, 'utf8')) as Workflow | null;
    if (!doc) continue;
    if (typeof doc.name === 'string') workflows.push(doc.name);
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      jobs.add(typeof job?.name === 'string' ? job.name : id);
    }
  }
  return { workflows, jobs };
}

function declaredRequiredChecks(): string[] {
  const src = readFileSync(resolve(root, 'scripts/ci/apply-main-ruleset.mjs'), 'utf8');
  const m = /const\s+REQUIRED_CHECKS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('apply-main-ruleset.mjs no longer declares REQUIRED_CHECKS');
  return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || (name.startsWith('.git') && dir === root)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(m?[jt]s|cjs|sh|ya?ml|py)$/.test(name)) out.push(full);
  }
  return out;
}

/** A ruleset or branch-protection path and a write verb within 400 characters, in either order. */
const RULESET_PATH = String.raw`(rulesets|\/branches\/[^/'"\x60\s]+\/protection)`;
const WRITE_VERB = String.raw`(method:\s*['"\x60](PUT|POST|PATCH|DELETE)['"\x60]|-X\s*(PUT|POST|PATCH|DELETE)\b|--method\s+(PUT|POST|PATCH|DELETE)\b)`;
const WRITES_A_RULESET = new RegExp(
  `${RULESET_PATH}[\\s\\S]{0,400}?${WRITE_VERB}|${WRITE_VERB}[\\s\\S]{0,400}?${RULESET_PATH}`,
  'i'
);

describe('no merge gate without a producer, and no release freeze', () => {
  const { workflows, jobs } = producedNames();

  it('the canonical ruleset writer only requires checks a workflow here produces', () => {
    const declared = declaredRequiredChecks();
    expect(declared.length).toBeGreaterThan(0);
    for (const check of declared) expect(jobs, `required check "${check}"`).toContain(check);
  });

  it('every check the live ruleset required after the 12:47:26 removal still has a producer', () => {
    for (const check of LIVE_REQUIRED_CHECKS_2026_09_11) {
      expect(jobs, `live required check "${check}"`).toContain(check);
    }
  });

  it('no required check, workflow or job is a freeze', () => {
    for (const check of [...declaredRequiredChecks(), ...LIVE_REQUIRED_CHECKS_2026_09_11]) {
      expect(check).not.toMatch(FREEZE);
    }
    expect(workflows.filter((n) => FREEZE.test(n))).toEqual([]);
    expect([...jobs].filter((n) => FREEZE.test(n))).toEqual([]);
  });

  it('only the two named scripts write a ruleset or a branch protection', () => {
    const writers = [...walk(resolve(root, '.github')), ...walk(resolve(root, 'scripts'))]
      .filter((file) => WRITES_A_RULESET.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).split('\\').join('/'))
      .filter((file) => !RULESET_WRITERS.has(file));
    expect(writers).toEqual([]);
  });

  it('the pattern really catches a write and lets a read through', () => {
    expect(WRITES_A_RULESET.test("api(`/rulesets/${id}`, { method: 'PUT', body })")).toBe(true);
    expect(WRITES_A_RULESET.test('gh api -X PATCH repos/o/r/rulesets/1 --input x.json')).toBe(true);
    expect(WRITES_A_RULESET.test('gh api --method PUT repos/o/r/branches/main/protection')).toBe(
      true
    );
    expect(WRITES_A_RULESET.test('RS=$(gh_ro "repos/Smarter-Poker/$r/rulesets")')).toBe(false);
  });
});
