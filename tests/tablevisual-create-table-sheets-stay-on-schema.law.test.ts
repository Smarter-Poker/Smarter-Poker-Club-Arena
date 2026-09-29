/**
 * THE CREATE-TABLE SHEETS STAY ON THE SCHEMA (Create A Club phase 2, 2026-09-20)
 *
 * Static regression for three stylesheets that print inside a painted
 * SpadeConsole: the New Cash Game flow, the Table Config form and the game
 * type selector. Each of these came back once already: the cash flow's brown
 * ramp was removed on 2026-09-09 and the shared preset chip kept it for
 * eleven more days, because nothing failed when it was there.
 *
 * Comments are stripped first. The sheets are allowed to NAME what they
 * removed; they are not allowed to use it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHEETS = [
  'src/components/cash/CashGameCreateFlow.css',
  'src/pages/TableConfigPage.css',
  'src/pages/CreateTablePage.css',
] as const;

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const normalise = (css: string) => code(css).toLowerCase().replace(/\s+/g, '');

/** Every off-schema colour this pass removed, in the spellings it had. */
const REMOVED = [
  // the brown / amber preset chip and the cash flow's first palette
  'rgba(38,24,8',
  'rgb(38248',
  'rgba(255,158,44',
  '#ff9e2c',
  '#ffcf7d',
  '#d9c9a8',
  '#b8a888',
  // the purple-navy fills and the off-schema red
  '#1a1a2e',
  '#dc2626',
  // computed blues and greys that stood in for the blue, white and muted inks
  '#72c4ff',
  '#65c5ff',
  '#79c5ff',
  '#8fc1ff',
  '#67c7ff',
  '#48b5f4',
  '#69baff',
  '#d8edff',
  '#eef7ff',
  '#c9d8e7',
  '#aeb5c0',
  '#07121f',
  '#087bc1',
  '#343942',
  '#33414e',
  '#18212a',
  '#0b4f78',
  '#05080c',
];

