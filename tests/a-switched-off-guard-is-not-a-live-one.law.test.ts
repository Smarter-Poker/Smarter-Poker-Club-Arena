/**
 * LAW: A SWITCHED-OFF WORKFLOW IS NOT A LIVE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md 10.86, rules 1 and 4, applied to the estate audit's liveness claim.
 *
 * On 2026-09-23 this audit learned that a DELETED workflow keeps reporting its
 * last historical run through `gh run list`, and stopped claiming liveness for
 * one. The fix left the identical trap one level up (10.86 rule 4): a workflow
 * that is merely SWITCHED OFF reports its last run exactly the same way, and
 * nothing read the workflow's state.
 *
 * MEASURED 2026-10-02. `Estate Integrity` had been red with 19 problems, and
 * three of them said:
 *
 *   **commander-shared** - Agent Autopilot's last run is `completed/failure`.
 *   While it is red, pull requests stop being queued and the failure is
 *   silent from the outside.
 *
 * with the same sentence for smarter-poker-workers and PepNationLab. Not one
 * clause of it was true. Those three runs were at 2026-09-16T04:35:16Z,
 * 04:06:18Z and 05:24:02Z, and GitHub records all three workflows as
 * `disabled_manually`, set about an hour LATER and within eleven minutes of
 * each other: one deliberate, coordinated retirement, which the September 17
 * owner instruction then wrote down (a retired autopilot "remain[s] inactive"
 * and is a prerequisite for nothing). A red run sixteen days ago was not what
 * stopped that queue, nothing was waiting on it, and there was no repair to
 * ask three other repositories for.
 *
 * So the state is read first, and the four answers stay four: enabled (the run
 * conclusion means something), switched off by somebody (it does not),
 * switched off by GitHub after 60 idle days (nobody chose that, so say it), and
 * could-not-read (never folded into any of the three).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const AUDIT = resolve(ROOT, '.github/scripts/estate-integrity.sh');
const sandboxes: string[] = [];

/** base64 of "guard\n" - identical in every repo, so section 2 stays quiet. */
const GUARD_B64 = 'Z3VhcmQK';

/**
 * A fake `gh` giving each repo a different autopilot state, and - crucially -
 * running the REAL `jq` over REAL workflow-list JSON rather than pre-answering
 * the audit's filter. The jq expression is part of what has to be right: the
 * endpoint returns every workflow in the repo, and picking the wrong one out of
 * it would read somebody else's state.
 *
 * Diamond-Arena 404s the two paths its own PR #64 deleted, which is what
 * production does, so the recorded-retirement path is exercised too.
 */
