/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FALLBACK NOTHING READS IS NOT A FALLBACK
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Defect, found 2026-08-25, shipped:
 *
 *   CardImage.css SET `--cb-gradient` twelve times, once per card-back design,
 *   and READ it zero times. The rule that paints a card back was
 *
 *       background-image: var(--cb-image, none);
 *
 *   so a back whose .webp 404s or has not downloaded yet painted NOTHING -
 *   a 2px border around transparent felt. TablePage.css did the same thing
 *   with `--card-back-gradient`, also twelve times, also never read.
 *
 *   Both files carried comments asserting the fallback worked. CardImage.css:
 *   "The gradient and border stay here as the fallback for a missing file."
 *   TableVisualHotfix.css: the base rule "paints two layers, `var(--cb-image),
 *   gradient`". Neither was true, and nothing failed when they stopped being
 *   true, because a custom property that nobody reads is not an error in CSS -
 *   it is just a string sitting in the cascade.
 *
 * The fix paints a LAYER LIST, image over gradient. What follows pins the two
 * rules that do the painting, and then pins the general shape of the bug: a
 * card-back colour token that is declared and never consumed.
 *
 * Deliberately a source-text test rather than a rendering test. jsdom does not
 * resolve var() inside a multi-layer background-image, so a jsdom assertion
 * here would pass against the BROKEN css too, which is the same class of
 * mistake this file exists to catch. The layering itself was verified in real
 * Blink (headless Chrome, computed styles plus a screenshot) at fix time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..', 'src');

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Does this css READ the named custom property?
 *
 * Whitespace-tolerant on purpose: Prettier wraps a long fallback chain as
 * `var(\n  --cb-gradient,` and a naive `includes('var(--cb-gradient')` then
 * reports the property as unread the first time someone reformats the file.
 */
const readsVar = (css: string, name: string) => new RegExp(`var\\(\\s*${name}\\b`).test(css);

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/**
 * The declaration block of the first rule whose selector matches.
 *
 * Comments are stripped FIRST. Both stylesheets quote their own selectors in
 * prose - CardImage.css line 115 contains the literal
 * `.table-page .seat .card-image--back .card-back { ... !important }` while
 * explaining the specificity war - and a plain indexOf finds the explanation
 * before the rule, then asserts against " ... !important ".
 */
function ruleBody(css: string, selector: string): string {
  const bare = stripComments(css);
  const at = bare.indexOf(selector + ' {');
  expect(at, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = bare.indexOf('{', at);
  const close = bare.indexOf('}', open);
  return bare.slice(open + 1, close);
}

/** `--foo: ...` declarations, ignoring anything inside a comment. */
function declaredProps(css: string): string[] {
  const bare = stripComments(css);
  return [...new Set([...bare.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))];
}

describe('the card back paints something when its artwork is missing', () => {
  it('CardImage.css base rule reads --cb-gradient, not just --cb-image', () => {
    const body = ruleBody(read('components/table/CardImage.css'), '.card-image--back .card-back');

    // The image layer is still first, so real artwork covers the gradient.
    expect(body).toMatch(/background-image:\s*var\(--cb-image/);

    // ...and a second layer exists underneath it. This is the whole fix.
    expect(
      readsVar(body.slice(body.indexOf('background-image:')).split(';')[0], '--cb-gradient'),
      'the base rule paints only --cb-image, so a 404 renders an empty card'
    ).toBe(true);
  });

  it('the table-page override also reads --cb-gradient', () => {
    /* This selector is 0-4-0 AND !important, so it decides what the seats
       actually show. Fixing CardImage.css alone would change nothing on the
       one page where card backs matter. */
    const body = ruleBody(
      read('components/table/TableVisualHotfix.css'),
      '.table-page .seat .card-image--back .card-back'
    );
    expect(body).toMatch(/background-image:\s*var\(--cb-image/);
    expect(
      readsVar(body.slice(body.indexOf('background-image:')).split(';')[0], '--cb-gradient'),
      'the table page paints --cb-image over a flat colour, losing every design'
    ).toBe(true);
    // The opaque floor stays: a back must never be see-through.
    expect(body).toMatch(/background-color:\s*#35598f/);
  });

  it('the theme-level token --card-back-gradient is consumed somewhere', () => {
    /* TablePage.css sets this twelve times. Before the fix nothing read it,
       which is the same defect one layer up. */
    const consumers = ['components/table/TableVisualHotfix.css', 'components/table/CardImage.css']
      .map(read)
      .map(stripComments)
      .filter((css) => readsVar(css, '--card-back-gradient'));
    expect(consumers.length, '--card-back-gradient is set 12x and read 0x').toBeGreaterThan(0);
  });

  it('every --cb-* token a design class declares is read by a painting rule', () => {
    const css = read('components/table/CardImage.css');
    const declared = declaredProps(css).filter((p) => p.startsWith('--cb-'));

    // Sanity: the twelve designs really do declare tokens here.
    expect(declared).toContain('--cb-gradient');
    expect(declared).toContain('--cb-border');

    const painted = stripComments(
      [read('components/table/CardImage.css'), read('components/table/TableVisualHotfix.css')].join(
        '\n'
      )
    );
    const orphans = declared.filter((p) => !readsVar(painted, p));
    expect(orphans, `declared but never read: ${orphans.join(', ')}`).toEqual([]);
  });

  it('all twelve designs still declare a gradient', () => {
    const css = read('components/table/CardImage.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const designs = [...css.matchAll(/\.card-back--([a-z0-9_-]+)\s*\{([^}]*)\}/gi)];
    expect(designs.length).toBe(12);
    const missing = designs
      .filter(([, , body]) => !body.includes('--cb-gradient'))
      .map((m) => m[1]);
    expect(missing, `designs with no gradient: ${missing.join(', ')}`).toEqual([]);
  });
});
