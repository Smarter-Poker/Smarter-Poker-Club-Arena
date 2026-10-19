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

  it('on a phone the table name has its own line, so its style is never cut off', () => {
    const phone = CSS.indexOf('@media (max-width: 703px)');
    expect(rule('.multi-table-page__quickjoin-name', phone)).toContain('flex-wrap: wrap');
    expect(rule('.multi-table-page__quickjoin-label', phone)).toContain('flex: 1 1 100%');
  });

  // 2026-10-19: rendered at 1280px with the longest live Midway Union names,
  // every desktop row cut to "Short Deck ..." or "PLO 0.25/0....", and at 393px
  // a 32-character name still lost its last word.
  it('at every width the table name takes the full row and wraps instead of being cut off', () => {
    expect(rule('.multi-table-page__quickjoin-row')).toContain('flex-wrap: wrap');
    const name = rule('.multi-table-page__quickjoin-name');
    expect(name).toContain('flex: 1 1 100%');
    expect(name).toContain('flex-wrap: wrap');
    expect(name).not.toContain('overflow: hidden');
    const label = rule('.multi-table-page__quickjoin-label');
    expect(label).toContain('flex: 1 1 100%');
    expect(label).toContain('white-space: normal');
    expect(label).not.toContain('text-overflow: ellipsis');
    expect(label).not.toContain('nowrap');
  });

  it('the sheet stays inside the screen and scrolls, so the last row and Browse Full Lobby are reachable', () => {
    const sheet = rule('.multi-table-page__quickjoin');
    expect(sheet).toMatch(/max-height: calc\(100dvh - 56px/);
    expect(sheet).toContain('overflow-y: auto');
  });

  it('a row rule sits halfway between two rows, not under the console spacing', () => {
    expect(rule('.multi-table-page__quickjoin-row + .multi-table-page__quickjoin-row')).toContain(
      'margin-top: -3cqw'
    );
  });
});
