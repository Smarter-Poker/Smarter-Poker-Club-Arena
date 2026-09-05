/**
 * LAW: the shared Modal owns its class names, and nothing else may touch them.
 *
 * Dan, 2026-09-04: "THE CLUB POP UP, IS STILL BROKEN... IT BLOCKS THE ENTIRE
 * PAGE, EVEN WHEN ITS 'SMALL'. (YOU CAN SEE IT SLIGHTLY STILL). FIX THIS ISSUE
 * AT ITS ROOT CAUSE, AND PREVENT IT FROM HAPPENING AGAIN."
 *
 * WHAT WAS WRONG. `components/common/Modal` painted its backdrop as
 * `.modal-overlay` and its card as `.modal`. Those are plain global class
 * names, and this repo defines `.modal-overlay` in NINE other stylesheets,
 * `.modal` in sixteen and `.modal-content` in five, each for some other
 * component's own dialog. In a code-split SPA the cascade between them is
 * decided by which chunk the browser happened to load last - so the same
 * popup could look right on one visit and wrong on the next.
 *
 * Measured on the live Midway Union lobby with the club greeting open:
 *
 *     .modal-overlay   position: fixed   z-index: 1000   (Modal.css says
 *                                                         absolute / auto)
 *     elementsFromPoint(club name) -> [.modal-overlay, h2, ...]
 *
 * Inside the portal's stacking context a backdrop at z-index 1000 sits above
 * a card with none. The 82%-black, 9px-blur sheet meant to sit BEHIND the
 * card sat on top of it. Two earlier fixes (#2899, #2902) shrank the card and
 * were both correct and both beside the point: a small card under a full
 * screen sheet still blocks the entire page, and that is the screenshot.
 *
 * THE LAW, in four pins:
 *   1. Every class the shared Modal defines carries the `ca-modal` prefix.
 *   2. Every class Modal.tsx emits is one Modal.css defines.
 *   3. No other stylesheet in src/ may write a rule for any of those classes.
 *      The one allowed reader is the popup chassis (metallic-popups.css),
 *      and it may only PAINT them - never position them, never z-index them.
 *   4. The card is explicitly above its own backdrop.
 *
 * If you are here because you want a different backdrop for one modal: pass
 * `className` and style YOUR class. If you are here because you renamed a
 * class in Modal.css and dropped the prefix: put it back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MODAL_CSS = 'src/components/common/Modal.css';
const MODAL_TSX = 'src/components/common/Modal.tsx';
const PREFIX = 'ca-modal';

/** The popup chassis is allowed to paint the shared modal. Nothing else is. */
const PAINT_ONLY_READERS = new Set(['src/styles/metallic-popups.css']);

/** A reader may set these on a shared-modal class. Anything else is layout. */
const PAINT_PROPERTIES = new Set([
  'background',
  'background-color',
  'background-image',
  'backdrop-filter',
  '-webkit-backdrop-filter',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-radius',
  'outline',
  'box-shadow',
  'color',
  'font-family',
  'font-weight',
  'letter-spacing',
  'text-shadow',
  /* `position: relative; isolation: isolate` is what the chassis puts on
     every panel so its inset shadows have a box to sit in. Relative keeps the
     card exactly where the Modal put it; the guard below still refuses fixed,
     absolute and sticky, and refuses any z-index at all. */
  'position',
  'isolation',
]);

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFilesUnder(join(dir, entry)));
    else if (entry.endsWith('.css')) out.push(relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Every `.class` token in a stylesheet's selectors (not its declarations). */
function classesDefinedIn(css: string): Set<string> {
  const out = new Set<string>();
  const src = stripComments(css);
  // Selector text is everything between a `}` (or start) and the next `{`,
  // minus at-rule preludes, which carry no class names.
  const selectorRe = /(?:^|\})([^{}]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = selectorRe.exec(src))) {
    const sel = m[1];
    if (/^\s*@/.test(sel)) continue;
    for (const c of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(c[1]);
  }
  return out;
}

