/**
 * ===========================================================================
 *  LAW: NO WORKFLOW GAINS A NEW TIMER
 * ===========================================================================
 *
 * MEASURED 2026-09-19: 11 `- cron:` lines across 9 of this repo's workflow
 * files, and nothing in the estate knew that number.
 *
 * CLAUDE.md 10.85 says scheduled work does not go on a new trigger without
 * cause, and three separate law tests enforce that for exactly ONE file -
 * schema-manifest-refresh.yml, asserted `<= 2` in
 * tests/the-second-writer-is-audited.law.test.ts and twice in
 * tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts. Every
 * other workflow was covered by nobody.
 *
 * WHY AN ALLOWLIST OF FILE+SCHEDULE PAIRS, NOT A COUNT. A count of 11 is blind
 * to the change that actually costs. estate-integrity.yml moving from every
 * four hours to every minute keeps the count at 11 and multiplies its runs by
 * 240 - and that cadence was already tuned down once in a cost audit, which the
 * file records at its own schedule block. A file+schedule pair fails on a new
 * line, a moved line AND a changed cadence, and its diff names the job.
 *
 * (Cron expressions are deliberately not quoted in this docblock: a schedule
 * containing a slash-star sequence closes a JSDoc comment early, which broke
 * this very file once. They live in TIMERS below, as data.)
 *
 * WHY NOT A HASH. ci.yml changes constantly; a directory hash would be red for
 * unrelated reasons most days, which is the failure this estate already wrote
 * up: a job red for an unrelated reason is how the real signal became
 * invisible.
 *
 * THE ONE THAT MATTERS LATER: the list below IS the guard. A new timer fails
 * the first test, a deleted one fails the second, so retiring a schedule is as
 * visible as adding one.
 *
 * ASSERTING THE NEGATIVE (CLAUDE.md 7.3): timers are counted with YAML `#`
 * comments stripped, quote-aware so `'13 9 * * 1' # Mondays` keeps its value.
 * blankNonCode in tests/helpers/sourceWindow.ts understands JavaScript
 * comments and knows neither SQL's `--` nor YAML's `#`, and this law's whole
 * subject is a line a future workflow header will one day quote while
 * explaining why it must not be added. Measured today: raw and stripped both
 * count 11, so the stripper changes nothing now and is what keeps that future
 * comment from tripping the gate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/** Every timer this repository runs. Measured 2026-09-19: 11 across 9 files. */
const TIMERS: ReadonlyArray<readonly [string, string]> = [
  ['applied-migrations-recorded.yml', '25 7,19 * * *'],
  ['ci.yml', '17 */2 * * *'],
  ['ci.yml', '35 6 * * *'],
  ['cron-health.yml', '40 1,7,13,19 * * *'],
  ['estate-digest.yml', '7 11 * * *'],
  ['estate-integrity.yml', '17 */4 * * *'],
  ['production-integrity-audit.yml', '19 * * * *'],
  ['schema-manifest-refresh.yml', '20 5 * * *'],
  ['schema-manifest-refresh.yml', '40 * * * *'],
  ['secrets-expiry.yml', '13 9 * * 1'],
  ['telemetry-exposure.yml', '10 6,18 * * *'],
];

/** Blank YAML `#` comments, quote-aware so a trailing note keeps its value. */
export const yamlCode = (src: string): string =>
  src
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');

/** Every schedule a YAML document actually declares, comments discarded. */
export const cronLines = (yaml: string): string[] =>
  [...yamlCode(yaml).matchAll(/^[ \t]*-[ \t]*cron:[ \t]*(.+?)[ \t]*$/gm)].map((m) =>
    m[1].replace(/^['"]|['"]$/g, '').trim()
  );

const workflowFiles = (): string[] =>
  readdirSync(WORKFLOWS)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort();

function liveTimers(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const f of workflowFiles()) {
    for (const s of cronLines(readFileSync(join(WORKFLOWS, f), 'utf8'))) out.push([f, s]);
  }
  return out;
}

const key = ([f, s]: readonly [string, string]): string => `${f}  ${s}`;

describe('no workflow gains a new timer', () => {
  const found = liveTimers();

  it('every timer that runs is one this law names', () => {
    const allowed = new Set(TIMERS.map(key));
    const added = found.map(key).filter((k) => !allowed.has(k));
    expect(
      added,
      'a workflow schedule was added, or an existing cadence changed. ' +
        'CLAUDE.md 10.85: scheduled work does not go on a new trigger without ' +
        'cause. Carry the check on a schedule that already exists. If the timer ' +
        'is genuinely new, add it to TIMERS in this file together with the ' +
        'measurement that justifies its cadence.'
    ).toEqual([]);
  });

  it('every timer this law names still exists, so retiring one is visible too', () => {
    const live = new Set(found.map(key));
    const gone = TIMERS.map(key).filter((k) => !live.has(k));
    expect(
      gone,
      'this law names a schedule that no longer exists. If it was deliberately ' +
        'retired, delete its entry in the same change; if it was not, the ' +
        'deletion is a regression and the schedule should come back.'
    ).toEqual([]);
  });

  it('the surface is the size it was measured at', () => {
    expect(found).toHaveLength(TIMERS.length);
    expect(TIMERS).toHaveLength(11);
    expect(new Set(TIMERS.map(([f]) => f)).size).toBe(9);
  });

  it('schema-manifest-refresh keeps the two that three other laws bound it to', () => {
    // tests/the-second-writer-is-audited.law.test.ts and
    // tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts each
    // assert `- cron:` <= 2 in that file. Exactly two here satisfies all three
    // and can never contradict them; all four move together or not at all.
    expect(found.filter(([f]) => f === 'schema-manifest-refresh.yml')).toHaveLength(2);
  });

  it('the three scheduled audits can be run on demand', () => {
    // Adding workflow_dispatch is not adding a schedule. Without it, verifying
    // a fix means waiting up to six hours for the next tick.
    for (const f of ['cron-health.yml', 'estate-integrity.yml', 'schema-manifest-refresh.yml']) {
      expect(yamlCode(readFileSync(join(WORKFLOWS, f), 'utf8')), f).toMatch(
        /^ {2}workflow_dispatch:/m
      );
    }
  });

  it('reads a commented-out timer as prose, not as a schedule', () => {
    expect(
      cronLines("on:\n  schedule:\n    # - cron: '* * * * *'\n    - cron: '0 0 * * *'\n")
    ).toEqual(['0 0 * * *']);
    // ...and a trailing comment never eats the schedule it annotates. This is
    // the live shape in secrets-expiry.yml.
    expect(cronLines("    - cron: '13 9 * * 1' # Mondays 09:13 UTC\n")).toEqual(['13 9 * * 1']);
  });
});
