import { describe, expect, it } from 'vitest';
import { financialConsoleEnumCopy } from '../e2e/helpers/financial-console-copy';

const RAW_ENUM = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
const surface = (html: string) => {
  const root = document.createElement('main');
  root.innerHTML = html;
  return root;
};

describe('financial console copy boundaries', () => {
  it('keeps a legitimate underscore username outside the enum-copy check', () => {
    const root = surface(
      '<div class="_agentIdentity_fixture"><strong>the_kicker</strong><span>Shark Club</span></div><p>Active</p>'
    );
    expect(root.textContent).toContain('the_kicker');
    expect(financialConsoleEnumCopy(root)).not.toMatch(RAW_ENUM);
  });

  it.each([
    '<div class="_agentIdentity_fixture"><strong>the_kicker</strong><span>unknown_status</span></div>',
    '<div class="_agentIdentity_fixture"><strong>the_kicker</strong></div><p>unknown_status</p>',
    '<div><strong>unknown_status</strong></div>',
  ])('still refuses raw backend copy outside the exact identity-name node: %s', (html) => {
    expect(financialConsoleEnumCopy(surface(html))).toMatch(RAW_ENUM);
  });
});
