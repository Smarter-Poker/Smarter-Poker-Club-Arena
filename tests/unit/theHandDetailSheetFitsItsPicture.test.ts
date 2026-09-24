/**
 * THE HAND DETAIL SHEET FITS ITS PICTURE (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "PREVIOUS HAND IS CUT OFF AND DOESN'T DISPLAY PROPERLY." The phone sheet
 * opened with the console's rails running off its top edge: no crest, no
 * title, no date line. The console was taller than the 75dvh sheet, because
 * its page (.hdm-body) was a fixed 34dvh that knew nothing about the head,
 * the foot and the four fixed rows around it, and the sheet was the scroller.
 *
 * The sheet does not scroll now. The console fills it; head and foot keep
 * their painted ratio; the body gives; and the page is the one scroller. The
 * rules that make that true are pinned here, longhand by longhand, because
 * any one of them going back turns the crest into the thing that leaves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/table/HandDetailModal.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
};

describe('the sheet, the console, the page', () => {
  it('the sheet is not a scroller', () => {
    const panel = rule('.hdm-panel');
    expect(panel).toMatch(/overflow:\s*hidden;/);
    expect(panel).not.toMatch(/overflow:\s*hidden auto/);
  });

  it('the console fills the sheet and may shrink to it', () => {
    const console_ = rule('.hdm-console');
    expect(console_).toMatch(/flex:\s*1 1 auto/);
    expect(console_).toMatch(/min-height:\s*0/);
    expect(rule('.hdm-console .sc__body')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.hdm-console .sc__body')).toMatch(/min-height:\s*0/);
    expect(rule('.hdm-console .sc__body')).toMatch(/overflow:\s*hidden/);
  });

  it('the painted head and foot keep their ratio', () => {
    const fixed = rule('.hdm-console .sc__head,\n.hdm-console .sc__foot');
    expect(fixed).toMatch(/flex:\s*0 0 auto/);
  });

  it('the page is the one scroller, sized by what is left, never by the viewport', () => {
    const body = rule('.hdm-body');
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).not.toMatch(/max-height/);
    expect(CSS).not.toMatch(/\.hdm-body\s*\{[^}]*max-height:\s*\d+dvh/);
  });
});
