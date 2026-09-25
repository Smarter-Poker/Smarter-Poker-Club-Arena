import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Club Data's controls are painted words, and a painted word is only as wide
 * as its letters.
 *
 * `club-data-deep.spec.ts:150` measured the live page at 390px on every
 * Post-Deploy E2E run and reported fifty-two visible controls that were 44
 * tall and as narrow as 31.7: DAY, ALL, MID, the two reporting-period arrows.
 * `.word` declared `min-height: 44px` and nothing about width, so the width
 * came only from padding around three or four condensed characters and a
 * short label fell under the touch floor.
 *
 * The floor is a property of the control, not of the label that happens to be
 * inside it, so both axes are declared once on `.word` - the single rule every
 * button on this page carries. This pins that, so the next word added here
 * cannot arrive under either floor.
 */
const css = readFileSync(
  resolve(import.meta.dirname, '../../src/pages/club/ClubDataPage.module.css'),
  'utf8'
);
const page = readFileSync(
  resolve(import.meta.dirname, '../../src/pages/club/ClubDataPage.tsx'),
  'utf8'
);

function ruleBody(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `${selector} is missing from ClubDataPage.module.css`).toBeGreaterThan(-1);
  const end = css.indexOf('}', index);
  return css.slice(index, end);
}

describe('Club Data keeps every painted control on the touch floor', () => {
  it('declares the 44px floor on both axes of .word', () => {
    const word = ruleBody('.word');
    expect(word, '.word lost its width floor; short labels fall under 44px').toMatch(
      /min-width:\s*44px/
    );
    expect(word, '.word lost its height floor').toMatch(/min-height:\s*44px/);
  });

  it('routes every button on the page through .word, so one rule is enough', () => {
    const classNames = [...page.matchAll(/<button\b[\s\S]{0,240}?className=\{([^}]*)\}/g)].map(
      (match) => match[1]
    );
    expect(
      classNames.length,
      'expected the page to still render its painted buttons'
    ).toBeGreaterThan(0);
    for (const className of classNames) {
      expect(className, `a Club Data button does not carry styles.word: ${className}`).toContain(
        'styles.word'
      );
    }
  });
});
