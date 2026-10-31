import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const requiredLobbyCases = [
  'renders the lobby shell',
  'the result count matches the number of rows on screen',
  'switching game type re-filters the list and the count stays honest',
  'selecting a row opens the game lobby panel without joining',
  'selecting a tournament reviews its card, then Details opens that event',
  'a clustered cash game reviews its game-level door without joining',
  'advanced filters open and close',
  'the bottom nav is pinned to the bottom of the viewport',
  'PLO5 1/2 Madness exposes its actual rules at 393px',
  'PLO5 1/2 Madness exposes its actual rules at 1440px',
];

export function lobbyCoverage(report) {
  const specs = [];
  function visit(suite) {
    if (!suite || typeof suite !== 'object') throw new Error('Unreadable suite');
    if (suite.specs !== undefined && !Array.isArray(suite.specs))
      throw new Error('Unreadable specs');
    if (suite.suites !== undefined && !Array.isArray(suite.suites))
      throw new Error('Unreadable suites');
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  if (!Array.isArray(report?.suites)) throw new Error('Missing suites');
  visit(report);
  const missing = requiredLobbyCases.filter((title) => {
    const matches = specs.filter(
      (spec) => spec?.title === title && /^(tests\/e2e\/)?club-lobby\.spec\.ts$/.test(spec.file)
    );
    if (matches.length !== 1) return true;
    const spec = matches[0];
    if (spec.ok !== true || !Array.isArray(spec.tests) || spec.tests.length !== 1) return true;
    const test = spec.tests[0];
    return !(
      test.projectName === 'chromium' &&
      test.expectedStatus === 'passed' &&
      test.status === 'expected' &&
      Array.isArray(test.results) &&
      test.results.length === 1 &&
      test.results[0]?.status === 'passed' &&
      test.results[0]?.retry === 0
    );
  });
  if (
    specs.length !== requiredLobbyCases.length ||
    report.notRunReason ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  ) {
    missing.push('Report must contain exactly ten error-free cases');
  }
  return { complete: missing.length === 0, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = lobbyCoverage(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.complete) process.exitCode = 1;
  } catch (error) {
    console.error(`Lobby certificate is unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
