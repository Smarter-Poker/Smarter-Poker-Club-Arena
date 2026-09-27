// ---------------------------------------------------------------------------
// LAW: a probe that cannot read CI must say so, never "pending".
//
// 2026-09-06. An agent reported "checks pending" on a branch that had been RED
// for three pushes, and the report was not careless - it was what the API said.
// The historical fallback to legacy aggregate commit status could not report
// Actions check runs. In September 2026 the required Money verdict also became
// a standalone App check. Current observation reads exact check runs with their
// required App identity as well as Actions diagnostics. A denied Checks read is
// still UNKNOWN; a dated scope limitation never makes absence a passing result.
//
// The pins below are each a step of that ladder. If one of them turns red, the
// ladder has been rebuilt and the next agent gets the same false all-clear.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { requiredContextProblems, stateForChecks } from '../scripts/ci/pr-status.mjs';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a check-status probe cannot say pending when it cannot tell', () => {
  const TOOL = 'scripts/ci/pr-status.mjs';

  it('the tool that answers "is my branch green" exists', () => {
    expect(
      existsSync(join(ROOT, TOOL)),
      `${TOOL} is the one command AGENT-PLAYBOOK.md sends agents to for CI status. ` +
        'Deleting it returns every agent to the 403-then-/status ladder that produced ' +
        'a false all-clear over three pushes.'
    ).toBe(true);
  });

  it('it reads Actions and exact check runs without using legacy aggregate status', () => {
    const src = read(TOOL);
    expect(src, 'pr-status.mjs must read /actions/runs?head_sha=').toContain(
      '/actions/runs?head_sha='
    );

    // It may NAME the bad routes - the header explains them at length. It must
    // not FETCH them. The distinction is a gh()/fetch() call on the same line.
    const fetchesBadRoute = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .some((l) => /(?:gh|ghSoft|fetch)\s*\(.*commits\/.*\/status/.test(l));
    expect(
      fetchesBadRoute,
      'pr-status.mjs must never FETCH /commits/:sha/status (reports "pending" for ' +
        'commits that already failed). Denied check-run reads must remain UNKNOWN.'
    ).toBe(false);
  });

  it('"could not tell" is a distinct outcome from "still running"', () => {
    const src = read(TOOL);
    expect(src).toContain('UNKNOWN');
    // The exit codes are the contract callers branch on. RUNNING and UNKNOWN
    // collapsing into one value is exactly the bug: it lets "I could not read
    // the API" render as "it is still going", which is what happened.
    const m = src.match(/const EXIT = \{([^}]*)\}/);
    expect(m, 'pr-status.mjs must export an EXIT map').toBeTruthy();
    const table = m![1];
    const codeOf = (k: string) => {
      const mm = table.match(new RegExp(`${k}\\s*:\\s*(\\d+)`));
      return mm ? Number(mm[1]) : null;
    };
    expect(codeOf('GREEN')).toBe(0);
    expect(codeOf('RUNNING')).not.toBeNull();
    expect(codeOf('UNKNOWN')).not.toBeNull();
    expect(
      codeOf('UNKNOWN'),
      'UNKNOWN must not share an exit code with RUNNING or GREEN - a caller that ' +
        'cannot distinguish "no answer" from "still going" reports the first as the second.'
    ).not.toBe(codeOf('RUNNING'));
    expect(codeOf('UNKNOWN')).not.toBe(codeOf('GREEN'));
  });

  it('an unreadable answer is never coerced into an empty result', () => {
    const src = read(TOOL);
    // The original defect in one line: `(await res.json()).check_runs` on a 403
    // body yields undefined, and `undefined || []` yields "nothing failed".
    expect(
      /res\.ok/.test(src) && /die\(/.test(src),
      'pr-status.mjs must check res.ok and fail loudly. Silently defaulting a ' +
        'non-200 body to an empty list is the whole bug this law exists for.'
    ).toBe(true);
  });

  it('does not call a commit green until every required context is observed successful', () => {
    const src = read(TOOL);

    expect(src).toContain('requiredContextProblems');
    expect(src).toContain('stateForChecks');
    expect(src).toMatch(
      /requiredProblems\s*=\s*requiredContextProblems\(required,\s*eligibleChecks,\s*sha\)/
    );
    expect(src).toMatch(/\.filter\(\(rule\) => rule\.type === 'required_status_checks'\)/);
    expect(src).toMatch(/\.flatMap\(\(rule\) => rule\.parameters\?\.required_status_checks/);
    expect(src).toMatch(/return aggregateExit/);
    expect(src).not.toMatch(/if \(JSON_OUT\) \{[\s\S]*?return 0;/);
  });

  it('treats missing, skipped, and neutral required contexts as non-green', () => {
    const required = new Map(
      ['Build', 'Test', 'Audit', 'Deploy'].map((name) => [name, new Set([null])])
    );
    const problems = requiredContextProblems(
      required,
      [
        { name: 'Build', status: 'completed', conclusion: 'success' },
        { name: 'Test', status: 'completed', conclusion: 'skipped' },
        { name: 'Audit', status: 'completed', conclusion: 'neutral' },
      ].map((check, id) => ({
        ...check,
        id: id + 1,
        head_sha: 'a'.repeat(40),
        app: { id: 1, slug: 'fixture' },
      })),
      'a'.repeat(40)
    );

    expect(problems).toEqual([
      { context: 'Audit', state: 'not_successful', conclusions: ['neutral'] },
      { context: 'Deploy', state: 'missing', conclusions: [] },
      { context: 'Test', state: 'not_successful', conclusions: ['skipped'] },
    ]);
    expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
      'RED'
    );
    expect(
      stateForChecks({
        failures: [],
        activeRuns: [{ name: 'Optional suite' }],
        requiredProblems: problems,
      })
    ).toBe('RED');
    expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: null })).toBe(
      'UNKNOWN'
    );
  });

  it('returns green only for a complete set of successful required contexts', () => {
    const required = new Map(['Build', 'Test'].map((name) => [name, new Set([null])]));
    const problems = requiredContextProblems(
      required,
      [
        { name: 'Build', status: 'completed', conclusion: 'success' },
        { name: 'Test', status: 'completed', conclusion: 'success' },
      ].map((check, id) => ({
        ...check,
        id: id + 1,
        head_sha: 'a'.repeat(40),
        app: { id: 1, slug: 'fixture' },
      })),
      'a'.repeat(40)
    );

    expect(problems).toEqual([]);
    expect(stateForChecks({ failures: [], activeRuns: [], requiredProblems: problems })).toBe(
      'GREEN'
    );
  });

  it('retains agent ownership instead of promising disabled autopilot', () => {
    const src = read(TOOL);
    expect(src).not.toMatch(/autopilot|Stop here|agent-open-pr\.yml/i);
    expect(src).toContain('protected merge is a separate action');
    expect(src).toContain('continue independent assigned work');
  });

  it('no other agent-facing script treats /commits/:sha/status as a check oracle', () => {
    const dir = join(ROOT, 'scripts/ci');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!/\.(mjs|js|ts|sh)$/.test(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      for (const line of src.split('\n')) {
        // Naming the route in prose is fine and this file does it at length -
        // the header has to explain WHY it is poison. Only a line that actually
        // REQUESTS it is an offence, so require a call alongside the path.
        if (!/commits\/[^\s'"]*\/status/.test(line)) continue;
        if (/check-runs/.test(line)) continue;
        const isRequest =
          /(?:fetch|gh|ghSoft|curl|wget|axios|request)\s*\(?["'\s]*(?:https?:)?[^)]*commits\//.test(
            line
          );
        if (isRequest) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      'These read the legacy commit-status API to decide whether CI passed. It ' +
        'returns {"state":"pending"} for green, red and never-built commits alike ' +
        'on this estate. Use /actions/runs?head_sha= (see scripts/ci/pr-status.mjs).\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('it asks about the repo it is standing in, and never guesses', () => {
    const src = read(TOOL);
    // AGENT-PLAYBOOK.md is byte-identical in seven repos, so the moment it
    // started naming this tool, a hardcoded default made it answer about Club
    // Arena's pull requests in every other repo - confidently, in the right
    // format, about the wrong repository. Derive from the checkout instead.
    expect(
      /const REPO = argOf\('--repo',\s*process\.env\.REPO \|\| '[^']+'\)/.test(src),
      'pr-status.mjs must not fall back to a hardcoded owner/name. The playbook ' +
        'that names it is shared by seven repos; a literal default reports on the ' +
        'wrong one and looks right doing it.'
    ).toBe(false);
    expect(src, 'it must derive the repo from the git remote').toMatch(/remote get-url origin/);
    // And when it cannot tell, it must refuse rather than pick one.
    expect(src, 'a missing repo must die(), not default').toMatch(/if \(!REPO\)/);
  });

  it('the playbook sends agents to the tool, and warns about both bad routes', () => {
    const pb = read('AGENT-PLAYBOOK.md');
    expect(pb, 'AGENT-PLAYBOOK.md must name the working command').toContain(
      'scripts/ci/pr-status.mjs'
    );
    expect(pb, 'the playbook must warn that /commits/:sha/status reports pending').toMatch(
      /commits\/:sha\/status/
    );
    // 2026-09-12: this required the playbook to say "`gh` is not installed".
    // It IS installed - /opt/homebrew/bin/gh, v2.86.0, authenticated as
    // Smarter-Poker - and THIS ASSERTION is why the falsehood survived six days
    // of agents reading it and believing it: the claim was load-bearing in CI,
    // so correcting the doc turned the suite red and every agent put it back.
    //
    // The constraint the playbook must still record is the real one, and it has
    // a different fix: the binary is absent from a NON-INTERACTIVE PATH, which
    // is also why scripts/guard-merged-branch.sh (fail-closed, needs `gh`)
    // refused pushes that were fine. Pin the remedy, not the diagnosis.
    expect(pb, 'the playbook must record how to make `gh` resolvable on the Mac').toMatch(
      /\/opt\/homebrew\/bin/
    );
  });
});
