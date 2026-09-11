// ---------------------------------------------------------------------------
// LAW: this repo can see its own red main, and the audit actually fails.
//
// 2026-09-06. CLAUDE.md 10.83 has said since the day it was written that a
// detector reports any workflow red on `main` with nobody watching.
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
// So this law pins the detector, its durable issue reader, and its native
// Actions verdict. A detector whose alarm cannot fire is the same bug one
// level up.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DETECTOR = 'scripts/ci/check-main-is-green.mjs';
const HOST = '.github/workflows/production-integrity-audit.yml';

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
      `${DETECTOR} is missing. CLAUDE.md 10.83 promises this repo reports ` +
        'any workflow red on main with nobody watching. Without the file, that ' +
        'promise is a sentence describing another repository.'
    ).toBe(true);
  });

  it('the read-only production integrity audit actually runs it', () => {
    const wf = read(HOST);
    expect(wf, `${HOST} must invoke ${DETECTOR}`).toContain(DETECTOR);
    expect(wf, `${HOST} must carry a schedule; a detector nothing triggers is a file`).toMatch(
      /\n\s*schedule:/
    );
    const job = mainIsGreenJob(wf);
    expect(job, `${HOST} must define a main_is_green job`).toBeTruthy();
  });

  it('the alarm runs independently, names a reader, and carries its verdict', () => {
    const wf = read(HOST);
    const job = mainIsGreenJob(wf)!;

    // The audit must not share a failure domain with the self-hosted boxes it
    // watches. The only side effect is its named, durable issue reader; it has
    // no release, repair, or production mutation authority.
    expect(
      job,
      'the main_is_green job must pin runs-on: ubuntu-latest so the alarm does ' +
        'not share a failure domain with the boxes it is watching.'
    ).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(job, 'the alarm must not be routed to vars.CI_RUNNER').not.toMatch(/vars\.CI_RUNNER/);

    expect(job).toContain('CODE: ${{ steps.main-green.outputs.code }}');
    expect(job).toContain('exit "$CODE"');
    expect(job).toMatch(/gh issue create/);
    expect(job).toMatch(/gh issue edit/);
    expect(job).toMatch(/gh issue close/);
    expect(job).toContain("steps.main-green.outputs.code == '1'");
    expect(job).toContain("steps.main-green.outputs.code == '0'");
    expect(job).toContain("OK - every workflow's latest VERDICT on main is green.");
    expect(job).toContain('Reader workflow: `Production Integrity Audit`');
    expect(job).toContain('club-arena:production-integrity-main-health:v1');
    expect(job).toContain('main-health-reader');
    expect(job).toContain('--label "$LABEL"');
    expect(job).toContain('.title == $title');
    expect(job).toContain('contains($marker)');
    expect(job).toContain('.name == $label');
    expect(wf).toMatch(/issues:\s*write/);
    expect(job).not.toMatch(/repository\/dispatches|workflow\s+(?:enable|disable)|ssh\s/);
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

  it('creates the ownership label only when an alarm needs it', () => {
    const job = mainIsGreenJob(read(HOST))!;
    const raiseStart = job.indexOf('- name: Raise the durable alarm');
    const closeStart = job.indexOf('- name: Close the alarm');
    const carryStart = job.indexOf('- name: Carry the main-health verdict');
    const raise = job.slice(raiseStart, closeStart);
    const close = job.slice(closeStart, carryStart);

    expect(raise).toContain('gh label list');
    expect(raise).toContain('gh label create "$LABEL"');
    expect(raise).not.toContain('--force');
    expect(close).toContain('gh label list');
    expect(close).not.toContain('gh label create');
  });

  it('validates exact ownership independently before both edit and close', () => {
    const job = mainIsGreenJob(read(HOST))!;
    const issueLists = job.match(/gh issue list[\s\S]*?--json number,title,body,labels/g) ?? [];

    expect(issueLists).toHaveLength(2);
    for (const command of issueLists) {
      expect(command).toContain('--label "$LABEL"');
      expect(command).not.toContain('--search');
    }
    for (const exactOwnershipCheck of [
      '.title == $title',
      'contains($marker)',
      'any(.labels[]?; .name == $label)',
      'multiple exact production-integrity main-health issues',
    ]) {
      expect(job.split(exactOwnershipCheck)).toHaveLength(3);
    }
    expect(job).toMatch(/^\s*echo "\$OWNER_MARKER"$/m);
    expect(job).toMatch(/gh issue create[\s\S]{0,180}?--label "\$LABEL"/);
    for (const sharedIdentity of [
      'TITLE="A workflow has been failing on main with nobody watching"',
      'LABEL="main-health-reader"',
      "OWNER_MARKER='<!-- club-arena:production-integrity-main-health:v1 -->'",
    ]) {
      expect(job.split(sharedIdentity)).toHaveLength(3);
    }
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
