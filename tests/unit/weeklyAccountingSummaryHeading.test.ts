import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';

// The Settlement Center workspace owns "Club Weekly Accounting" (h2); the issued
// summaries below it are "Club Weekly Summaries" (region + h3) since #6372, when
// the duplicate heading Post-Deploy E2E run 37569802965 found was renamed.
const workspace = 'Club Weekly Accounting';
const summary = 'Club Weekly Summaries';

const settlementCenterAssertion = () => {
  const spec = readFileSync(
    resolve(import.meta.dirname, '../e2e/financial-admin-deep.spec.ts'),
    'utf8'
  );
  return spec.slice(spec.indexOf("case 'Settlement Center':"), spec.indexOf("case 'CSV Exports':"));
};

describe('linked weekly accounting summary heading', () => {
  it('selects the workspace heading and the actual summary, each exactly once', () => {
    const root = document.createElement('main');
    root.innerHTML = `<section><h2>${workspace}</h2></section><section aria-label="${summary}"><h3>${summary}</h3></section>`;
    expect(
      within(root).getByRole('heading', { name: workspace, exact: true, level: 2 }).tagName
    ).toBe('H2');
    const region = within(root).getByRole('region', { name: summary, exact: true });
    expect(
      within(region).getByRole('heading', { name: summary, exact: true, level: 3 }).tagName
    ).toBe('H3');
    const assertion = settlementCenterAssertion();
    expect(assertion).toContain(
      `getByRole('heading', { name: '${workspace}', exact: true, level: 2 })`
    );
    expect(assertion).toContain(`getByRole('region', { name: '${summary}', exact: true })`);
    expect(assertion).toContain(
      `getByRole('heading', { name: '${summary}', exact: true, level: 3 })`
    );
  });

  it('refuses a missing summary instead of accepting the workspace heading alone', () => {
    const root = document.createElement('main');
    root.innerHTML = `<section><h2>${workspace}</h2></section>`;
    expect(() => within(root).getByRole('region', { name: summary, exact: true })).toThrow();
  });

  it('refuses the old duplicate, which named the summary after the workspace', () => {
    const root = document.createElement('main');
    root.innerHTML = `<section><h2>${workspace}</h2></section><section aria-label="${workspace}"><h3>${workspace}</h3></section>`;
    expect(() => within(root).getByRole('region', { name: summary, exact: true })).toThrow();
  });
});
