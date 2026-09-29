/**
 * LAW: a release that protected main outran is carried or stood down, never
 *      mistaken for a broken build.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `source_target_is_current()` in server/scripts/engine-release-transaction.sh
 * is the freshness proof every stage of a release re-runs. Two claims about it
 * were made on 2026-09-26 and only one was true.
 *
 * NOT TRUE: "a merge during a break killed the 02:44 cutover of 399d59f8 with
 * FORWARD TARGET BEHIND MAIN". That line is a WARNING, and has been since
 * #4539: a target that is in protected main and contains the sealed
 * high-water proceeds, with every certificate and cutover proof still
 * mandatory, and only its seal reason records the newer engine. Run
 * 36212130903 printed it four times and then died on line 1453 - the in-flight
 * helper's announcement captured as the remaining-milliseconds figure, the
 * stdout fault #5273 fixed. Section 1 pins the warning as a warning, so the
 * next reader of that log does not "fix" merge discipline for a fault that was
 * never there.
 *
 * TRUE: when two exact-SHA requests run side by side (the workflow's
 * concurrency group is per SHA), the newer can seal first. Run 36216296821
 * (target 31ee0764, merged #5280) then found sealed high-water f1d956c3 - a
 * release that already CONTAINS it - and died "does not contain the sealed
 * high-water release". The refusal is right; the words were not. The
 * workflow's classify_release_failure and check-engine-deploy-starvation.mjs
 * recognise a stand-down only by "is stale; protected main requires <sha>",
 * which nothing had printed since #4539, so the receipt read "the durable
 * Hetzner release transaction did not complete". Section 2 pins the refusal
 * (still status 1, still before mutation) in the classifier's words, and
 * section 3 pins that a genuinely unrelated target keeps its own refusal.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const TRANSACTION = readFileSync(
  join(ROOT, 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');

const fn = (name: string) => {
  const start = TRANSACTION.indexOf(`\n${name}() {`);
  expect(start, name).toBeGreaterThan(0);
  return TRANSACTION.slice(start, TRANSACTION.indexOf('\n}\n', start) + 3);
};
const SOURCE = fn('source_target_is_current');

const A = 'a'.repeat(40); // older merge
const B = 'b'.repeat(40); // newer merge, descends from A
const C = 'c'.repeat(40); // protected main tip, descends from B
const X = 'e'.repeat(40); // unrelated to the sealed line
const TREE = 'f'.repeat(40);

/** A fake PATH: git answers from ANCESTRY ("child>parent" pairs), timeout runs its command. */
function fakeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  const w = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  w('timeout', 'while [[ "$1" == --* ]]; do shift; done; shift; exec "$@"');
  w('flock', 'exit 0');
  w('seal', 'echo "$HIGH_WATER"');
  w(
    'git',
    `while [ "$1" = -C ]; do shift 2; done
case "$1" in
  fetch|cat-file) exit 0 ;;
  rev-parse)
    case "$3" in *:server) echo ${TREE} ;; *) echo "$MAIN" ;; esac ;;
  log) echo "$LATEST" ;;
  merge-base)
    [ "$3" = "$4" ] && exit 0
    for pair in $ANCESTRY; do [ "$pair" = "$4>$3" ] && exit 0; done
    exit 1 ;;
  *) exit 9 ;;
esac`
  );
  return dir;
}

function run({
  target,
  main,
  latest,
  highWater,
}: {
  target: string;
  main: string;
  latest: string;
  highWater: string;
}) {
  const bin = fakeBin();
  // C > B > A, and C > X where X is a sibling of the sealed line.
  const ancestry = [`${B}>${A}`, `${C}>${A}`, `${C}>${B}`, `${C}>${X}`].join(' ');
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
die() { echo "[engine-release-transaction] FATAL: $*" >&2; exit 1; }
remaining_seconds() { echo 600; }
DEADLINE=$(( $(date +%s) + 600 ))
BREAK_END_EPOCH=0
SOURCE_LOCK="$TMPDIR_LOCK"
REPO_DIR=/nonexistent
RELEASE_SEAL="$BIN/seal"
SHA="$TARGET"
SUPERSEDED_BY=''
${SOURCE}
source_target_is_current
echo "SUPERSEDED_BY=$SUPERSEDED_BY"`,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BIN: bin,
        TMPDIR_LOCK: join(bin, 'lock'),
        TARGET: target,
        MAIN: main,
        LATEST: latest,
        HIGH_WATER: highWater,
        ANCESTRY: ancestry,
      },
    }
  );
}

/** What the workflow's classifier extracts from a log line, byte for byte. */
function classify(log: string): string {
  const sed = WORKFLOW.match(/stale="\$\(sed -n '([^']+)'/);
  expect(sed, 'classify_release_failure sed').toBeTruthy();
  const out = spawnSync('sed', ['-n', sed![1]], { input: log, encoding: 'utf8' });
  return out.stdout.trim().split('\n').pop() ?? '';
}

describe('1. a target main has moved past is still carried to the cutover', () => {
  it('proceeds, warns, and records the newer engine for the seal reason', () => {
    const result = run({ target: B, main: C, latest: C, highWater: A });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('FORWARD TARGET BEHIND MAIN');
    expect(result.stderr).not.toContain('FATAL');
    expect(result.stdout).toContain(`SUPERSEDED_BY=${C}`);
  });

  it('proceeds silently when it is the latest engine', () => {
    const result = run({ target: C, main: C, latest: C, highWater: B });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SUPERSEDED_BY=\n');
  });

  it('the warning is not a die in the source', () => {
    expect(SOURCE).toMatch(/echo "\[engine-release-transaction\] FORWARD TARGET BEHIND MAIN/);
    expect(SOURCE).not.toMatch(/die[^\n]*FORWARD TARGET BEHIND MAIN/);
  });
});

describe('2. a target a sealed release already contains stands down in the words the classifier reads', () => {
  it('refuses with status 1 and names the sealed release that carries it', () => {
    const result = run({ target: A, main: C, latest: C, highWater: B });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`target ${A} is stale; protected main requires ${B}`);
    // The older phrase is kept in the same line, so every reader of it
    // (tests/operations/engine-release-forward-admission.py) still matches.
    expect(result.stderr).toContain(`does not contain the sealed high-water release ${B}`);
  });

  it('the workflow classifier turns that line into result=superseded for the sealed SHA', () => {
    const result = run({ target: A, main: C, latest: C, highWater: B });
    expect(classify(result.stderr)).toBe(B);
  });

  it('negative proof: the old wording was invisible to the classifier', () => {
    expect(
      classify(
        `[engine-release-transaction] FATAL: target ${A} does not contain the sealed high-water release ${B}`
      )
    ).toBe('');
  });
});

describe('3. a target off the sealed line keeps its own refusal', () => {
  it('an unrelated target is not called superseded', () => {
    const result = run({ target: X, main: C, latest: C, highWater: B });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not contain the sealed high-water release');
    expect(result.stderr).not.toContain('is stale');
  });
});
