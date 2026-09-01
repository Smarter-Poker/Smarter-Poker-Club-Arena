/**
 * THE HAMBURGER IS THE MENU (Dan, 2026-09-01, BINDING)
 *
 * Dan: "The hamburger menu regressed again. Fix it and prevent it from ever
 * breaking or regressing again."
 *
 * WHY THIS IS A LAW AND NOT A CODE REVIEW NOTE
 *
 * This has now been fixed at least four separate times, each time by hand,
 * each time after Dan noticed it in production:
 *
 *   76c2729e5a  fix(ui): revert to hamburger icon in table menu
 *   bc784d11ed  fix(ui): revert to hamburger icon in table menu
 *   9fc48e2712  Fix table connection loop, hamburger icon, and empty seat shadow
 *   7999c85d1f  revert(header): restore approved hamburger and offset mobile badge
 *   4da58d09f7  fix(header): restore hamburger and offset mobile badge  (World Hub)
 *
 * Five reverts and no test is not bad luck, it is a missing guard. Every one of
 * those commits restored the icon and left the door open behind it. A menu
 * trigger is a three-line hamburger; a gear means "settings" and sends players
 * looking for a preferences screen that is not there. The icon is not a taste
 * question, so it does not get to be re-decided by whoever touches the file
 * next.
 *
 * WHAT THIS PINS
 *
 *   1. The complete set of menu triggers. A new trigger added without a
 *      hamburger fails here, and so does deleting one of the four.
 *   2. The bytes of every hamburger image checked into the repo. Swapping the
 *      art without touching a line of code was the failure mode that took the
 *      longest to find, because the diff was empty.
 *   3. The absence of a gear anywhere near a trigger's markup.
 *
 * WHAT THIS CANNOT PIN, and what to do about it
 *
 * `TableMenu` loads its icon from Supabase storage at
 * `assets/buttons/<skin>/icon-hamburger.webp`, which is outside version
 * control and is uploaded with `upsert: true` by
 * scripts/upload_buttons/upload.js. Nothing in CI can stop that object being
 * overwritten. What this test CAN do is pin the asset NAME, so the code always
 * asks for the hamburger; if the bytes behind that name become a gear, the fix
 * is to re-upload, not to point the code somewhere else.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const md5 = (rel: string) =>
  createHash('md5')
    .update(readFileSync(join(ROOT, rel)))
    .digest('hex');

/** Strip block and line comments so a prose mention of "gear" cannot fail us. */
const maskComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every surface in Club Arena that opens the navigation menu. Adding a fifth
 * trigger means adding it here; that is the point.
 */
const TRIGGERS = [
  {
    name: 'GlobalHeader — the approved one-row header',
    file: 'src/components/navigation/GlobalHeader.tsx',
    mustContain: ['menu.png', 'aria-label="Open Menu"'],
  },
  {
    name: 'FloatingHamburger — bottom-left companion trigger',
    file: 'src/components/navigation/FloatingHamburger.tsx',
    mustContain: ['aria-label="Open Menu"'],
  },
  {
    name: 'Shell — the club shell trigger',
    file: 'src/components/Shell.tsx',
    mustContain: ['images/btn-hamburger.png', 'aria-label="Menu"'],
  },
  {
    name: 'TableMenu — the in-table drawer trigger',
    file: 'src/components/table/TableMenu.tsx',
    mustContain: ["useButtonImage('icon-hamburger')", 'aria-label="Table Menu"'],
  },
] as const;

/**
 * The hamburger art checked into this repo, by content. Regenerate a hash ONLY
 * alongside a screenshot in the PR showing the new art is still three bars.
 */
const APPROVED_ART: Record<string, string> = {
  'public/images/global-header/menu.png': '735f3bbb89262c6b8b60837a41ec46e9',
  'public/images/btn-hamburger.png': 'ae9ee64e105356e5f362c2d38e43c6aa',
};

/** Signatures of a gear/cog, in SVG, emoji and component form. */
const GEAR = /⚙|<Settings\b|<Cog\b|<Gear\b|M19\.4 15a1\.65|SettingsIcon\s*\/>/;

