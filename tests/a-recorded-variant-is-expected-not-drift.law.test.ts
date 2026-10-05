/**
 * LAW: A RECORDED, REVIEWED DIFFERENCE IS AN EXPECTATION, NOT A DRIFT
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md 10.83 applied to the estate audit's own report.
 *
 * MEASURED 2026-10-05. Issue #3931 had been open for 27 days. Nine of its
 * eleven drifted files were plain staleness and were converged that day. The
 * other was World Hub's `.husky/reference-transaction`, which the owner had
 * accepted, which estate-integrity.sh already explained in a recorded note,
 * and which the audit re-raised every four hours regardless - because a note
 * "does NOT suppress the drift finding". A report that is red by design is a
 * report nobody reads, and the eight real findings beside it went unread with
 * it.
 *
 * So a deliberate difference is now recorded as the exact reviewed bytes,
 * stored at `.github/estate-variants/<repo>/<path>` in this repository, and
 * the audit holds that repo's copy to the stored copy instead of to the other
 * repos. The exemption is as narrow as the file: the moment the repo's copy
 * stops matching, the record is stale, the audit says so, and the copy goes
 * back into the comparison. Nothing here lets a repo carry "something else";
 * it lets a repo carry exactly the thing that was reviewed.
 *
 * Pinned here:
 *   - a copy that matches its stored variant is noted and raises no drift;
 *   - a copy that does not match raises a STALE finding and is compared;
 *   - a stored copy with no reason on file is itself a finding;
 *   - a stored copy for a repo or path the audit does not compare is a
 *     finding, so a typo cannot silently expect nothing;
 *   - the live record: World Hub's stored hook is the AGENT_REF_GUARD_OK
 *     variant Club Arena's own test forbids here, and it has a reason on file.
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
const VARIANTS = resolve(ROOT, '.github/estate-variants');
const sandboxes: string[] = [];

/** base64 of "guard\n" - what every healthy repo returns for every file. */
const GUARD_B64 = 'Z3VhcmQK';
/** base64 of "hub variant\n" - what World Hub returns for the path under test. */
const VARIANT_B64 = 'aHViIHZhcmlhbnQK';
const VARIANT_TEXT = 'hub variant\n';
/** The path the fixture lets World Hub differ on. */
const PATH_UNDER_TEST = 'scripts/guard-shared-clone.sh';

const WH_HOOK_B64 = readFileSync(
  join(VARIANTS, 'Smarter-Poker-World-Hub/.husky/reference-transaction')
).toString('base64');

type Fixture = {
  /** What the stored copy for World Hub's PATH_UNDER_TEST holds, if any. */
  stored?: string;
  /** Whether DELIBERATE_VARIANTS carries a reason for it. */
  withNote?: boolean;
  /** An extra stored copy that names a repo or path the audit does not compare. */
  strayStored?: { repo: string; path: string };
};

/**
 * Runs the real audit against a fake `gh` and a private copy of the variants
 * directory, so the test can add and remove stored copies without touching
 * the repository's own record. Every repo returns "guard\n" for every shared
 * file, except: World Hub returns the real stored hook for
 * `.husky/reference-transaction` (the live record), and returns VARIANT for
 * PATH_UNDER_TEST.
 */
