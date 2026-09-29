/**
 * LAW: a guard in the Club Arena publisher may not refuse in silence, and no
 * one step may grow until the workflow itself stops parsing.
 * ═══════════════════════════════════════════════════════════════════════════
 * CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
 * have its own name. This law applies the same sentence to "I refused": a
 * check that stops the release without saying what it checked, what it
 * required and what it found is a check nobody can act on.
 *
 * WHAT HAPPENED (2026-09-22). `publish-club-arena.yml` failed twice on
 * 91bd8161a1f8d084de8ca2d7dd97020d0c24a3d8, runs 35763554815 and
 * 35764705782, both inside "Publish through the host-owned immutable
 * transaction". The first printed NOTHING between the step's own group
 * footer and `Process completed with exit code 1` - 3.0 seconds, zero
 * characters. The second printed one line, "reusing the already sealed
 * immutable release for 91bd816", and exited 1 fifty-nine milliseconds
 * later. Fifty-eight guards in that file could do that: a bare `test -d X`
 * or `[ ... ]` used as a statement under `set -e` exits 1 and says nothing.
 *
 * The guard was RIGHT. `scripts/self-host-fonts.mjs` could not reach Google
 * Fonts, warned, and exited 0, so dist carried no fonts/ directory; the
 * origin serves /fonts/* from an append-only pool whose fonts.css is a
 * symlink into the live release, so activating that bundle would have 404'd
 * the fonts of every shell already cached on a player's device. Refusing was
 * correct. Refusing without a word is what cost the afternoon.
 *
 * AND THEN THE FIX HIT THE CEILING ABOVE IT (same day). Giving 58 guards a
 * voice grew the origin transaction step from 17,304 to 24,626 characters,
 * which is more than GitHub Actions accepts for a single `run`. The whole
 * workflow stopped parsing: no job started, the run carried the file path
 * instead of the workflow's name, and a branch push produced a run for a
 * main-only workflow. Measured by experiment that day, on the known-good
 * file plus padding alone: 17,304 accepted, 24,094 refused. The transaction
 * is a tracked script now, piped to `bash -s` from the same protected-main
 * checkout, and the budget below keeps every remaining step far from the
 * edge rather than just under it (10.86 rule 4).
 *
 * WHO READS THIS (CLAUDE.md 10.86 rule 3). `Client Unit Tests (vitest)`, one
 * of the six required contexts in the `main protection` ruleset, runs
 * `npx vitest run tests/` over four shards in ci.yml. The publisher's own
 * `client-tests` job runs the same command and gates the bundle, so a
 * reintroduced silent guard cannot reach production through either door.
 *
 * WHAT THIS LAW DOES NOT DO. It never relaxes a refusal. Every condition the
 * publisher refused on before still refuses; the work this law protects
 * added voice, never permission.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const PUBLISHER = '.github/workflows/publish-club-arena.yml';
const ACTIVATION = '.github/scripts/publish-origin-activate.sh';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/**
 * A step's `run:` is the only place a workflow holds shell, so it is the only
 * place this scanner looks inside the YAML.
 */
export function runBlockRanges(workflow: string): Array<[number, number]> {
  const lines = workflow.split('\n');
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const opener = lines[i].match(/^(\s*)(?:-\s+)?run:\s*\|?-?\s*$/);
    if (!opener) continue;
    const indent = opener[1].length;
    let end = i + 1;
    while (end < lines.length) {
      if (lines[end].trim() === '') {
        end++;
        continue;
      }
      if (lines[end].match(/^\s*/)![0].length <= indent) break;
      end++;
    }
    ranges.push([i + 1, end]);
    i = end - 1;
  }
  return ranges;
}

/** Backslash continuations joined, so a guard and its diagnostic read as one. */
function joinContinuations(
  lines: string[],
  keep: (index: number) => boolean
): Array<{ line: number; text: string }> {
  const logical: Array<{ line: number; text: string }> = [];
  let buffered: { line: number; text: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!keep(i)) {
      buffered = null;
      continue;
    }
    const trimmed = lines[i].trim();
    buffered =
      buffered === null
        ? { line: i + 1, text: trimmed }
        : { line: buffered.line, text: `${buffered.text} ${trimmed}` };
    if (/\\$/.test(trimmed)) {
      buffered.text = buffered.text.replace(/\\$/, '');
      continue;
    }
    logical.push(buffered);
    buffered = null;
  }
  return logical;
}

