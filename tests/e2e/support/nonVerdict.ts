import { appendFileSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';

/**
 * nonVerdict.ts - the third outcome, said out loud.
 *
 * CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
 * have its own name. Never fold it into pending, green, empty, zero OR SILENCE.
 * A bare `test.skip()` is silence, so a non-verdict recorded here is:
 *
 *   - a `::warning::UNKNOWN:` line, which colours the run in the Actions log;
 *   - a NON-VERDICT paragraph in the job summary, which is what a person reads;
 *   - a `non-verdict` annotation on the test, which is in the Playwright JSON
 *     report and therefore in the artifact and in
 *     `scripts/ci/assert-e2e-actually-ran.mjs`'s "why did this skip" column;
 *   - the evidence that produced it, attached.
 *
 * This is the same vocabulary `scripts/ci/production-e2e-provenance.mjs` uses
 * for a superseded release window (`::warning::UNKNOWN`, `NON-VERDICT`,
 * exit 3) and it is deliberately the same rather than a second dialect.
 *
 * IT CANNOT HIDE A RUN THAT VERIFIED NOTHING. `assert-e2e-actually-ran.mjs`
 * fails any spec FILE in which every test skipped, so a non-verdict is only
 * ever survivable while its siblings in the same file really ran.
 */
export const NON_VERDICT_ANNOTATION = 'non-verdict';

export function formatNonVerdict(title: string, detail: string): string {
  return `${title}: ${detail}`;
}

export async function recordNonVerdict(
  testInfo: TestInfo,
  options: { title: string; detail: string; evidence?: Record<string, unknown>; tag?: string }
): Promise<string> {
  const description = formatNonVerdict(options.title, options.detail);
  testInfo.annotations.push({ type: NON_VERDICT_ANNOTATION, description });
  console.log(`::warning::UNKNOWN: ${description}`);
  if (options.evidence) {
    await testInfo.attach(`${options.tag || 'non-verdict'}-evidence`, {
      body: Buffer.from(JSON.stringify(options.evidence, null, 2)),
      contentType: 'application/json',
    });
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(
        summaryPath,
        `\nNON-VERDICT: ${description}\nThis run neither certified nor condemned that subject.\n`
      );
    } catch {
      /* The summary is a nicety; the warning and the annotation are the record. */
    }
  }
  return description;
}
