/**
 * LAW: a byte-identical estate file may not hardcode a workflow only one repo has.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. agent-autopilot.yml is enforced byte-identical across all
 * seven repos by estate-integrity.sh, and it asked
 * `gh run list --workflow ci.yml`. Only Club Arena has a ci.yml. In the World
 * Hub - whose gate is build-safety-gate.yml - that answered "none" for every
 * pull request, so the "no CI run at all" repair pushed an empty re-trigger
 * commit onto every World Hub pull request older than fifteen minutes, after
 * every real push: a second full copy of thirteen workflows on six runners,
 * and a later merge each time. Five landed in one day, on a repo whose jobs
 * were already waiting 8-14 minutes for a runner.
 *
 * A guard that is the same file everywhere has to ask questions that are true
 * everywhere: "did any pull_request workflow run for this head", "are the
 * checks THIS repo's ruleset requires red" - never "what did ci.yml say".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Lines that RUN, not lines that explain. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('a shared guard names no workflow only one repo has', () => {
  it('agent-autopilot.yml does not ask gh for ci.yml by name', () => {
    const src = code(read('.github/workflows/agent-autopilot.yml'));
    expect(src).not.toMatch(/--workflow\s+ci\.yml/);
    expect(src).not.toMatch(/workflows\/ci\.yml/);
  });

  it('it decides "no CI at all" from any pull_request run on the head', () => {
    const src = code(read('.github/workflows/agent-autopilot.yml'));
    expect(src).toMatch(/actions\/runs\?head_sha=\$HEAD_FOR_RUNS&event=pull_request/);
  });

  it('it decides "red" from the checks the ruleset requires, not from any workflow', () => {
    const src = code(read('.github/workflows/agent-autopilot.yml'));
    expect(src).toMatch(/rules\/branches\/\$BASE/);
    expect(src).toMatch(/required_status_checks/);
    expect(src).toMatch(/statusCheckRollup/);
  });

  it('the other shared guards do not carry the same assumption', () => {
    for (const f of ['.github/scripts/report-stuck-prs.sh', '.github/scripts/queue-pr.sh']) {
      expect(code(read(f)), `${f} names ci.yml`).not.toMatch(/--workflow\s+ci\.yml/);
    }
  });
});