describe.each(SHEETS)('%s', (path) => {
  const css = read(path);

  it('has no pointer-over rule, in a selector or anywhere else', () => {
    expect(code(css)).not.toMatch(/:hover/i);
    expect(code(css)).not.toMatch(/@media[^{]*\(\s*(any-)?hover/i);
  });

  it('uses none of the off-schema colours that were removed from it', () => {
    const flat = normalise(css);
    const back = REMOVED.filter((c) => flat.includes(c.replace(/\s+/g, '')));
    expect(back, `off-schema colour(s) back in ${path}: ${back.join(', ')}`).toEqual([]);
  });

  it('has no em dash in any string it prints', () => {
    const printed = code(css).match(/content:\s*(['"]).*?\1/g) ?? [];
    expect(printed.filter((s) => s.includes('—'))).toEqual([]);
  });
});

describe('the New Cash Game flow draws nothing: the console is the frame', () => {
  const css = code(read('src/components/cash/CashGameCreateFlow.css'));

  it('no corner radius, no gradient, no drawn shadow plate', () => {
    const radii = css.match(/border-radius:[^;]+;/g) ?? [];
    expect(radii.filter((r) => !/^border-radius:\s*0;$/.test(r))).toEqual([]);
    expect(css).not.toMatch(/gradient\(/);
    // The only box-shadow allowed is `none` or the one-pixel engraved lip.
    const shadows = css.match(/box-shadow:[^;]+;/g) ?? [];
    for (const s of shadows) {
      expect(s, s).toMatch(/box-shadow:\s*(none|(inset )?0 1px 0 rgb\(255 255 255 \/ 8%\));/);
    }
  });

  it('every colour is one of the console inks', () => {
    // The four console inks, black for the engraved cut, and the kit's own
    // focus ring (SpadeConsole.css draws #8fd4ff on its plates).
    const INKS = ['#e4e7ec', '#f4f7fb', '#45adff', '#9aa5b3', '#000', '#8fd4ff'];
    const hexes = [...new Set(css.toLowerCase().match(/#[0-9a-f]{3,8}\b/g) ?? [])];
    expect(hexes.filter((h) => !INKS.includes(h))).toEqual([]);
    // Alpha tones are an ink at reduced alpha over black, never a new colour:
    // white (the engraved lip and the bevel), blue, muted.
    const rgbs = [...new Set(css.match(/rgba?\(([^)]+)\)/g) ?? [])];
    const allowed = /^rgba?\((255 255 255|69 173 255|154 165 179) \/ \d+%\)$/;
    expect(rgbs.filter((c) => !allowed.test(c))).toEqual([]);
    // And it no longer borrows another authority's palette for a surface that
    // lives inside this one.
    expect(css).not.toMatch(/--realism-/);
  });

  it('the flow footer sits in flow: sticky inside .config-options only lifted it over the last step', () => {
    expect(css).toMatch(/\.cash-create \.cash-create__footer\s*\{\s*position:\s*static;\s*\}/);
  });

  it('a promise row never squeezes its label under a long value', () => {
    // "One Small Blind From Each Dealt In Player" once collapsed a grid label
    // column to nothing and printed over "Ante".
    expect(css).toMatch(
      /\.cash-create__rule-readout__label\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/
    );
    expect(css).toMatch(/\.cash-create__rule-readout__value\s*\{[^}]*min-width:\s*0;/);
    expect(css).not.toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*auto\)/);
  });

  it('a selected choice is told by ink on a lit rule', () => {
    expect(css).toMatch(
      /\.cash-create__card\.is-selected\s*\{[^}]*border-bottom-color:\s*#45adff;[^}]*color:\s*#f4f7fb;/
    );
    expect(css).toMatch(
      /\.cash-create__chip\.is-selected\s*\{[^}]*border-bottom-color:\s*#45adff;[^}]*color:\s*#f4f7fb;/
    );
  });
});

describe('the Table Config form', () => {
  const css = code(read('src/pages/TableConfigPage.css'));

  it('carries no rule for a class nothing renders (they were global and leaked onto other pages)', () => {
    for (const dead of [
      '.btn-delete',
      '.delete-modal',
      '.btn-confirm-delete',
      '.btn-cancel',
      '.back-btn',
      '.slider-thumb-icon',
      '.buyin-sliders',
      '.save-btn',
      '.reset-btn',
    ]) {
      expect(css.includes(dead), `${dead} is back`).toBe(false);
    }
  });

  it('the sticky action bar is opaque, so it never prints its actions over a control passing beneath', () => {
    const footer = css.match(/\.config-footer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(footer).toMatch(/position:\s*sticky;/);
    expect(footer).toMatch(/background:\s*#020305;/);
    // and the console block must not switch it back to see-through
    const transparentList = css.match(/:is\(([^)]*)\)\s*\{\s*background:\s*transparent;/g) ?? [];
    expect(transparentList.join(' ')).not.toContain('.config-footer');
  });

  it('the form declares a dark scheme, so native parts are drawn for the black glass in either room', () => {
    const root = css.match(/\.table-config-page\s*\{[^}]*\}/)?.[0] ?? '';
    expect(root).toMatch(/color-scheme:\s*dark;/);
  });

  it('every focus ring is the kit ring', () => {
    const rings = css.match(/outline:\s*\d+px solid #[0-9a-f]+;/gi) ?? [];
    expect(rings.length).toBeGreaterThan(0);
    expect(rings.filter((r) => !r.includes('#8fd4ff'))).toEqual([]);
  });

  it('the native date and time picker glyph is white on the dark field', () => {
    expect(css).toMatch(/\.config-datetime\s*\{\s*color-scheme:\s*dark;\s*\}/);
    expect(css).toMatch(
      /\.config-datetime::-webkit-calendar-picker-indicator\s*\{[^}]*filter:\s*brightness\(0\) invert\(1\);[^}]*opacity:\s*1;/
    );
  });
});

describe('the game type selector', () => {
  const tsx = read('src/pages/CreateTablePage.tsx');
  it('its back control is a printed word that names where it goes, never a font glyph', () => {
    const buttons = [
      ...tsx.matchAll(/<button[^>]*className="create-table-page__back"[\s\S]*?<\/button>/g),
    ].map((m) => m[0]);
    expect(buttons).toHaveLength(2);
    // Literals, one per destination (skill 7.6: tests read the source).
    expect(buttons.some((b) => b.includes('aria-label="Back To Table Management"'))).toBe(true);
    expect(buttons.some((b) => b.includes('aria-label="Back To The Club"'))).toBe(true);
    for (const b of buttons) {
      expect(b).toContain('type="button"');
      expect(b).toMatch(/>\s*Back\s*<\/button>/);
      expect(b).not.toMatch(/[\u2039\u203a\u00ab\u00bb]/);
    }
  });
});