/**
 * A consumer may style ITS OWN instance: `<Modal className="x">` puts `.x` on
 * the card, and a rule like `.x.ca-modal--fullscreen > .ca-modal-content` can
 * only ever match that one modal. The test is that the FIRST compound naming
 * a shared-modal class also carries a class the shared modal does not own.
 * `.ca-modal-overlay {}` fails it; so does `.some-page .ca-modal-overlay {}`,
 * which would restyle every modal while that page is mounted - the exact
 * shape of the bug.
 */
function qualifiedByConsumer(selector: string, classes: Set<string>): boolean {
  // Compounds are separated by descendant/child/sibling combinators.
  const compounds = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const first = compounds.find((c) =>
    [...c.matchAll(/\.([A-Za-z_][\w-]*)/g)].some((m) => classes.has(m[1]))
  );
  if (!first) return true;
  return [...first.matchAll(/\.([A-Za-z_][\w-]*)/g)].some((m) => !classes.has(m[1]));
}

/** Rule bodies whose selector names any of `classes`, with the selector. */
function rulesNaming(css: string, classes: Set<string>): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const src = stripComments(css);
  const ruleRe = /(?:^|\})([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(src))) {
    const selectorList = m[1].replace(/\s+/g, ' ').trim();
    if (/^@/.test(selectorList)) continue;
    // `:where(a, b, c)` lists and plain `a, b` lists: judge each selector.
    const parts = selectorList
      .replace(/:where\(([^)]*)\)/g, '$1')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const selector of parts) {
      const named = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].some((c) => classes.has(c[1]));
      if (named && !qualifiedByConsumer(selector, classes)) out.push({ selector, body: m[2] });
    }
  }
  return out;
}

const modalCss = read(MODAL_CSS);
const modalClasses = classesDefinedIn(modalCss);

