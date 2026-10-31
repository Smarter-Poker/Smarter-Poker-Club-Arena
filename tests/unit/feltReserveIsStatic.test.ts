/**
 * THE FELT'S SIZE MAY NOT BE DERIVED FROM A MEASUREMENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27, verbatim: "THE CLUB ARENA GAME TABLE IS DOING THIS WEIRD
 * THING WHERE THE SCREEN IS MOVING IN AND OUT CONSTANTLY ... THAT SHOULD NEVER
 * BE HAPPENING. IT'S HAPPENING ON ALL TABLES."
 *
 * ─── WHAT THIS FILE IS GUARDING, AND WHY A PIXEL TEST WOULD NOT ────────────
 *
 * `.table-scaler` does not have a height. It has an `aspect-ratio: 605/1000`
 * and a WIDTH derived from the height it is allowed to have:
 *
 *     --sp-table-h     = --sp-page-h - --sp-table-top - --sp-table-bottom
 *     .table-scaler    width: calc(var(--sp-table-h) * 605 / 1000)
 *
 * That is a good design and it should stay. Its consequence is the thing to
 * remember: `--sp-table-bottom` is NOT a padding. It is the table's size. Every
 * pixel that moves in that expression rescales the felt, the seat ring, the pot,
 * the board and every chip on it.
 *
 * On 2026-08-27 one term of it was `--sp-action-h`, the live ResizeObserver'd
 * height of `.action-panel-wrapper`. That box legitimately changes height
 * several times in every hand: it collapses to 1px when the hero has no action,
 * drops to the 22px spectator line, stands back up on its `--sp-bottom-row-h`
 * floor on the hero's turn, and grows again when the Show Hand bar enters its
 * flow at showdown. Measured on production (Chromium, 1204px, table
 * f2c86e7a-e7c9-4d3c-b496-cd09ab33215d), the same felt at the three values that
 * variable actually took:
 *
 *     --sp-action-h: 1px   ->  664.3 x 1098
 *     --sp-action-h: 53px  ->  632.8 x 1046
 *     --sp-action-h: 97px  ->  606.2 x 1002
 *
 * Nothing was broken. Every rule did what it said. The bug was that a reserve
 * for a box that comes and goes was a MEASUREMENT of that box, so the reserve
 * moved exactly when the box did — which is precisely when nothing on screen may
 * move.
 *
 * A test that pinned a pixel value would not have caught it and would not catch
 * the next one: every individual value was correct. What has to be pinned is the
 * SHAPE — that the felt's geometry resolves entirely through properties CSS
 * declares, and never through one JavaScript writes. That is what this file
 * checks, by resolving the var() graph under `--sp-table-bottom` and
 * `--sp-hud-line` and intersecting it with every custom property written from
 * anywhere in `src/`.
 *
 * IF THIS FAILS, DO NOT SATISFY IT BY RENAMING THINGS. It is telling you the
 * table will resize under a player mid-hand. Reserve for the maximum, in CSS,
 * and let whatever varies overlay the felt — the bar is `position: fixed`, it
 * has never needed the felt to move for it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Every .css / .ts / .tsx file under src/, so nothing hides in a new file. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
    } else if (/\.(css|ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Comments in this codebase quote the bugs they fixed, at length and by name —
 * which is exactly what makes them worth keeping and exactly what makes a naive
 * grep useless. Every scan below runs on code with the comments removed, so a
 * file can describe the pattern it must never contain without failing for
 * describing it.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SRC_FILES = walk(resolve(ROOT, 'src'));
const ALL_CSS = SRC_FILES.filter((f) => f.endsWith('.css'))
  // Block comments only — a CSS file has no `//` comments, and `//` inside a
  // url() would be eaten by the code stripper.
  .map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');
const CODE_FILES = SRC_FILES.filter((f) => /\.tsx?$/.test(f));

/**
 * Every custom property any JavaScript in src/ writes to the DOM.
 *
 * Covers `style.setProperty('--x', ...)` and an inline `style={{ '--x': ... }}`
 * on a JSX element, which are the two routes a measurement has ever taken into
 * this stylesheet. A property in this set is, by definition, a number that can
 * change without a stylesheet author's knowledge.
 */
