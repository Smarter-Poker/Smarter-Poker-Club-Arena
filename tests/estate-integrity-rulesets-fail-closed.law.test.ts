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
const REAL_SHASUM = spawnSync('sh', ['-c', 'command -v shasum'], {
  encoding: 'utf8',
}).stdout.trim();
/** The reviewed World Hub hook the audit expects, as GitHub would return it. */
const WH_HOOK_B64 = readFileSync(
  resolve(ROOT, '.github/estate-variants/Smarter-Poker-World-Hub/.husky/reference-transaction')
).toString('base64');
const sandboxes: string[] = [];

type FixtureMode =
  | 'absent'
  | 'forbidden'
  | 'unreadable'
  | 'empty'
  | 'malformed'
  | 'permission_blind'
  | 'divergent'
  | 'hash_failure';

function runAudit(mode: FixtureMode) {
  const sandbox = mkdtempSync(join(tmpdir(), 'estate-integrity-rulesets-'));
  sandboxes.push(sandbox);
  const bin = join(sandbox, 'bin');
  const summary = join(sandbox, 'summary.md');
  const hashCount = join(sandbox, 'hash-count');
  mkdirSync(bin);
  const countedHasher = join(bin, 'shasum');
  writeFileSync(
    countedHasher,
    `#!/usr/bin/env bash
printf 'hash\\n' >> "\${ESTATE_HASH_COUNT:?}"
[ "\${ESTATE_FIXTURE_MODE:?}" != hash_failure ] || exit 74
exec "\${ESTATE_REAL_SHASUM:?}" "$@"
`
  );
  chmodSync(countedHasher, 0o755);

  const fakeGh = join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -u
WH_HOOK_B64='${WH_HOOK_B64}'

valid_detail() {
  local id="$1"
  local contexts="$2"
  printf '{"id":%s,"target":"branch","enforcement":"active","bypass_actors":[],"rules":[{"type":"non_fast_forward"},{"type":"deletion"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{"required_status_checks":%s}}]}\\n' "$id" "$contexts"
}

case "\${1:-}" in
  api)
    endpoint="\${2:-}"
    case "$endpoint" in
      # A SWITCHED-OFF WORKFLOW IS NOT A LIVE ONE (2026-10-02). Section 3 now
      # reads the workflow state before judging a run. Every repo here is
      # enabled, so this fixture keeps testing only the ruleset reads.
      */actions/workflows)
        WF_JSON='{"total_count":1,"workflows":[{"id":2,"name":"Agent Autopilot","path":".github/workflows/agent-autopilot.yml","state":"active"}]}'
        shift 2
        if [ "\${1:-}" = --jq ]; then printf '%s' "$WF_JSON" | jq -r "\${2:-.}"; else printf '%s\\n' "$WF_JSON"; fi
        ;;
      repos/Smarter-Poker/*/rulesets)
        printf '[{"id":101,"target":"branch"},{"id":102,"target":"branch"}]\\n'
        ;;
      repos/Smarter-Poker/*/rulesets/101)
        valid_detail 101 '[{"context":"Build"}]'
        ;;
      repos/Smarter-Poker/*/rulesets/102)
        case "\${ESTATE_FIXTURE_MODE:?}" in
          unreadable) exit 75 ;;
          empty) exit 0 ;;
          malformed) printf '{"id":102,"target":"branch","rules":"not-an-array"}\\n' ;;
          permission_blind) printf '{"id":102,"target":"branch","enforcement":"active"}\\n' ;;
          forbidden) valid_detail 102 '[{"context":"Stage B Release Freeze"}]' ;;
          absent|divergent|hash_failure) valid_detail 102 '[{"context":"Another Check"}]' ;;
        esac
        ;;
      repos/Smarter-Poker/Smarter-Poker-Diamond-Arena/contents/.github/workflows/agent-autopilot.yml|repos/Smarter-Poker/Smarter-Poker-Diamond-Arena/contents/.github/workflows/agent-open-pr.yml)
        # Recorded in estate-integrity.sh's RETIRED_PATHS: that repo's own
        # PR #64 (d70fcbcd1928, 2026-09-18) deleted both and added a test
        # there to keep them retired. gh prints the 404 body on STDOUT and
        # exits 1, which is the shape this fixture has to reproduce - the
        # audit reported those paths as zero-byte files for five days by
        # decoding that error as if it were content.
        printf '{"message":"Not Found","status":"404"}\\n'
        exit 1
        ;;
      repos/Smarter-Poker/Smarter-Poker-World-Hub/contents/.husky/reference-transaction)
        # World Hub's hook is a RECORDED EXPECTED VARIANT (2026-10-05): the
        # audit holds it to the reviewed copy stored in this repository, not
        # to the other repos. A healthy estate therefore serves that copy
        # here, byte for byte, and this fixture reads it from disk rather
        # than restating it.
        printf '%s\\n' "$WH_HOOK_B64"
        ;;
      repos/Smarter-Poker/*/contents/*)
        if [ "\${ESTATE_FIXTURE_MODE:?}" = divergent ] && [ "$endpoint" = repos/Smarter-Poker/Smarter-Poker-World-Hub/contents/AGENT-PLAYBOOK.md ]; then
          printf 'ZGlmZmVyZW50Cg==\\n'
          exit 0
        fi
        printf 'Z3VhcmQK\\n'
        ;;
      repos/Smarter-Poker/*/git/trees/*)
        printf '{"tree":[]}\\n'
        ;;
      repos/Smarter-Poker/*)
        printf 'main\\n'
        ;;
      *) exit 64 ;;
    esac
    ;;
  run)
    printf 'completed/success\\n'
    ;;
  issue)
    # No existing alarm in the fixture. Create/edit/close calls are successful
    # sinks because the step summary is the assertion surface.
    [ "\${2:-}" = list ] || printf 'fixture issue write accepted\\n'
    ;;
  *) exit 64 ;;
esac
`
  );
  chmodSync(fakeGh, 0o755);

  const result = spawnSync('bash', [AUDIT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ESTATE_INJECT_REPO: 'Smarter-Poker-Diamond-Arena',
      ESTATE_INJECT_RETIRED_PATH1:
        '.github/workflows/agent-autopilot.yml|Smarter-Poker-Diamond-Arena|test',
      ESTATE_INJECT_RETIRED_PATH2:
        '.github/workflows/agent-open-pr.yml|Smarter-Poker-Diamond-Arena|test',
      ...process.env,
      ESTATE_FIXTURE_MODE: mode,
      ESTATE_REAL_SHASUM: REAL_SHASUM,
      ESTATE_HASH_COUNT: hashCount,
      GH_TOKEN: 'fixture-read-token',
      GH_TOKEN_ISSUES: 'fixture-issue-token',
      GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  });

  const report = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
  const hashes = existsSync(hashCount)
    ? readFileSync(hashCount, 'utf8').trim().split('\n').length
    : 0;
  return { result, report, hashes, combined: `${result.stdout}\n${result.stderr}\n${report}` };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe('LAW - every branch ruleset detail must be readable before the audit can pass', () => {
  it.each(['unreadable', 'empty', 'malformed'] as const)(
    'alarms and exits nonzero when the second ruleset detail is %s',
    (mode) => {
      const { result, combined } = runAudit(mode);

      expect(result.status).toBe(1);
      expect(combined).toContain('branch ruleset `102`');
      expect(combined).toContain('required contexts are unverified');
    },
    15_000
  );

  it('alarms and exits nonzero when a valid secondary ruleset contains the forbidden context', () => {
    const { result, combined } = runAudit('forbidden');

    expect(result.status).toBe(1);
    expect(combined).toContain('unauthorized required context `Stage B Release Freeze`');
    expect(combined).toContain('102');
  }, 15_000);

  /**
   * MEASURED 2026-09-19. Every branch ruleset in all seven repos had been
   * reported as "empty or malformed detail" since 2026-09-09, and the audit
   * had been red and unread for ten days. None of them was malformed. GitHub
   * hands a caller without `Administration: Read` a WELL FORMED ruleset with
   * `rules` and `bypass_actors` absent, which is a could-not-ask.
   *
   * It matters which one it says, because the thing it could not see was real:
   * World Hub's main ruleset read bypass=0 on 2026-09-08 and carries an
   * Integration bypass actor with mode `always` today. A message that says
   * "malformed" sends the next reader to the API shape. A message that says
   * "the token cannot see it" sends them to the App's permissions, which is
   * where the answer is.
   */
  it('names the permission when the detail is well formed but rules are withheld', () => {
    const { result, combined } = runAudit('permission_blind');

    expect(result.status).toBe(1);
    expect(combined).toContain('cannot see `rules` or `bypass_actors`');
    expect(combined).toContain('Administration: Read');
    expect(combined).toContain('102');
    // It must NOT accuse the API of being malformed, which is the wrong repair.
    expect(combined).not.toContain('wrong or absent');
    // And nothing about that repo may be reported as verified.
    expect(combined).not.toContain('estate-integrity: 0 problem(s).');
  }, 15_000);

  it('does not raise a forbidden-context alarm when every detail is valid and absent', () => {
    const { result, combined, hashes } = runAudit('absent');

    expect(result.status).toBe(0);
    expect(combined).not.toContain('unauthorized required context');
    expect(combined).toContain('estate-integrity: 0 problem(s).');
    // One hash per shared file, plus three for `.husky/reference-transaction`:
    // the stored World Hub copy, World Hub's own bytes (which differ from Club
    // Arena's and are compared against the stored copy, not the estate), and
    // commander's bytes, which differ from the last payload seen.
    expect(hashes).toBe(17);
  }, 15_000);

  it('rehashes different same-path bytes without hiding the divergent repository', () => {
    const { result, combined, hashes } = runAudit('divergent');
    expect(result.status).toBe(1);
    expect(combined).toContain('AGENT-PLAYBOOK.md');
    expect(combined).toContain('2 different versions');
    expect(combined).toContain('Smarter-Poker-World-Hub');
    expect(hashes).toBe(19);
  }, 15_000);

  it('refuses failed hashing and never reuses it as a successful digest', () => {
    const { result, combined, hashes } = runAudit('hash_failure');
    expect(result.status).toBe(1);
    expect(combined).toContain('could not decode or hash');
    expect(combined).not.toContain('estate-integrity: 0 problem(s).');
    expect(hashes).toBe(96);
  }, 15_000);
});