function runAudit() {
  const sandbox = mkdtempSync(join(tmpdir(), 'estate-integrity-off-'));
  sandboxes.push(sandbox);
  const bin = join(sandbox, 'bin');
  const summary = join(sandbox, 'summary.md');
  mkdirSync(bin);

  const fakeGh = join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -u

AUTOPILOT='.github/workflows/agent-autopilot.yml'

# One workflow list per repo. A real list holds more than the one being asked
# about, and a decoy carrying the opposite state is in every one of them.
workflows_json() {
  local state="$1"
  printf '{"total_count":2,"workflows":[{"id":1,"name":"Decoy","path":".github/workflows/agent-open-pr.yml","state":"%s"},{"id":2,"name":"Agent Autopilot","path":"%s","state":"%s"}]}\\n' \\
    "$2" "$AUTOPILOT" "$state"
}

case "\${1:-}" in
  api)
    endpoint="\${2:-}"
    case "$endpoint" in
      */actions/workflows)
        case "$endpoint" in
          *Smarter-Poker-Club-Arena*) JSON=$(workflows_json active disabled_manually) ;;
          *Smarter-Poker-World-Hub*)  JSON=$(workflows_json active disabled_manually) ;;
          *smarter-poker-commander*)  JSON=$(workflows_json disabled_manually active) ;;
          *commander-shared*)         JSON=$(workflows_json disabled_inactivity active) ;;
          *smarter-poker-workers*)
            # The shape a 403 or 500 really takes: a body on STDOUT, exit 1.
            printf '{"message":"Resource not accessible by integration","status":"403"}\\n'
            exit 1 ;;
          *PepNationLab*)
            # Enabled workflows, but no autopilot among them at all. It still
            # goes through the real jq below: a list that does not contain the
            # workflow must come back EMPTY, not as the list.
            JSON='{"total_count":1,"workflows":[{"id":1,"name":"Decoy","path":".github/workflows/agent-open-pr.yml","state":"active"}]}' ;;
          *) JSON=$(workflows_json active active) ;;
        esac
        shift 2
        if [ "\${1:-}" = --jq ]; then printf '%s' "$JSON" | jq -r "\${2:-.}"; else printf '%s\\n' "$JSON"; fi
        ;;
      repos/Smarter-Poker/Smarter-Poker-Diamond-Arena/contents/.github/workflows/agent-autopilot.yml|repos/Smarter-Poker/Smarter-Poker-Diamond-Arena/contents/.github/workflows/agent-open-pr.yml)
        printf '{"message":"Not Found","status":"404"}\\n'
        exit 1 ;;
      repos/Smarter-Poker/PepNationLab/contents/.github/workflows/agent-autopilot.yml)
        printf '{"message":"Not Found","status":"404"}\\n'
        exit 1 ;;
      */commits\\?path=*)
        printf '[{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}]\\n' ;;
      */contents/*)
        printf '${GUARD_B64}\\n' ;;
      */rulesets)
        printf '[{"id":101,"target":"branch"}]\\n' ;;
      */rulesets/101)
        printf '{"id":101,"target":"branch","enforcement":"active","bypass_actors":[],"rules":[{"type":"non_fast_forward"},{"type":"deletion"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Build"}]}}]}\\n' ;;
      */git/trees/*)
        printf '{"tree":[]}\\n' ;;
      repos/Smarter-Poker/*)
        printf 'main\\n' ;;
      *) exit 64 ;;
    esac
    ;;
  run)
    # Every repo's LAST RUN is red. Only the enabled ones may be judged on it.
    printf 'completed/failure\\n' ;;
  issue)
    [ "\${2:-}" = list ] || printf 'fixture issue write accepted\\n' ;;
  *) exit 64 ;;
esac
`
  );
  chmodSync(fakeGh, 0o755);

  const result = spawnSync('bash', [AUDIT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ESTATE_FIXTURE_MODE: 'switched-off',
      GH_TOKEN: 'fixture-read-token',
      GH_TOKEN_ISSUES: 'fixture-issue-token',
      GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  });

  const report = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
  return { result, combined: `${result.stdout}\n${result.stderr}\n${report}` };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe('LAW - the estate audit reads whether Autopilot is switched on before judging its last run', () => {
  it('never blames a red run in a repo where the workflow is switched off', () => {
    const { combined } = runAudit();

    // smarter-poker-commander is `disabled_manually` with a red last run. The
    // sentence that stood for sixteen days must not be said about it.
    expect(combined).not.toMatch(
      /\*\*smarter-poker-commander\*\*[^\n]*Agent Autopilot[^\n]*last run/
    );
    expect(combined).toMatch(
      /smarter-poker-commander: autopilot is switched off there \(disabled_manually\)/
    );
    expect(combined).toContain('no liveness is claimed for it');
  }, 20_000);

  it('still blames a red run where the workflow is enabled', () => {
    const { result, combined } = runAudit();

    expect(result.status).toBe(1);
    expect(combined).toMatch(
      /\*\*Smarter-Poker-World-Hub\*\* [^\n]*Agent Autopilot is enabled and its last run is/
    );
    // Club Arena's own autopilot is enabled and red in this fixture too; the
    // audit judges its home repo by exactly the same rule.
    expect(combined).toMatch(
      /\*\*Smarter-Poker-Club-Arena\*\* [^\n]*Agent Autopilot is enabled and its last run is/
    );
  }, 20_000);

  it('says so when GitHub, not a person, switched the workflow off', () => {
    const { combined } = runAudit();

    // `disabled_inactivity` is nobody's decision - 60 idle days and GitHub does
    // it - so it is drift and must be raised, not noted.
    expect(combined).toMatch(
      /\*\*commander-shared\*\* [^\n]*workflow state is `disabled_inactivity`, which nobody chose/
    );
  }, 20_000);

  it('calls an unreadable state COULD NOT TELL, never on or off', () => {
    const { combined } = runAudit();

    expect(combined).toMatch(
      /\*\*smarter-poker-workers\*\* [^\n]*COULD NOT TELL whether Agent Autopilot is switched on/
    );
    // A 403 body on stdout must never be read as a state, and the red last run
    // must not be judged on the strength of it.
    expect(combined).not.toMatch(/\*\*smarter-poker-workers\*\*[^\n]*Agent Autopilot is enabled/);
  }, 20_000);

  it('claims no liveness for an autopilot that is simply not in the repo', () => {
    const { combined } = runAudit();

    // PepNationLab has no autopilot workflow at all and no RETIRED_PATHS
    // record. Section 2 owns the absence; section 3 must not also judge a run.
    expect(combined).toMatch(
      /PepNationLab: autopilot's workflow file is absent \(section 2 reports the absence\)/
    );
    expect(combined).not.toMatch(/\*\*PepNationLab\*\* [^\n]*Agent Autopilot is enabled/);

    // And the recorded Diamond-Arena retirement still reports as recorded.
    expect(combined).toContain(
      'Smarter-Poker-Diamond-Arena: autopilot retired in that repo (recorded)'
    );
  }, 20_000);
});