describe('the shared Modal owns its class names', () => {
  it('defines at least the portal, the overlay and the card', () => {
    expect([...modalClasses]).toEqual(
      expect.arrayContaining([`${PREFIX}-portal`, `${PREFIX}-overlay`, PREFIX])
    );
  });

  it('1. every class in Modal.css carries the ca-modal prefix', () => {
    const unprefixed = [...modalClasses].filter((c) => c !== PREFIX && !c.startsWith(`${PREFIX}-`));
    expect(
      unprefixed,
      `Modal.css defines classes without the "${PREFIX}" prefix. A bare name like ` +
        `".modal-overlay" is shared with nine other stylesheets in this repo, and ` +
        `whichever loads last owns the backdrop - that is how the club greeting ` +
        `ended up under its own overlay. Rename: ${unprefixed.join(', ')}`
    ).toEqual([]);
  });

  it('2. every class Modal.tsx emits is one Modal.css defines', () => {
    const tsx = read(MODAL_TSX);
    // Literal class names in className="..." and in template literals. A
    // `${...}` expression is a dynamic suffix (`${size}`, `${align}`,
    // `${position}`) or the consumer's own `${className}`; it is replaced by a
    // marker so the token can be judged by its literal prefix.
    const MARK = '@@';
    const tokens = [...tsx.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
      .map((m) => m[1] ?? m[2])
      .map((v) => v.replace(/\$\{[^}]*\}/g, MARK))
      .flatMap((v) => v.split(/\s+/))
      .filter((t) => t && t !== MARK)
      // AlertDialog's buttons wear the house `btn btn-*` classes from
      // Button.css. Those belong to the button system, not to this modal.
      .filter((t) => !/^btn(?:-|$|@@)/.test(t));
    expect(tokens.length).toBeGreaterThan(5);
    for (const token of tokens) {
      const templated = token.includes(MARK);
      const bare = token.split(MARK).join('');
      expect(
        bare === PREFIX || bare.startsWith(`${PREFIX}-`),
        `Modal.tsx emits "${bare}", which is not namespaced. Every class this ` +
          `component emits must start with "${PREFIX}".`
      ).toBe(true);
      // A fully literal token must exist in the stylesheet; a templated one
      // must be the prefix of something defined there.
      const defined = templated
        ? [...modalClasses].some((c) => c.startsWith(bare) && c !== bare)
        : modalClasses.has(bare);
      expect(defined, `Modal.tsx emits "${bare}" but Modal.css does not define it.`).toBe(true);
    }
  });

  it('3. no other stylesheet in src/ writes a rule for a shared-modal class', () => {
    const offenders: string[] = [];
    const layoutByChassis: string[] = [];
    for (const file of cssFilesUnder('src')) {
      if (file === MODAL_CSS) continue;
      // CSS modules are hashed at build time and cannot collide.
      if (file.endsWith('.module.css')) continue;
      const rules = rulesNaming(read(file), modalClasses);
      if (rules.length === 0) continue;
      if (!PAINT_ONLY_READERS.has(file)) {
        offenders.push(`${file}: ${rules.map((r) => r.selector).join(' | ')}`);
        continue;
      }
      // The chassis may paint. It may not lay out.
      for (const rule of rules) {
        const props = [...rule.body.matchAll(/(?:^|;)\s*([a-zA-Z-]+)\s*:\s*([^;]+)/g)];
        for (const [, prop, value] of props) {
          const ok =
            PAINT_PROPERTIES.has(prop) &&
            !(prop === 'position' && !/^\s*relative\s*(!important)?\s*$/.test(value));
          if (!ok)
            layoutByChassis.push(`${file}: "${prop}: ${value.trim()}" on "${rule.selector}"`);
        }
      }
    }
    expect(
      layoutByChassis,
      `The popup chassis may PAINT the shared modal (background, border, shadow, ` +
        `type) but must never position it, size it, or give it a z-index - that ` +
        `is exactly how the backdrop ended up on top of the card.`
    ).toEqual([]);
    expect(
      offenders,
      `These stylesheets write rules for classes that belong to ` +
        `${MODAL_CSS}. They cannot: in a code-split bundle the last chunk to load ` +
        `wins, and on 2026-09-04 that put the backdrop over the card and the ` +
        `club greeting under a full-screen sheet. Style your own class instead ` +
        `(pass \`className\` to <Modal>).`
    ).toEqual([]);
  });

  it('4. the card is explicitly above its own backdrop', () => {
    const src = stripComments(modalCss);
    const body = (selector: string) => {
      const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.-]/g, '\\$&')}\\s*\\{([^{}]*)\\}`);
      const m = src.match(re);
      expect(m, `${selector} must be defined in Modal.css`).not.toBeNull();
      return m![1].replace(/\s+/g, ' ');
    };
    const overlay = body(`.${PREFIX}-overlay`);
    const card = body(`.${PREFIX}`);
    // The backdrop lives inside the portal, not the viewport, so it cannot
    // escape the portal's stacking context and out-rank the card.
    expect(overlay).toMatch(/position:\s*absolute/);
    const z = (b: string) => Number((b.match(/z-index:\s*(-?\d+)/) ?? [])[1]);
    expect(z(overlay), 'overlay z-index must be a number').not.toBeNaN();
    expect(z(card), 'card z-index must be a number').not.toBeNaN();
    expect(z(card)).toBeGreaterThan(z(overlay));
  });

  it('the club greeting follows the rename', () => {
    // The one consumer that reaches into the shared modal's structure. If a
    // second one appears, it must reach for the namespaced names too.
    const greeting = read('src/components/club/ClubEntryMessage.css');
    expect(greeting).toContain(`.${PREFIX}--fullscreen`);
    expect(greeting).toContain(`> .${PREFIX}-content`);
    expect(stripComments(greeting)).not.toMatch(/\.modal-(?:fullscreen|content|overlay)\b/);
  });
});
