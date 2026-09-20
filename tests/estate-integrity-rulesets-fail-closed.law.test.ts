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

type FixtureMode =
  | 'absent'
  | 'forbidden'
  | 'unreadable'
  | 'empty'
  | 'malformed'
  | 'permission_blind';

function runAudit(mode: FixtureMode) {
  const sandbox = mkdtempSync(join(tmpdir(), 'estate-integrity-rulesets-'));
  sandboxes.push(sandbox);
  const bin = join(sandbox, 'bin');
  const summary = join(sandbox, 'summary.md');
  mkdirSync(bin);

  const fakeGh = join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -u

valid_detail() {
  local id="$1"
  local contexts="$2"
  printf '{"id":%s,"target":"branch","enforcement":"active","bypass_actors":[],"rules":[{"type":"non_fast_forward"},{"type":"deletion"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{"required_status_checks":%s}}]}\\n' "$id" "$contexts"
}

case "\${1:-}" in
  api)
    endpoint="\${2:-}"
    case "$endpoint" in
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
          absent) valid_detail 102 '[{"context":"Another Check"}]' ;;
        esac
        ;;
      repos/Smarter-Poker/*/contents/*)
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
      ...process.env,
      ESTATE_FIXTURE_MODE: mode,
      GH_TOKEN: 'fixture-read-token',
      GH_TOKEN_ISSUES: 'fixture-issue-token',
      GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  });

  const report = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
  return { result, report, combined: `${result.stdout}\n${result.stderr}\n${report}` };
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
    const { result, combined } = runAudit('absent');

    expect(result.status).toBe(0);
    expect(combined).not.toContain('unauthorized required context');
    expect(combined).toContain('estate-integrity: 0 problem(s).');
  }, 15_000);
});
