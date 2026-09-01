/**
 * APPROVED HAMBURGER ARTWORK MUST NEVER BECOME A GEAR.
 *
 * The user explicitly clarified that the M-bar copy rule is not an instruction
 * to remove or redesign the hamburger icon. The exact approved assets and their
 * existing wiring stay unchanged. This guard rejects the shipped regression:
 * replacing a menu trigger with a gear, settings icon, or substitute grid.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Strip block and line comments so a prose mention of "gear" cannot fail us. */
const maskComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sha256 = (relativePath: string) =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, relativePath)))
    .digest('hex');

const APPROVED_ART = {
  'public/images/btn-hamburger-v4.png':
    '8c4a8385bf1ff9f2e3e82a4f18c862199654168f16396402a3ff7e784f34501d',
  'public/images/btn-hamburger.png':
    'fa246566913fc1ff0387a530afbfe42c55c040311401fa7930a5b963d1c79ec0',
  'public/images/btn-hamburger.webp':
    'c72a40ba30cf345d6f9af42b89443352aa2adae0dd5cc3cc4a188441f5bf4f67',
  'public/images/global-header/menu.png':
    '61473209d781f6403df417f5d63c0e9b2ca9d36b0d651001aa1d9cd2ce87926a',
  'public/images/global-header/global-header-approved-source.png':
    '37f2dd1cf6bf264c20402a1a928fa053bcdde4866b231e6d9c5f7d158d01df2a',
  'public/images/global-header/global-header-desktop.png':
    '7c5613a84a395abd6b9527785b46c99fb28b6264e2258bee366a04cac5500c7f',
} as const;

const MENU_TRIGGERS = [
  {
    file: 'src/components/navigation/GlobalHeader.tsx',
    required: ['menu.png', 'aria-label="Open Menu"'],
  },
  {
    file: 'src/components/navigation/FloatingHamburger.tsx',
    required: ['aria-label="Open Menu"', 'height="2.5"'],
  },
  {
    file: 'src/components/Shell.tsx',
    required: ['images/btn-hamburger.png', 'aria-label="Menu"'],
  },
  {
    file: 'src/components/table/TableMenu.tsx',
    required: ["useButtonImage('icon-hamburger')", 'aria-label="Table Menu"'],
  },
] as const;

const FORBIDDEN_TRIGGER_SUBSTITUTION =
  /CommandGridIcon|command-grid|command-center-v1|global-header-command-center|<Settings\b|<Cog\b|<Gear\b|SettingsIcon\s*\/>|icon-(?:settings|gear|cog)/;
const FORBIDDEN_COMMAND_REPLACEMENT =
  /CommandGridIcon|command-grid|command-center-v1|global-header-command-center/;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:css|html|jsx?|tsx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('approved hamburger artwork never becomes a gear or substitute icon', () => {
  it('keeps every approved image byte-for-byte unchanged', () => {
    for (const [path, expectedHash] of Object.entries(APPROVED_ART)) {
      expect(sha256(path), `${path} is not the approved artwork`).toBe(expectedHash);
      const builtPath = path.replace(/^public\//, 'dist/');
      if (existsSync(join(ROOT, builtPath))) {
        expect(sha256(builtPath), `${builtPath} changed during the production build`).toBe(
          expectedHash
        );
      }
    }
  });

  it.each(MENU_TRIGGERS)('$file keeps its approved menu wiring', ({ file, required }) => {
    const source = read(file);
    for (const marker of required) expect(source).toContain(marker);
    const ariaMarker = required.find((marker) => marker.startsWith('aria-label='));
    expect(ariaMarker).toBeDefined();
    const ariaIndex = source.indexOf(ariaMarker!);
    const triggerBlock = source.slice(Math.max(0, ariaIndex - 700), ariaIndex + 500);
    expect(triggerBlock).not.toMatch(FORBIDDEN_TRIGGER_SUBSTITUTION);
  });

  it('keeps the approved floating hamburger geometry unchanged', () => {
    const source = read('src/components/navigation/FloatingHamburger.tsx');
    expect(source.match(/<rect[^>]*height="2\.5"/g)).toHaveLength(3);
    expect(source).toContain('x="3" y="4" width="18" height="2.5"');
    expect(source).toContain('x="3" y="10.75" width="18" height="2.5"');
    expect(source).toContain('x="3" y="17.5" width="18" height="2.5"');
  });

  it('contains no gear or command-grid replacement source or asset', () => {
    expect(existsSync(join(ROOT, 'src/components/navigation/CommandGridIcon.tsx'))).toBe(false);
    expect(
      existsSync(join(ROOT, 'public/images/global-header/global-header-command-center-v1.png'))
    ).toBe(false);
    expect(
      existsSync(join(ROOT, 'dist/images/global-header/global-header-command-center-v1.png'))
    ).toBe(false);

    const offenders = sourceFiles(join(ROOT, 'src'))
      .filter((file) => FORBIDDEN_COMMAND_REPLACEMENT.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('does not cache-tombstone any approved image URL', () => {
    const worker = read('public/sw-bus.js');
    for (const path of Object.keys(APPROVED_ART)) {
      expect(worker).not.toContain(`/hub/club-arena/${path.replace(/^public\//, '')}`);
    }
    expect(worker).not.toContain('purgeDecommissionedThreeBarArtwork');
  });

  it('prevents the production optimizer from re-encoding approved artwork', () => {
    const optimizer = read('scripts/optimize-dist-media.mjs');
    for (const path of Object.keys(APPROVED_ART)) {
      const relativePath = path.replace(/^public\//, '');
      if (relativePath.startsWith('images/global-header/')) {
        expect(optimizer).toContain("{ prefix: 'images/global-header/', maxDim: 0 }");
      } else {
        expect(optimizer).toContain(`{ prefix: '${relativePath}', maxDim: 0 }`);
      }
    }
  });

  it('states unambiguously that the copy rule never changes icons', () => {
    for (const path of ['AGENT-PLAYBOOK.md', 'CLAUDE.md']) {
      const instructions = read(path);
      expect(instructions).toMatch(/em bars.*em dashes/is);
      expect(instructions).toMatch(/does not ban the hamburger/i);
      expect(instructions).toContain('tests/approvedHamburgerGearGuard.law.test.ts');
    }
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