function jsWrittenProperties(): Map<string, string[]> {
  const written = new Map<string, string[]>();
  for (const file of CODE_FILES) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(ROOT.length + 1);
    for (const re of [
      /setProperty\(\s*['"`](--[a-zA-Z0-9-]+)['"`]/g,
      /['"`](--[a-zA-Z0-9-]+)['"`]\s*:/g,
    ]) {
      for (const m of src.matchAll(re)) {
        const list = written.get(m[1]) ?? [];
        if (!list.includes(rel)) list.push(rel);
        written.set(m[1], list);
      }
    }
  }
  return written;
}

/**
 * Resolve the var() graph under a custom property across every stylesheet.
 *
 * Deliberately crude — it reads declarations by name wherever they appear rather
 * than by cascade — and crude in the SAFE direction: it over-collects, so a
 * property that reaches the felt down any branch, at any breakpoint, in any
 * state, is in the set. A test that missed a branch would be worse than none.
 */
function dependencies(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const prop = queue.shift()!;
    if (seen.has(prop)) continue;
    seen.add(prop);
    const decl = new RegExp(`${prop}\\s*:([^;{}]*)`, 'g');
    for (const m of ALL_CSS.matchAll(decl)) {
      for (const v of m[1].matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (!seen.has(v[1])) queue.push(v[1]);
      }
    }
  }
  return seen;
}

/**
 * Every (selector, declaration) pair in the CSS that declares `prop`.
 *
 * Crude but adequate: from each `--prop:` occurrence, walk back to the `{` that
 * opens its rule, then back again to the end of the previous block to recover
 * the selector text.
 */
function declarationsOf(prop: string, css = ALL_CSS): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = [];
  const re = new RegExp(`(^|[;{\\s])${prop}\\s*:([^;}]*)`, 'g');
  for (const m of css.matchAll(re)) {
    const at = m.index ?? 0;
    const brace = css.lastIndexOf('{', at);
    if (brace === -1) continue;
    const prev = Math.max(css.lastIndexOf('}', brace), css.lastIndexOf('{', brace - 1));
    out.push({
      selector: css
        .slice(prev + 1, brace)
        .replace(/\s+/g, ' ')
        .trim(),
      value: m[2].trim(),
    });
  }
  return out;
}

/**
 * The whole var() graph the oval's size resolves through. Anything in here that
 * a component STATE can change is a table that resizes under the player.
 */
const GEOMETRY_PROPS = [
  '--sp-tabbar-h',
  '--sp-table-bottom',
  '--sp-table-h',
  '--sp-page-h',
  '--sp-table-top',
  '--sp-action-reserve',
  '--sp-hero-clear',
];

