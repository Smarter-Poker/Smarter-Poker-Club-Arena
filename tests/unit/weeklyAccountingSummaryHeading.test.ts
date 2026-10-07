import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';

const name = 'Club Weekly Accounting';

describe('linked weekly accounting summary heading', () => {
  it('selects the actual summary when the standalone run has the same heading', () => {
    const root = document.createElement('main');
    root.innerHTML = `<section><h2>${name}</h2></section><section aria-label="${name}"><h3>${name}</h3></section>`;
    expect(() => within(root).getByRole('heading', { name, exact: true })).toThrow();
    const region = within(root).getByRole('region', { name, exact: true });
    expect(within(region).getByRole('heading', { name, exact: true, level: 3 }).tagName).toBe('H3');
    const spec = readFileSync(
      resolve(import.meta.dirname, '../e2e/financial-admin-deep.spec.ts'),
      'utf8'
    );
    const summaryAssertion = spec.slice(
      spec.indexOf("case 'Settlement Center':"),
      spec.indexOf("case 'CSV Exports':")
    );
    expect(summaryAssertion).toContain(
      "getByRole('region', { name: 'Club Weekly Accounting', exact: true })"
    );
    expect(summaryAssertion).toContain('level: 3');
  });
  it('refuses a missing summary instead of accepting the standalone run heading', () => {
    const root = document.createElement('main');
    root.innerHTML = `<section><h2>${name}</h2></section>`;
    expect(() => within(root).getByRole('region', { name, exact: true })).toThrow();
  });
});