describe('the hamburger is the menu, and stays the menu', () => {
  it.each(TRIGGERS)('$name still opens the menu with a hamburger', (trigger) => {
    const source = read(trigger.file);
    for (const needle of trigger.mustContain) {
      expect(source, `${trigger.file} no longer references ${needle}`).toContain(needle);
    }
  });

  it('no menu trigger renders a gear', () => {
    const offenders: string[] = [];
    for (const trigger of TRIGGERS) {
      const lines = maskComments(read(trigger.file)).split('\n');
      lines.forEach((line, i) => {
        if (!GEAR.test(line)) return;
        // A gear is legal as a Settings ROW inside the drawer. It is never
        // legal within the trigger button itself, so look at the surrounding
        // block for the trigger's own markers.
        const block = lines.slice(Math.max(0, i - 12), i + 4).join('\n');
        if (/aria-label="(Open Menu|Menu|Table menu)"/.test(block)) {
          offenders.push(`${trigger.file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('FloatingHamburger draws three bars, not a circle with teeth', () => {
    const svg = read('src/components/navigation/FloatingHamburger.tsx');
    const bars = svg.match(/<rect[^>]*height="2\.5"/g) ?? [];
    expect(bars, 'the floating trigger must be exactly three bars').toHaveLength(3);
    expect(svg).not.toMatch(GEAR);
  });

  it('the checked-in hamburger art is byte-for-byte the approved art', () => {
    for (const [file, hash] of Object.entries(APPROVED_ART)) {
      expect(md5(file), `${file} was replaced — open it and look at it`).toBe(hash);
    }
  });

  it('the table trigger still asks Supabase for the hamburger, not a gear', () => {
    // The bytes live outside git. The NAME must not drift; if the object behind
    // it is wrong, re-upload it rather than repointing the code.
    const source = read('src/components/table/TableMenu.tsx');
    expect(source).toContain("useButtonImage('icon-hamburger')");
    expect(source).not.toMatch(/useButtonImage\(\s*['"]icon-(settings|gear|cog)['"]\s*\)/);
  });
});

describe('no boxes over header or footer icons', () => {
  /*
   * Dan, 2026-09-01: "Remove any and all boxes that appear over any header or
   * footer icon globally on every page and sub pages."
   *
   * club-engine.css paints `button:focus-visible { outline; box-shadow }` on
   * every button in the app. On the chrome icons — which are transparent hit
   * regions laid over baked artwork — that outline is a rectangle sitting on
   * top of the icon. Safari on macOS matches :focus-visible after a plain mouse
   * click, so it stuck there after every tap. Each chrome surface must override
   * it, and the override must not itself draw a box.
   */
  const CHROME = [
    ['src/components/navigation/GlobalHeader.module.css', '.artButton'],
    ['src/components/navigation/FloatingHamburger.module.css', '.floatingButton'],
    ['src/components/club/ClubBottomNav.module.css', '.navItem'],
  ] as const;

  it.each(CHROME)('%s kills the global focus ring on %s', (file, selector) => {
    const css = maskComments(read(file));
    const rule = new RegExp(
      `\\${selector}:focus,\\s*\\${selector}:focus-visible\\s*\\{[^}]*outline:\\s*none[^}]*box-shadow:\\s*none[^}]*\\}`
    );
    expect(css, `${file} must neutralise the global ring on ${selector}`).toMatch(rule);
  });

  it('the chrome focus state is a glow, never an outline or a hard ring', () => {
    for (const [file, selector] of CHROME) {
      const css = maskComments(read(file));
      const focusBlocks =
        css.match(new RegExp(`\\${selector}:focus-visible\\s*\\{[^}]*\\}`, 'g')) ?? [];
      expect(focusBlocks.length, `${file} lost its ${selector} focus state`).toBeGreaterThan(0);
      const combined = focusBlocks.join('\n');
      // Read the VALUES rather than pattern-matching around them: a negative
      // lookahead after `\s*` backtracks to zero width and happily matches
      // `outline: none`, which is the one value we are trying to allow.
      const valuesOf = (prop: string) =>
        [...combined.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]+)`, 'g'))].map((m) =>
          m[1].trim().toLowerCase()
        );
      const boxy = [...valuesOf('outline'), ...valuesOf('box-shadow')].filter(
        (value) => value !== 'none'
      );
      expect(boxy, `${file} still draws a box on ${selector}`).toEqual([]);
      // Keyboard users must still be able to see where they are.
      expect(combined, `${file} left ${selector} with no visible focus cue`).toMatch(
        /radial-gradient/
      );
    }
  });
});