describe('the felt reserves stay fixed through hand and action states', () => {
  /* "NO, THAT SHOULD NEVER HAPPEN, PREVENT IT AND FIX IT. THAT'S A GLITCH, NOT
     CODE."
     Two rules keyed on `[data-hero='false']` used to shrink --sp-action-reserve
     and --sp-hero-clear for a spectator. Between them the felt jumped 128px on
     desktop the instant somebody took a seat, and jumped back when they stood
     up. Both reserve overrides remain deleted. The October 22 owner request
     adds a dedicated phone observer canvas, reading the same static reserves;
     its hand/dock stability is measured in table-proportions.spec.ts. */

  it('declares no geometry property behind a component-state selector', () => {
    // A BREAKPOINT may change these — that is the viewport changing, which is
    // the one legitimate reason the oval may be a different size. A STATE may
    // not: attribute selectors, state classes and :has() all describe what the
    // table is doing right now, and the table must look the same doing any of it.
    const STATE =
      /\[data-|:has\(|\.ca-raising|--hero-turn|--allin|--winner|--active|--open|:hover|:focus|:active|\bbody\./;
    const offenders: string[] = [];
    for (const prop of GEOMETRY_PROPS) {
      for (const d of declarationsOf(prop)) {
        // Seat count is fixed table configuration. This exact narrow-phone
        // reserve clears the permanent hero plate, independent of hand state.
        const fixedShortRing =
          prop === '--sp-hero-clear' &&
          d.selector === ".table-page[data-seats='6'] .table-container" &&
          (d.value === '64px' || d.value === '58px');
        if (!fixedShortRing && STATE.test(d.selector))
          offenders.push(`${prop} declared on "${d.selector}"`);
      }
    }
    expect(
      declarationsOf('--sp-hero-clear').filter(
        (d) => d.selector === ".table-page[data-seats='6'] .table-container"
      )
    ).toEqual([
      { selector: ".table-page[data-seats='6'] .table-container", value: '64px' },
      { selector: ".table-page[data-seats='6'] .table-container", value: '58px' },
    ]);
    expect(ALL_CSS).toMatch(
      /@media\s*\(max-width:\s*375px\)\s*and\s*\(max-height:\s*700px\)\s*and\s*\(orientation:\s*portrait\)\s*\{\s*\.table-page\[data-seats='6'\]\s+\.table-container\s*\{\s*--sp-hero-clear:\s*64px;/
    );
    // The equal-size short-phone fit changes only a permanent viewport
    // reserve. Hand, action, spectator and dock state remain forbidden inputs.
    expect(ALL_CSS).toMatch(
      /@media\s*\(min-width:\s*341px\)\s*and\s*\(max-width:\s*480px\)\s*and\s*\(max-height:\s*720px\)\s*and\s*\(orientation:\s*portrait\)\s*\{\s*\.table-page\s+\.table-container\s*\{\s*--sp-hero-clear:\s*54px;\s*\}\s*\.table-page\[data-seats='6'\]\s+\.table-container\s*\{\s*--sp-hero-clear:\s*58px;/
    );
    expect(
      offenders,
      'a property the felt sizes itself from is declared behind a state selector. ' +
        'The oval will change size when that state flips.'
    ).toEqual([]);
  });

  it('uses the visible viewport only for portrait phones and keeps stable sizing elsewhere', () => {
    // October 20: phone gameplay must fill Safari's visible viewport rather
    // than retain dead space for its retracted toolbar. Other layouts keep
    // their existing svh contract. Gameplay state and JS measurements remain
    // forbidden inputs by the independent tests in this file.
    const media = /@media\s*\(max-width:\s*480px\)\s*and\s*\(orientation:\s*portrait\)\s*\{/g;
    const ranges = [...ALL_CSS.matchAll(media)].map((match) => {
      const start = match.index!;
      let end = start + match[0].length;
      let depth = 1;
      while (end < ALL_CSS.length && depth > 0) {
        if (ALL_CSS[end] === '{') depth++;
        if (ALL_CSS[end] === '}') depth--;
        end++;
      }
      expect(depth, 'portrait-phone rule must close').toBe(0);
      return { start, end };
    });
    expect(ranges.length, 'portrait-phone viewport rule must exist').toBeGreaterThan(0);
    const phone = ranges.flatMap(({ start, end }) =>
      declarationsOf('--sp-page-h', ALL_CSS.slice(start, end))
    );
    expect(phone.every((d) => /\d+dvh\b/.test(d.value))).toBe(true);
    let nonPhone = ALL_CSS;
    for (const { start, end } of [...ranges].reverse())
      nonPhone = nonPhone.slice(0, start) + nonPhone.slice(end);
    const other = declarationsOf('--sp-page-h', nonPhone);
    const fallback = other.filter((d) => /\d+dvh\b/.test(d.value));
    const stable = other.filter((d) => /\d+svh\b/.test(d.value));
    expect(phone, 'route and embedded phones must use the visible viewport').toHaveLength(2);
    expect(fallback.length, 'the non-phone fallback walk must not be empty').toBeGreaterThan(0);
    expect(stable.length, 'every non-phone dvh fallback retains its svh override').toBe(
      fallback.length
    );
  });

  it('keeps the action and hero reserves independent of spectator state', () => {
    // The October 22 observer canvas reads these fixed reserves to reclaim
    // unused hero-card space. It must never redefine either reserve or make
    // hand/action state feed the dimensions.
    expect(ALL_CSS).not.toMatch(/\[data-hero='false'\][^{]*\{[^}]*--sp-hero-clear\s*:/);
    expect(ALL_CSS).not.toMatch(/\[data-hero='false'\][^{]*\{[^}]*--sp-action-reserve\s*:/);
  });
});

describe("the felt's geometry is declared, never measured", () => {
  it('resolves --sp-table-bottom through nothing that JavaScript writes', () => {
    const deps = dependencies('--sp-table-bottom');
    // Sanity: the walk found the real graph, not an empty one.
    expect(deps.has('--sp-hero-clear'), 'the dependency walk found nothing').toBe(true);
    expect(deps.has('--sp-action-reserve')).toBe(true);

    const written = jsWrittenProperties();
    const offenders = [...deps].filter((p) => written.has(p));
    expect(
      offenders.map((p) => `${p} (written by ${written.get(p)!.join(', ')})`),
      'a property the felt SIZES ITSELF FROM is written from JavaScript. ' +
        'The table will resize under the player whenever that value changes.'
    ).toEqual([]);
  });

  it('resolves --sp-table-h and --sp-page-h the same way', () => {
    const written = jsWrittenProperties();
    for (const root of ['--sp-table-h', '--sp-page-h', '--sp-table-top']) {
      const offenders = [...dependencies(root)].filter((p) => written.has(p));
      expect(offenders, `${root} depends on a JavaScript-written property`).toEqual([]);
    }
  });

  it('holds for the bottom-edge line the HUD and chat rest on', () => {
    // Not the felt, but the same failure the player sees: both icons walked up
    // and down the screen with the bar before 2026-08-27.
    const written = jsWrittenProperties();
    const offenders = [...dependencies('--sp-hud-line')].filter((p) => written.has(p));
    expect(offenders, '--sp-hud-line depends on a JavaScript-written property').toEqual([]);
  });

  it('has no reader of the deleted --sp-action-h left anywhere', () => {
    // The variable is gone, not merely unused: a live-looking variable is an
    // invitation to read it. Comments recording the history are fine and
    // wanted; a `var()` read or a write is not.
    // Whitespace-insensitive: Prettier wraps a long var() across lines.
    expect(ALL_CSS).not.toMatch(/var\(\s*--sp-action-h\b/);
    for (const file of CODE_FILES) {
      expect(
        stripComments(readFileSync(file, 'utf8')),
        `${file} still writes --sp-action-h`
      ).not.toMatch(/setProperty\(\s*['"`]--sp-action-h/);
    }
  });

  it('scopes any surviving CSS-variable write to the instance that owns it', () => {
    /* The second, independent defect found in the same pass, recorded here so
       the shape cannot come back under another name.

       The deleted observer published onto `document.querySelector('.table-page')`
       — the FIRST such element in the document. MultiTablePage keeps up to four
       tables mounted and laid out simultaneously (an inactive slot is only
       `pointer-events: none`), so all four instances wrote their own bar's
       height onto table one's root and tables two to four were never given a
       value at all.

       A component that writes a CSS variable must write it to a node it owns —
       a ref, or `document.documentElement` for a genuinely global token — never
       to the first match of its own class name. */
    for (const file of CODE_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const bad = [...src.matchAll(/document\.querySelector\(\s*['"`]\.table-page['"`]\s*\)/g)];
      expect(
        bad.length,
        `${file.slice(ROOT.length + 1)} resolves .table-page globally. With four ` +
          "tables mounted that is another instance's root."
      ).toBe(0);
    }
  });
});