function runAudit(fx: Fixture) {
  const sandbox = mkdtempSync(join(tmpdir(), 'estate-integrity-variant-'));
  sandboxes.push(sandbox);
  const bin = join(sandbox, 'bin');
  const summary = join(sandbox, 'summary.md');
  const cwd = join(sandbox, 'repo');
  mkdirSync(bin);
  mkdirSync(join(cwd, '.github', 'scripts'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'scripts', 'estate-integrity.sh'), readFileSync(AUDIT));

  // The live record travels with the test: the audit reads
  // .github/estate-variants relative to its working directory.
  const liveStored = join(cwd, '.github/estate-variants/Smarter-Poker-World-Hub/.husky');
  mkdirSync(liveStored, { recursive: true });
  writeFileSync(
    join(liveStored, 'reference-transaction'),
    readFileSync(join(VARIANTS, 'Smarter-Poker-World-Hub/.husky/reference-transaction'))
  );
  if (fx.stored !== undefined) {
    const dir = join(cwd, '.github/estate-variants/Smarter-Poker-World-Hub', 'scripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'guard-shared-clone.sh'), fx.stored);
  }
  if (fx.strayStored) {
    const file = join(cwd, '.github/estate-variants', fx.strayStored.repo, fx.strayStored.path);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, 'stray\n');
  }

  const fakeGh = join(bin, 'gh');
  writeFileSync(
    fakeGh,
    [
      '#!/usr/bin/env bash',
      'set -u',
      'case "${1:-}" in',
      '  api)',
      '    endpoint="${2:-}"',
      '    case "$endpoint" in',
      '      */commits\\?path=*)',
      '        printf \'[{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}]\\n\' ;;',
      '      */actions/workflows)',
      '        WF_JSON=\'{"total_count":1,"workflows":[{"id":2,"name":"Agent Autopilot","path":".github/workflows/agent-autopilot.yml","state":"active"}]}\'',
      '        shift 2',
      '        if [ "${1:-}" = --jq ]; then printf \'%s\' "$WF_JSON" | jq -r "${2:-.}"; else printf \'%s\\n\' "$WF_JSON"; fi',
      '        ;;',
      '      repos/Smarter-Poker/Smarter-Poker-World-Hub/contents/.husky/reference-transaction)',
      `        printf '%s\\n' '${WH_HOOK_B64}' ;;`,
      `      repos/Smarter-Poker/Smarter-Poker-World-Hub/contents/${PATH_UNDER_TEST})`,
      `        printf '${VARIANT_B64}\\n' ;;`,
      '      */contents/*)',
      `        printf '${GUARD_B64}\\n' ;;`,
      '      */rulesets)',
      '        printf \'[{"id":101,"target":"branch"}]\\n\' ;;',
      '      */rulesets/101)',
      '        printf \'{"id":101,"target":"branch","enforcement":"active","bypass_actors":[],"rules":[{"type":"non_fast_forward"},{"type":"deletion"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Build"}]}}]}\\n\' ;;',
      '      */git/trees/*)',
      '        printf \'{"tree":[]}\\n\' ;;',
      '      repos/Smarter-Poker/*)',
      "        printf 'main\\n' ;;",
      '      *) exit 64 ;;',
      '    esac',
      '    ;;',
      "  run)    printf 'completed/success\\n' ;;",
      '  issue)  [ "${2:-}" = list ] || printf \'fixture issue write accepted\\n\' ;;',
      '  *) exit 64 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(fakeGh, 0o755);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GH_TOKEN: 'fixture-read-token',
    GH_TOKEN_ISSUES: 'fixture-issue-token',
    GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
    GITHUB_STEP_SUMMARY: summary,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  if (fx.withNote) {
    env.ESTATE_INJECT_VARIANT_NOTE = `${PATH_UNDER_TEST}|Smarter-Poker-World-Hub|fixture reason`;
  }

  const result = spawnSync('bash', [join(cwd, '.github/scripts/estate-integrity.sh')], {
    cwd,
    encoding: 'utf8',
    env,
  });
  const report = existsSync(summary) ? readFileSync(summary, 'utf8') : '';
  return { result, report, combined: `${result.stdout}\n${result.stderr}\n${report}` };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe('LAW - a recorded, reviewed difference is an expectation, not a drift', () => {
  it('holds a repo to its stored copy: matching bytes raise nothing and the estate reads clean', () => {
    const { result, combined } = runAudit({ stored: VARIANT_TEXT, withNote: true });

    expect(combined).toContain(
      `${PATH_UNDER_TEST}: Smarter-Poker-World-Hub carries its recorded deliberate variant`
    );
    expect(combined).not.toMatch(new RegExp('`' + PATH_UNDER_TEST + '` — \\*\\*2 different versions'));
    expect(combined).not.toContain('RECORDED AS A DELIBERATE VARIANT');
    // With the live World Hub hook record matching too, nothing is left.
    expect(combined).toContain('estate-integrity: 0 problem(s).');
    expect(result.status).toBe(0);
  }, 20_000);

  it('a stale record is a finding, and the copy goes back into the comparison', () => {
    const { result, combined } = runAudit({ stored: 'something that was reviewed once\n', withNote: true });

    expect(result.status).toBe(1);
    expect(combined).toContain('RECORDED AS A DELIBERATE VARIANT');
    expect(combined).toContain('The record is stale');
    // Fail closed: the unmatched copy is compared like any other, so the
    // ordinary drift finding is raised as well.
    expect(combined).toMatch(new RegExp('`' + PATH_UNDER_TEST + '` — \\*\\*2 different versions'));
  }, 20_000);

  it('without a stored copy a difference is still a drift, note or no note', () => {
    const { result, combined } = runAudit({ withNote: true });

    expect(result.status).toBe(1);
    expect(combined).toMatch(new RegExp('`' + PATH_UNDER_TEST + '` — \\*\\*2 different versions'));
    expect(combined).toContain('Recorded deliberate variant: **Smarter-Poker-World-Hub** - fixture reason');
  }, 20_000);

  it('a stored copy with no reason on file is itself a finding', () => {
    const { result, combined } = runAudit({ stored: VARIANT_TEXT, withNote: false });

    expect(result.status).toBe(1);
    expect(combined).toContain('NO reason on file');
    expect(combined).toContain('DELIBERATE_VARIANTS');
  }, 20_000);

  it('a stored copy for a repo or path the audit does not compare is a finding, not silence', () => {
    const { result, combined } = runAudit({
      stored: VARIANT_TEXT,
      withNote: true,
      strayStored: { repo: 'Smarter-Poker-Typo', path: 'scripts/not-a-shared-file.sh' },
    });

    expect(result.status).toBe(1);
    expect(combined).toContain('not a repo this audit compares');
    expect(combined).toContain('not a shared file this audit compares');
  }, 20_000);

  it('the live record: World Hub keeps the hook Club Arena forbids, for a reason that is written down', () => {
    const stored = readFileSync(
      join(VARIANTS, 'Smarter-Poker-World-Hub/.husky/reference-transaction'),
      'utf8'
    );
    // It IS the variant Club Arena must never adopt (CLAUDE.md 10.12, 12 r3).
    expect(stored).toContain('AGENT_REF_GUARD_OK');
    expect(stored).toContain('refs/wip/orphan-guard');
    // And Club Arena's own copy is not it.
    const ours = readFileSync(resolve(ROOT, '.husky/reference-transaction'), 'utf8');
    expect(ours).not.toContain('AGENT_REF_GUARD_OK');
    expect(ours).not.toContain('refs/wip');
    // The reason is on file beside the record.
    const audit = readFileSync(AUDIT, 'utf8');
    expect(audit).toContain(
      '".husky/reference-transaction|Smarter-Poker-World-Hub|World Hub keeps its own hook ON PURPOSE'
    );
    expect(audit).toContain('estate-variants/Smarter-Poker-World-Hub/.husky/reference-transaction');
  });
});
