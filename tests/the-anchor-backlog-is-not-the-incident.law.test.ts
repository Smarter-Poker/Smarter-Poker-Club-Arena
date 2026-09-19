/**
 * ===========================================================================
 *  LAW: A LEDGER ANCHOR THAT IS BEHIND IS NOT A LEDGER THAT CHANGED
 * ===========================================================================
 *
 * `ca_ledger_day_manifests` hashes each day of `chip_ledger` and stores the
 * sha in the same database as the journal it hashes, so it proves nothing to
 * anybody who does not already trust that database. `anchor-ledger-days.mjs`
 * regenerates the expected lines and compares them with
 * `docs/attestation/chip-ledger-days.tsv`, where git owns the history. That
 * file is the whole point: the attestation means something because it lives
 * somewhere the database cannot reach.
 *
 * The script already tells the two cases apart, precisely:
 *
 *   a day the file carries that now hashes differently, with no restatement
 *     explaining it            -> exit 1, with an incident write-up
 *   days the file has not caught up with
 *                              -> append them and exit 0
 *
 * The WORKFLOW did not. It ran the script and then `git diff --exit-code --
 * docs/attestation/`, which fails identically for both - and the job is
 * `contents: read` on purpose, so it cannot commit what the script just
 * generated. The moment a day passed with nobody committing the file, the job
 * went red and stayed red.
 *
 * MEASURED 2026-09-19. The job had been red since 2026-09-14. Every one of
 * the 39 days the file carried still hashed EXACTLY the same in the database;
 * there was no restatement to explain away and nothing had been altered. It
 * was red because eight days - 2026-09-11 through 2026-09-18 - had been
 * attested since and the file stopped at 2026-09-10. Meanwhile the `refresh`
 * job in the same workflow is skipped when this one fails, so the schema
 * manifest had not been regenerated either, and the whole workflow had been
 * disabled since 2026-09-14.
 *
 * That is the failure this law is about, and the file itself already names
 * it elsewhere: "a chronic alarm that never clears is the same blind spot as
 * no alarm". The strongest signal in the ledger attestation was reachable
 * only through a job that was red for a filing reason.
 *
 * So: the backlog warns and, past a bound, fails on its own terms; the
 * incident still fails and is still the only thing that raises the incident
 * issue. Two signals, two shapes, one job.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/schema-manifest-refresh.yml';
const SCRIPT = 'scripts/ci/anchor-ledger-days.mjs';
const ANCHOR = 'docs/attestation/chip-ledger-days.tsv';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const YAML = read(WORKFLOW);
const SRC = read(SCRIPT);

/**
 * The anchor step alone - from its own name to the next step's - so an
 * assertion about it cannot be satisfied or broken by a neighbour. The
 * `refresh` job in this same file legitimately uses `git diff --exit-code`,
 * which is exactly the kind of bleed a looser window would let through.
 */
const ANCHOR_STEP = sliceBetween(
  YAML,
  '- name: Anchor every day the database has attested',
  '- name: Raise the alarm'
);

/**
 * The same step with every comment line taken out. The step's header explains
 * what `git diff --exit-code` used to do, and an assertion that the command is
 * gone must not be satisfied - or broken - by prose about it. Both YAML and
 * shell comments start with `#`, so one rule covers both.
 */
const ANCHOR_STEP_CODE = ANCHOR_STEP.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('a ledger anchor that is behind is not a ledger that changed', () => {
  it('the script still treats an unexplained change as an incident', () => {
    // This is the signal everything else exists to carry. It must not become
    // a warning while making the backlog one.
    expect(SRC).toContain('A DAY THAT IS ALREADY ANCHORED NOW HASHES DIFFERENTLY');
    expect(SRC).toContain('ca_ledger_day_manifest_restatements');
    expect(SRC).toMatch(/unexplained\.length > 0[\s\S]{0,2000}process\.exit\(1\)/);
    // And it refuses an empty answer rather than calling it "nothing to do".
    expect(SRC).toMatch(/refusing/);
    expect(SRC).toContain('process.exit(2)');
    // New days are appended and are NOT a failure in the script.
    expect(SRC).toMatch(/added\.length === 0[\s\S]{0,200}process\.exit\(0\)/);
  });

  it('the workflow no longer fails merely because the file gained a line', () => {
    const block = ANCHOR_STEP_CODE;
    // The whole bug, in one command. Asserted against the code, not the
    // header that explains it.
    expect(block).not.toContain('git diff --exit-code');
    // And the header does still explain it, so the next reader knows why.
    expect(ANCHOR_STEP).toContain('git diff --exit-code');
    // It counts instead, and says how far behind it is.
    expect(block).toContain('git diff --numstat -- docs/attestation/');
    expect(block).toContain('new_days=');
    expect(block).toMatch(/::warning title=Ledger anchor::/);
  });

  it('but a backlog nobody clears eventually fails, because git is the point', () => {
    const block = ANCHOR_STEP;
    expect(block).toContain('UNANCHORED_BACKLOG_FAILS_AT');
    expect(block).toMatch(/if \[ "\$NEW" -ge "\$UNANCHORED_BACKLOG_FAILS_AT" \]/);
    expect(block).toMatch(/::error title=Ledger anchor::/);
  });

  it('the three verdicts are distinguishable, and the worst one is the default', () => {
    const block = ANCHOR_STEP;
    // Set BEFORE the script runs: under `set -e` nothing after it runs when it
    // exits 1, so the incident verdict has to be the one already written.
    const beforeNode = block.slice(0, block.indexOf('node scripts/ci/anchor-ledger-days.mjs'));
    expect(beforeNode).toContain('verdict=changed');
    expect(block).toContain('verdict=clean');
    expect(block).toContain('verdict=behind');
  });

  it('only the incident raises the incident issue', () => {
    // Filing "an anchored day now hashes differently" because the file is
    // three days behind is the crying-wolf that gets an alarm muted - and
    // this workflow has already been muted once.
    expect(YAML).toContain("if: failure() && steps.anchor.outputs.verdict == 'changed'");
    expect(YAML).not.toContain("if: failure() && steps.anchor.outcome == 'failure'");
    expect(YAML).toContain('Ledger attestation: an anchored day now hashes differently');
  });

  it('the anchor file is well formed and carries every day it claims', () => {
    const lines = read(ANCHOR)
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(40);
    const days = new Set<string>();
    for (const line of lines) {
      const cols = line.split('\t');
      expect(cols, `every row has seven columns: ${line}`).toHaveLength(7);
      expect(cols[0], `a day is a date: ${cols[0]}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cols[5], `a sha is 64 hex: ${cols[5]}`).toMatch(/^[0-9a-f]{64}$/);
      expect(['original', 'restated']).toContain(cols[6]);
      // A day may appear twice only as a restatement, never twice as original.
      const key = `${cols[0]}:${cols[6]}`;
      expect(days.has(key), `${cols[0]} appears twice as ${cols[6]}`).toBe(false);
      days.add(key);
    }
  });
});
