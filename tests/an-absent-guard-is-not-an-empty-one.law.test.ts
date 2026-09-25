/**
 * LAW: PRESENT, EMPTY, ABSENT AND UNREADABLE ARE FOUR ANSWERS, NOT ONE
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md 10.86, rules 1 and 2, applied to the estate audit's own reads.
 *
 * MEASURED 2026-09-23. `gh api .../contents/<path> --jq .content` does not go
 * quiet on a 404. It exits 1 and prints the error body on STDOUT:
 *
 *   {"message":"Not Found","documentation_url":"...","status":"404"}
 *
 * estate-integrity.sh tested only whether that capture was empty, so a
 * 127-byte error counted as a present file, `base64 -d` refused it and wrote
 * nothing, and the digest came out `e3b0c442...` - the sha256 of the empty
 * string. The audit then reported "is a ZERO-BYTE FILE" about two paths that
 * did not exist at all: Diamond-Arena had DELETED both of them on purpose in
 * its own PR #64, which in the same commit added a test there to keep them
 * retired.
 *
 * Three facts, three owners, three opposite repairs, one name between them.
 * And the consequence was not cosmetic: the absent sentinel carried the
 * deletion's commit date, joined the "most recently committed" ranking and
 * WON it for agent-open-pr.yml - so the report told every reader that the
 * newest authoritative copy of the estate's pull-request opener was nothing,
 * and listed the six repos that actually have a working one as "carrying
 * something else". An agent obeying that line would have deleted the opener
 * from six repositories.
 *
 * This pins each outcome to its own sentence, and pins the ranking against
 * ever naming a non-variant as the newest content.
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

/** base64 of "guard\n" - the content every healthy repo returns here. */
const GUARD_B64 = 'Z3VhcmQK';

type Mode = 'retired' | 'resurrected';

/**
 * A fake `gh` that reproduces the REAL failure shape rather than a tidy one:
 * a 404 prints its JSON body to stdout and exits 1, which is exactly how the
 * bug got in. Diamond-Arena 404s, PepNationLab returns a genuinely empty file
 * (GitHub sends `"content": ""` for one), and workers fails with a 500 that
 * says nothing about Not Found.
 *
 * PepNationLab and Diamond-Arena both carry the LATEST commit dates, so if
 * either a zero-byte file or a deleted path could win the "most recently
 * committed" ranking, this fixture makes it win.
 */
function runAudit(mode: Mode) {
  const sandbox = mkdtempSync(join(tmpdir(), 'estate-integrity-absent-'));
  sandboxes.push(sandbox);
  const bin = join(sandbox, 'bin');
  const summary = join(sandbox, 'summary.md');
  mkdirSync(bin);

  const fakeGh = join(bin, 'gh');
  writeFileSync(
    fakeGh,
    [
      '#!/usr/bin/env bash',
      'set -u',
      '',
      'not_found() {',
      '  printf \'{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}\\n\'',
      '  exit 1',
      '}',
      '',
      'case "${1:-}" in',
      '  api)',
      '    endpoint="${2:-}"',
      '    case "$endpoint" in',
      '      */commits\\?path=*)',
      '        case "$endpoint" in',
      '          *PepNationLab*)                printf \'[{"commit":{"committer":{"date":"2026-12-31T00:00:00Z"}}}]\\n\' ;;',
      '          *Smarter-Poker-Diamond-Arena*) printf \'[{"commit":{"committer":{"date":"2026-12-30T00:00:00Z"}}}]\\n\' ;;',
      '          *Smarter-Poker-Club-Arena*)    printf \'[{"commit":{"committer":{"date":"2026-11-01T00:00:00Z"}}}]\\n\' ;;',
      '          *)                             printf \'[{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}]\\n\' ;;',
      '        esac',
      '        ;;',
      '      */contents/*)',
      '        case "$endpoint" in',
      '          *smarter-poker-workers*)',
      '            printf \'{"message":"Server Error","status":"500"}\\n\'; exit 1 ;;',
      '          *PepNationLab*)',
      "            printf '\\n' ;;",
      '          *Smarter-Poker-Diamond-Arena*)',
      '            case "${ESTATE_FIXTURE_MODE:?}" in',
      '              resurrected)',
      '                case "$endpoint" in',
      "                  *agent-open-pr.yml*) printf 'GUARD_B64_TOKEN\\n' ;;",
      '                  *) not_found ;;',
      '                esac',
      '                ;;',
      '              *) not_found ;;',
      '            esac',
      '            ;;',
      "          *) printf 'GUARD_B64_TOKEN\\n' ;;",
      '        esac',
      '        ;;',
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
    ]
      .join('\n')
      .split('GUARD_B64_TOKEN')
      .join(GUARD_B64)
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

describe('LAW - the estate audit never calls a missing file an empty one', () => {
  it('reports an absent path as absent, an empty file as empty and an unreadable read as unknown', () => {
    const { result, combined } = runAudit('retired');

    expect(result.status).toBe(1);

    // A path that 404s is GONE. It is never described as zero bytes, because
    // restoring a deleted file and filling an empty one are different jobs
    // with different owners.
    expect(combined).not.toContain('ZERO-BYTE');
    expect(combined).toMatch(/missing from:[^\n]*Smarter-Poker-Diamond-Arena/);

    // A file that exists and holds nothing keeps its own sentence.
    expect(combined).toContain('exists and is EMPTY');
    expect(combined).toMatch(/`[^`]+` in \*\*PepNationLab\*\* exists and is EMPTY/);

    // A read that failed for any other reason is COULD NOT TELL - never
    // folded into present, absent or empty (10.86 rule 1).
    expect(combined).toContain('COULD NOT TELL');
    expect(combined).toMatch(/in \*\*smarter-poker-workers\*\* — COULD NOT TELL/);
  }, 20_000);

  it('never names a deleted path or a zero-byte file as the most recently committed copy', () => {
    const { combined } = runAudit('retired');

    const leads = combined.match(/Most recently committed: \*\*[^*]+\*\* \([^)]*\)/g) ?? [];
    expect(leads.length, 'the ranking line disappeared entirely').toBeGreaterThan(0);

    // PepNationLab holds the latest date in this fixture and a zero-byte file;
    // Diamond-Arena holds the second latest and no file at all. Neither may be
    // held up as the copy the rest of the estate should converge on.
    for (const lead of leads) {
      expect(lead, 'a non-variant was ranked as the newest content').not.toContain('PepNationLab');
      expect(lead, 'a deleted path was ranked as the newest content').not.toContain(
        'Smarter-Poker-Diamond-Arena'
      );
    }
  }, 20_000);

  it('names the variant that is deliberate, so nobody repairs the wrong repo', () => {
    const { combined } = runAudit('retired');

    expect(combined).toContain('Recorded deliberate variant');
    // Club Arena's reference-transaction hook is preventive on purpose and its
    // own unit test forbids the snapshotting variant. Copying a newer-dated
    // file over it would ship a red test and a band-aid CLAUDE.md 10.12 bans.
    expect(combined).toContain('resetGuardCannotSaveTheWorktree');
  }, 20_000);

  it('alarms if a recorded retirement is reversed without the record being updated', () => {
    const { result, combined } = runAudit('resurrected');

    expect(result.status).toBe(1);
    expect(combined).toContain('RECORDED AS RETIRED');
    expect(combined).toContain('it is back');
  }, 20_000);
});
