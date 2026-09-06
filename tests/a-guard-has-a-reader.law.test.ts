// ---------------------------------------------------------------------------
// LAW: this repo can see its own red main, and the alarm can actually fire.
//
// 2026-09-06. CLAUDE.md 10.83 has said since the day it was written that a
// detector raises an issue for any workflow red on `main` with nobody watching.
// It named the World Hub's copy. CLUB ARENA DID NOT HAVE ONE - so every agent
// reading Club Arena's CLAUDE.md was told a guard was watching this repo when
// nothing was, which is worse than the gap, because it stops people looking.
//
// Pointed at Club Arena for the first time, the detector found three workflows
// failing on main with no open issue naming any of them:
//
//   CI - Build & Type Safety                  1.4h, last green 11:00:19Z
//   Applied Migrations Are Recorded           1.0h, no green in the window
//   Deploy Monitoring (infra/monitoring)      0.3h, no green in the window
//
// The third is the argument in one line: check-alert-rules-match.mjs could not
// read the running rules off engine-01 and REFUSED TO PASS, doing exactly what
// 10.84 designed it to do - and the refusal reached nobody.
//
// So this law pins the detector AND its reader. A watchdog whose alarm cannot
// fire is the same bug one level up (CLAUDE.md 10.86 rule 4).
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DETECTOR = 'scripts/ci/check-main-is-green.mjs';
const HOST = '.github/workflows/publish-watchdog.yml';

/** The `main_is_green` job block, from its key to the next top-level job. */
function mainIsGreenJob(wf: string): string | null {
  const start = wf.indexOf('\n  main_is_green:');
  if (start === -1) return null;
  const rest = wf.slice(start + 1);
  const next = rest.search(/\n {2}[a-z_][a-z0-9_]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('a guard has a reader', () => {
  it('the red-main detector exists in THIS repo', () => {
    expect(
      existsSync(join(ROOT, DETECTOR)),
      `${DETECTOR} is missing. CLAUDE.md 10.83 promises this repo raises an issue ` +
        'for any workflow red on main with nobody watching. Without the file, that ' +
        'promise is a sentence describing another repository.'
    ).toBe(true);
  });

  it('something actually runs it on a schedule', () => {
    const wf = read(HOST);
    expect(wf, `${HOST} must invoke ${DETECTOR}`).toContain(DETECTOR);
    expect(wf, `${HOST} must carry a schedule; a detector nothing triggers is a file`).toMatch(
      /\n\s*schedule:/
    );
    const job = mainIsGreenJob(wf);
    expect(job, `${HOST} must define a main_is_green job`).toBeTruthy();
  });

  it('the alarm runs where gh exists and may write issues', () => {
    const wf = read(HOST);
    const job = mainIsGreenJob(wf)!;

    // `gh` is preinstalled on GitHub-hosted runners and is NOT guaranteed on
    // the estate's self-hosted boxes. An alarm that shells out to `gh` from a
    // runner without it fails silently - the detector goes red, the issue is
    // never filed, and this repo is back to a guard with no reader.
    expect(
      job,
      'the main_is_green job must pin runs-on: ubuntu-latest. It shells out to ' +
        '`gh`, which self-hosted runners do not guarantee, and an alarm must not ' +
        'share a failure domain with the boxes it is watching.'
    ).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(job, 'the alarm must not be routed to vars.CI_RUNNER').not.toMatch(/vars\.CI_RUNNER/);

    // Raising and clearing are both required: an alarm that cannot close
    // itself becomes wallpaper, and wallpaper is what 10.83 is about.
    expect(job, 'the job must raise an issue when the detector exits 1').toMatch(/gh issue create/);
    expect(job, 'the job must close the issue when main is green again').toMatch(/gh issue close/);

    // `permissions: issues: write` is declared at workflow level here.
    expect(wf, `${HOST} must declare issues: write, or gh issue create 403s`).toMatch(
      /issues:\s*write/
    );
  });

  it('the detector reads the exit code of the script, not of the pipe', () => {
    const job = mainIsGreenJob(read(HOST))!;
    // `node ... | tee` always exits with tee's status, so reading `$?` reports
    // every run as clean and the alarm never fires. Same trap the cron-fleet
    // step in this workflow already documents.
    //
    // MATCH THE ASSIGNMENT, NOT THE WORD. The first draft of this pin was
    // `toContain('PIPESTATUS[0]')` and it passed against the COMMENT above the
    // code explaining why PIPESTATUS matters - so swapping the real line for
    // `code=$?` left the law green. A pin satisfied by prose about itself is
    // the false all-clear this whole law exists to prevent (CLAUDE.md 10.86).
    const assigns = job
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .some((l) => /code=\$\{PIPESTATUS\[0\]\}/.test(l));
    expect(
      assigns,
      'the alarm must ASSIGN from ${PIPESTATUS[0]} on a real (non-comment) line. ' +
        '`tee` always succeeds, so a check piped through it and read with `$?` ' +
        'reports success no matter what the detector found.'
    ).toBe(true);
  });

  it('CLAUDE.md no longer claims another repo is watching this one', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('check-main-is-green.mjs');
    // The exact phrasing that made the gap invisible: naming the World Hub as
    // the host of a detector inside Club Arena's own instructions.
    expect(
      /check-main-is-green\.mjs`?\s*\(World Hub/.test(claude),
      "CLAUDE.md 10.83 must not describe the World Hub's copy as though it covered " +
        'this repo. That sentence is why nobody noticed Club Arena had no detector.'
    ).toBe(false);
  });
});
