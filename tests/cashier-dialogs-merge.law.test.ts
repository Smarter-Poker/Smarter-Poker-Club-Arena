import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE IN-TABLE CASHIER'S GEOMETRY, MEASURED (2026-10-09, cashier dialogs
 * merge). Read from the stylesheets the way tests/cashier-dialogs-launch-audit
 * .law.test.ts reads D-09, so a later edit that lets a sentence sit on the
 * painted rim, or shrinks the close below a thumb, is a red test first.
 */

const read = (path: string) => readFileSync(path, 'utf8');
const ADDON_CSS = read('src/components/table/AddOnModal.css');
const TABLE_CSS = read('src/components/table/CashierModal.css');

/** One CSS rule's declarations, by selector text (first match). */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};
const num = (block: string, property: string, unit: string): number => {
  const match = new RegExp(`(?:^|[\\s;{])${property}:\\s*([\\d.]+)${unit}`).exec(block);
  if (!match) throw new Error(`no ${property} in ${block}`);
  return Number(match[1]);
};

describe('the painted close is a 44px target on a phone', () => {
  it('grows an invisible hit area around the art, never the art itself', () => {
    const hit = rule(ADDON_CSS, '.addon-console__close::after');
    expect(hit).toContain('width: max(100%, 44px)');
    expect(hit).toContain('height: max(100%, 44px)');
    expect(hit).toContain('transform: translate(-50%, -50%)');
    // The art box keeps its measured zone (launch audit D-09).
    expect(rule(ADDON_CSS, '.purchase-console__cash .addon-console__close')).toContain(
      'height: 8.4%'
    );
  });
});

describe('a two-line sentence fits the painted well under the amount', () => {
  it('the digits plus two status lines stay inside the well zone', () => {
    // The well zone is 12% of a 1010 x 1557 canvas, in cqw of its width.
    const aspect = /aspect-ratio:\s*1010\s*\/\s*1557/.test(
      rule(ADDON_CSS, '.purchase-console__cash')
    );
    expect(aspect).toBe(true);
    const zone = num(
      rule(ADDON_CSS, '.purchase-console__cash .addon-console__timer'),
      'height',
      '%'
    );
    const zoneCqw = (zone / 100) * (1557 / 1010) * 100;

    const status = rule(TABLE_CSS, "[role='dialog'] .cashier-dialog .addon-console__timer > span");
    expect(status).toContain('text-align: center');
    const leading = num(status, 'line-height', '');
    const digits = rule(
      TABLE_CSS,
      "[role='dialog'] .cashier-dialog .purchase-console__amount.purchase-console__amount"
    );
    expect(digits).toContain('line-height: 1 !important');
    const refusal = rule(TABLE_CSS, '.cashier-error');
    const pad = num(refusal, 'padding-top', 'cqw');
    const errorLeading = num(refusal, 'line-height', '');
    const font = num(rule(ADDON_CSS, '.addon-console__timer span'), 'font-size', 'cqw');

    const stack = 10 + pad + 2 * font * Math.max(leading, errorLeading);
    expect(stack).toBeLessThanOrEqual(zoneCqw);
  });
});
