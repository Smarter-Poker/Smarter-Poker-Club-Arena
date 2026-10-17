/**
 * Quick Join is twice its old size (Dan 2026-10-16): "ON THE 'QUICK JOIN' MAKE
 * THIS DOUBLE THE CURRENT SIZE, YOU CAN'T SEE ANYTHING... ITS TOO SMALL."
 *
 * The sheet was min(340px, 100vw - 24px) and every size inside it is cqw of
 * the console, so doubling the width doubles the art and the type. A phone
 * narrower than 704px cannot give it twice the width, so there each row's
 * type is doubled instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.css'), 'utf8');

function rule(selector: string, from = 0): string {
  const at = CSS.indexOf(`${selector} {`, from);
  expect(at).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('Quick Join is twice its old size', () => {
  it('the sheet is 680px wide where the screen allows it', () => {
    expect(rule('.multi-table-page__quickjoin')).toMatch(
      /width: min\(680px, calc\(100vw - 24px\)\);/
    );
  });

  it('on a phone each row prints its words at twice the size', () => {
    const phone = CSS.indexOf('@media (max-width: 703px)');
    expect(phone).toBeGreaterThan(0);
    expect(rule('.multi-table-page__quickjoin-name', phone)).toContain('font-size: 5.8cqw');
    expect(rule('.multi-table-page__quickjoin-tag', phone)).toContain('font-size: 4.2cqw');
    expect(rule('.multi-table-page__quickjoin-meta', phone)).toContain('font-size: 4.8cqw');
    expect(rule('.multi-table-page__quickjoin-cta', phone)).toContain('font-size: 5.2cqw');
  });
});
