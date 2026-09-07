/**
 * A SHARED APT LOCK IS NOT A PLACE TO PUT A REQUIRED CHECK (2026-09-07).
 *
 * `npx playwright install --with-deps <browser>` does two unrelated things:
 * it downloads the browser into a per-user cache, which is safe to run
 * anywhere and any number of times, and it shells out to `apt-get` to install
 * that browser's system libraries, which takes a machine-wide lock at
 * /var/lib/apt/lists/lock.
 *
 * The estate runs 12 to 18 runners on each EU box. Two jobs reaching the apt
 * half at the same moment is ordinary rather than rare, and the loser does not
 * degrade - it exits 100:
 *
 *   E: Could not get lock /var/lib/apt/lists/lock. It is held by
 *      process 1672233 (apt-get)
 *   Failed to install browsers
 *   Error: Installation process exited with code: 100
 *
 * That is PR #3487's `Production Build`, a REQUIRED check, failing for a
 * reason that had nothing to do with the branch under review. The libraries
 * were already on the box - provision-ci-box.sh section 6 installs them once
 * and then verifies every unpacked browser resolves its shared libraries - so
 * the apt call could never have installed anything. It existed only to lose
 * a race.
 *
 * The fix is not a retry and not a flock, because neither removes the cause:
 * on a box that already has the libraries, the correct number of apt calls is
 * zero. Every workflow step that installs a browser therefore branches on
 * `runner.environment`, taking the plain download on a self-hosted box and
 * keeping `--with-deps` for a GitHub-hosted one, where the libraries genuinely
 * are missing.
 *
 * Three of the four call sites already did this. The fourth did not, which is
 * the whole reason for this file: the pattern was established, documented in
 * two comments, and still silently absent from one step. A comment cannot fail
 * a build. This can.
 *
 * IT MUST BE `runner.environment`, NEVER `vars.CI_RUNNER`. That variable is
 * set repo-wide, so it reads true even for a job still pinned to
 * ubuntu-latest - where dropping --with-deps would leave the browser unable to
 * start. The condition has to resolve from the machine the job is actually on.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW_DIR = path.resolve(__dirname, '../../.github/workflows');

/** One `- name:` step and every line under it, in file order. */
interface Step {
  file: string;
  name: string;
  line: number;
  body: string;
}

/**
 * COMMENTS ARE NOT CODE, and this test read them as code on its first run.
 *
 * Trailing comment blocks belong, textually, to the step ABOVE the step they
 * describe, so three innocent steps were reported as running `--with-deps`
 * because the paragraph explaining the NEXT step's branch quoted the flag.
 * A guard that cannot tell an instruction from a sentence about an instruction
 * is the "answers confidently when it cannot tell" failure this repo keeps
 * paying for. Strip `#` comments before judging anything.
 *
 * Only whole-line comments are stripped: a `#` inside a shell string is not a
 * comment, and no step here has one, so removing the ambiguous case entirely
 * is cheaper than parsing shell quoting badly.
 */
function stripComments(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

function stepsOf(file: string): Step[] {
  const text = readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
  const lines = text.split('\n');
  const steps: Step[] = [];
  let current: Step | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const named = lines[i].match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (named) {
      if (current) current.body = stripComments(current.body);
      if (current) steps.push(current);
      current = { file, name: named[1], line: i + 1, body: '' };
      continue;
    }
    if (current) current.body += lines[i] + '\n';
  }
  if (current) {
    current.body = stripComments(current.body);
    steps.push(current);
  }
  return steps;
}

const WORKFLOWS = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

describe('a browser install never gambles on the apt lock', () => {
  it('finds the workflows at all', () => {
    // A glob that silently matches nothing is a green test that checks
    // nothing - the exact shape 10.86 is about. Prove the corpus is real
    // before asserting anything about it.
    expect(WORKFLOWS.length).toBeGreaterThan(5);
  });

  it('every --with-deps sits inside a runner.environment branch', () => {
    const offenders: string[] = [];
    let guarded = 0;

    for (const file of WORKFLOWS) {
      for (const step of stepsOf(file)) {
        if (!step.body.includes('--with-deps')) continue;
        if (step.body.includes('runner.environment')) {
          guarded += 1;
          continue;
        }
        offenders.push(`${file}:${step.line}  step "${step.name}"`);
      }
    }

    expect(
      offenders,
      'These steps run `playwright install --with-deps` unconditionally. On a ' +
        'self-hosted box the libraries are already there (provision-ci-box.sh ' +
        'section 6), so the apt call installs nothing and can only lose the ' +
        'machine-wide apt lock to a sibling runner - which fails the job with ' +
        'exit 100 for a reason that is not in the branch. Branch on ' +
        'runner.environment, as the other call sites do:\n' +
        '  if [ "${{ runner.environment }}" = "self-hosted" ]; then\n' +
        '    npx playwright install chromium\n' +
        '  else\n' +
        '    npx playwright install --with-deps chromium\n' +
        '  fi\n\n' +
        offenders.join('\n')
    ).toEqual([]);

    // And prove the rule still has something to be true ABOUT. If every
    // --with-deps is ever deleted this assertion is what says so, rather than
    // the suite quietly passing on an empty set for ever after.
    expect(
      guarded,
      'no workflow installs a browser any more - if that is deliberate, delete ' +
        'this file rather than leaving a guard with nothing to guard'
    ).toBeGreaterThan(0);
  });

  it('the branch is keyed on the machine, not on the repo-wide variable', () => {
    const offenders: string[] = [];

    for (const file of WORKFLOWS) {
      for (const step of stepsOf(file)) {
        if (!step.body.includes('--with-deps')) continue;
        // vars.CI_RUNNER is set repo-wide. A job still pinned to
        // ubuntu-latest would read it as true and skip --with-deps on a
        // machine that has no browser libraries at all.
        if (step.body.includes('vars.CI_RUNNER')) {
          offenders.push(`${file}:${step.line}  step "${step.name}"`);
        }
      }
    }

    expect(
      offenders,
      'vars.CI_RUNNER answers "is this repo configured for self-hosted runners", ' +
        'not "is THIS job on one". Use runner.environment.\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
