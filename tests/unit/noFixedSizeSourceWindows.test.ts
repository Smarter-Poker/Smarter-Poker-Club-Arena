/**
 * A SOURCE PIN MAY NOT BE BOUNDED BY A MAGIC NUMBER. THIS IS THE GATE.
 *
 * 2026-08-28: a pin read a 7000-character window from a signature, comments
 * pushed the asserted code past the end of it, three assertions went red with
 * the guarded code unchanged - and because a red client suite skips
 * `sync-to-world-hub`, nothing published for the estate for 39 minutes.
 *
 * That was the fifth time. `spinEngineWiring` still carries "used to be
 * .slice(0, 1600)", `SpinSeatCount` carries "used to be .slice(0, 900)",
 * `avatarChoreographyCascade` carries "used to be rive.slice(0, 320)". Four
 * people diagnosed it correctly and each fixed only their own instance.
 *
 * Every one was converted to tests/helpers/sourceWindow.ts. MORE WERE ADDED BY
 * OTHER AGENTS WHILE THAT WAS HAPPENING, which is the whole argument for this
 * file: a cleanup nobody guards has a half-life.
 *
 * The silent direction is what makes it worth a gate. A window that can drift
 * off the end of what it guards can also drift off it while staying GREEN -
 * the assertion passes because the code it watched is no longer inside the
 * window at all.
 *
 * If this fails, do not raise a number. Use the extractor that matches the
 * shape you are pinning - sliceMethod, sliceCall, sliceBlockAfter,
 * sliceEnclosingBlock, sliceStatement, sliceCssRule, sliceSqlStatement,
 * sliceDollarQuoted, sliceYamlBlock, sliceYamlEntry, sliceBetween.
 *
 * Genuine exception (an array page, a display truncation): end the line with
 *     // window-ok: <why this is not a source pin>
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceYamlBlock } from '../helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['tests', 'server/src'];
const TEST_FILE = /\.test\.(ts|tsx)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '_archive']);

/** A window from an offset: `.slice(at, at + 260)`, `.slice(i, i + 900)`. */
const OFFSET_WINDOW = /\.slice\(\s*[A-Za-z_$][\w.$]*\s*,\s*[A-Za-z_$][\w.$]*\s*\+\s*\d{2,}\s*\)/;
/** A prefix window: `.slice(0, 1600)`. Three digits keeps short array pages out. */
const PREFIX_WINDOW = /\.slice\(\s*0\s*,\s*\d{3,}\s*\)/;

function collect(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) collect(path.join(dir, e.name), out);
    } else if (TEST_FILE.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Blank comments so a doc comment ABOUT the bad pattern is not an instance of it. */
const decomment = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

describe('no test bounds a source pin with a magic number', () => {
  it('every window is bounded by a structure, via tests/helpers/sourceWindow', () => {
    const offenders: string[] = [];

    for (const rel of DIRS.flatMap((d) => collect(d))) {
      const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Only source-reading suites: this bug cannot exist where nothing is read.
      if (!raw.includes('readFileSync')) continue;

      const rawLines = raw.split('\n');
      decomment(raw)
        .split('\n')
        .forEach((line, i) => {
          if (/\/\/\s*window-ok:/.test(rawLines[i])) return;
          if (OFFSET_WINDOW.test(line) || PREFIX_WINDOW.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${rawLines[i].trim()}`);
          }
        });
    }

    expect(
      offenders,
      'Bound the window by the structure it is about, never by a byte count.\n' +
        'See tests/helpers/sourceWindow.ts for the extractor that fits.\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});

/**
 * A GUARD MAIN CAN HIDE IS NOT A GUARD.
 *
 * 2026-09-01: four byte-bounded windows landed on main inside two hours and
 * main's CI never saw one of them. The unit job is gated behind the changed
 * files, so a docs-only commit goes green in twelve seconds without running the
 * suite - main showed an unbroken wall of ticks while carrying a red test that
 * failed on every branch touching src/ or tests/, which is every branch doing
 * real work. Three agents spent that morning discovering it one file at a time.
 *
 * This test reads source and asserts on text. No database, no build, no
 * network, well under a second. There is no reason for it to sit behind a gate
 * that can hide it, and this pin is what keeps it out from behind one.
 */
describe('this guard cannot be hidden behind the changed-files gate', () => {
  it('runs in CI ungated, on main as well as on pull requests', () => {
    const ci = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('noFixedSizeSourceWindows.test.ts');

    // The job that runs it must not be conditioned on anything - not on the
    // event, and not on the `changes` job whose whole purpose is to skip work.
    const job = sliceYamlBlock(ci, 'source_windows:');
    expect(job).toContain('noFixedSizeSourceWindows.test.ts');
    expect(job, 'the source-window guard must not be gated').not.toMatch(/^\s{4}if:/m);
    expect(job, 'and must not wait on the changed-files job').not.toContain('needs: changes');
  });
});