export function logicalShellLines(workflow: string): Array<{ line: number; text: string }> {
  const ranges = runBlockRanges(workflow);
  return joinContinuations(workflow.split('\n'), (n) => ranges.some(([a, b]) => n >= a && n < b));
}

export function logicalScriptLines(script: string): Array<{ line: number; text: string }> {
  return joinContinuations(script.split('\n'), () => true);
}

/** `test`, `[ ... ]` and `[[ ... ]]`: the three that exit 1 and print nothing. */
const CONDITIONAL = /^(?:!\s*)?(?:test\s|\[\s|\[\[\s)/;

/**
 * A logical shell line whose LAST command is one of those three can end the
 * step with an empty log. `if`/`while`/`until` conditions cannot (their
 * failure is a branch, not an exit), and neither can `... && continue` or any
 * list whose final command is a diagnostic, because the final command is what
 * `set -e` acts on. Checking the LAST command is what catches `A || B` where
 * B is a second silent test rather than a message.
 */
export function silentGuards(
  logical: Array<{ line: number; text: string }>
): Array<{ line: number; text: string }> {
  return logical.filter(({ text }) => {
    if (/^#/.test(text)) return false;
    if (/^(?:if|elif|while|until)\b/.test(text)) return false;
    if (!CONDITIONAL.test(text)) return false;
    const commands = text.split(/\s+(?:&&|\|\|)\s+/);
    const last = commands[commands.length - 1].replace(/;\s*$/, '').trim();
    return CONDITIONAL.test(last);
  });
}

/**
 * The budget, and the two measurements it sits between. 17,304 characters was
 * accepted on 2026-09-22 and 24,094 was refused; 12,000 leaves the largest
 * remaining step (7,431) room to grow and still stops well short of the edge.
 * If you need more than this in one step, move the script to a tracked file
 * next to the activation transaction rather than raising the number.
 */
const MAX_RUN_CHARACTERS = 12_000;

describe('the publisher says what it refused', () => {
  it('has no guard that can stop the release without printing anything', () => {
    const found = [
      ...silentGuards(logicalShellLines(read(PUBLISHER))).map((g) => ({ ...g, file: PUBLISHER })),
      ...silentGuards(logicalScriptLines(read(ACTIVATION))).map((g) => ({
        ...g,
        file: ACTIVATION,
      })),
    ];
    const report = found.map((g) => `  ${g.file}:${g.line}  ${g.text}`).join('\n');
    expect(
      found,
      [
        'These lines end in a bare test/[/[[ used as a statement. Under `set -e`',
        'that exits 1 and prints nothing at all, which is how two publishes on',
        '2026-09-22 failed with an empty log (CLAUDE.md 10.86 rule 1).',
        'Give each one a diagnostic that names the path it checked, what it',
        'required and what it found, for example:',
        '',
        '  test -d "$DIR" \\',
        '    || { echo "$DIR is not a directory; found: $(ls -ld -- "$DIR" 2>&1 || true)" >&2; exit 1; }',
        '',
        'Add the message. Never widen the condition.',
        '',
        report,
      ].join('\n')
    ).toEqual([]);
  });

  it('keeps every run step far below the size that stopped the workflow parsing', () => {
    const workflow = load(read(PUBLISHER)) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const oversized: string[] = [];
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string' && step.run.length > MAX_RUN_CHARACTERS) {
          oversized.push(`${id} / ${step.name ?? '(unnamed)'}: ${step.run.length} characters`);
        }
      }
    }
    expect(
      oversized,
      [
        `A run step is over ${MAX_RUN_CHARACTERS} characters. GitHub Actions refuses a`,
        'workflow whose step is too large, and it refuses the WHOLE FILE: no job',
        'starts, the run is named after the file instead of the workflow, and no',
        'log says why. That happened on 2026-09-22 and nothing published until it',
        'was found. Move the script into a tracked file and pipe it, the way',
        `${ACTIVATION} is piped to the origin.`,
        '',
        ...oversized,
      ].join('\n')
    ).toEqual([]);
  });

  it('proves the scanner still recognises the shape it was written for', () => {
    const shell = (...body: string[]) =>
      ['jobs:', '  a:', '    steps:', '      - run: |', ...body.map((l) => `          ${l}`)].join(
        '\n'
      );
    const guards = (yaml: string) => silentGuards(logicalShellLines(yaml)).map((g) => g.text);
    expect(guards(shell('test -d "$X"'))).toEqual(['test -d "$X"']);
    expect(
      guards(shell('test -d "$X" \\', '  || { echo "$X is not a directory" >&2; exit 1; }'))
    ).toEqual([]);
    // `A || B` where B is a second silent test is still silent.
    expect(guards(shell('[ "$A" = "$B" ] || [ "$A" = "$C" ]'))).toHaveLength(1);
    // A conditional branch is not a refusal, and neither is `&& continue`.
    expect(
      guards(shell('if [ -d "$X" ]; then echo yes; fi', '[ "$NAME" = "$KEEP" ] && continue'))
    ).toEqual([]);
    // The same scanner reads the activation script, which is shell end to end.
    expect(silentGuards(logicalScriptLines('set -e\ntest -d "$X"\n')).map((g) => g.text)).toEqual([
      'test -d "$X"',
    ]);
  });

  it('names the release layout the origin transaction requires, and why', () => {
    // Shell only. The comment above those guards quotes them by name, and a
    // quoted shape is not an executable one.
    const script = read(ACTIVATION)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const required: Array<[string, string]> = [
      ['test -d "$FINAL/assets"', 'has no assets directory'],
      ['test -d "$FINAL/fonts"', 'has no fonts directory'],
      ['test -f "$FINAL/fonts/fonts.css"', 'has no regular file at'],
    ];
    const statements = logicalScriptLines(script);
    for (const [guard, says] of required) {
      const refusal = statements.find((line) => line.text.startsWith(guard));
      expect(refusal, `${guard} must still refuse`).toBeDefined();
      expect(refusal!.text, `${guard} must say what it refused`).toContain('release $SHA ' + says);
    }
    expect(script).toContain("the pool's fonts.css points into current/fonts/fonts.css");
  });

  it('refuses a bundle the origin could never accept in the job that built it', () => {
    const step = sliceBetween(
      read(PUBLISHER),
      '- name: Verify dist is complete',
      '- name: Build summary'
    );
    expect(step).toContain('require_file dist/index.html');
    expect(step).toContain('require_directory dist/assets');
    expect(step).toContain('require_directory dist/fonts');
    expect(step).toContain('require_file dist/fonts/fonts.css');
    expect(step).toContain('publication would be refused on the host');
  });

  it('pipes the activation transaction from the protected checkout, not a second publisher', () => {
    const workflow = read(PUBLISHER);
    expect(workflow).toContain(`bash -s -- \\`);
    expect(workflow).toContain(`< ${ACTIVATION}`);
    expect(workflow).not.toContain("<<'REMOTE_ACTIVATE'");
    expect(read(ACTIVATION)).toContain('set -euo pipefail');
  });

  /**
   * Run the step rather than read it. The case below needs no network: a
   * shell that names no Google Fonts stylesheet can never produce
   * fonts/fonts.css, which is the same outcome an unreachable Google Fonts
   * produced on 2026-09-22. Before this law that returned 0 and the build
   * went green carrying a bundle the origin would refuse in silence.
   */
  it('does not let the font step report success when it wrote no stylesheet', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'club-arena-font-step-'));
    try {
      mkdirSync(join(sandbox, 'x'), { recursive: true });
      writeFileSync(join(sandbox, 'x', 'index.html'), '<html><head></head><body></body></html>');
      const ran = spawnSync('node', [join(ROOT, 'scripts', 'self-host-fonts.mjs'), sandbox], {
        encoding: 'utf8',
        env: { ...process.env, CA_DIST: 'x' },
      });
      expect(ran.status, ran.stderr).toBe(1);
      expect(ran.stderr).toContain('[self-host-fonts] FAILED');
      expect(ran.stderr).toContain(join(sandbox, 'x', 'fonts', 'fonts.css'));
      expect(ran.stderr).toContain('is required in every release');
      expect(existsSync(join(sandbox, 'x', 'fonts', 'fonts.css'))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
