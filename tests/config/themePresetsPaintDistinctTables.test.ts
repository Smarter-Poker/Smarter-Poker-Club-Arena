/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EVERY THEME PRESET MUST PAINT A DIFFERENT TABLE (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured on main before this commit: the Theme Settings "Themes" tab offered
 * default-dark, classic-brown, neon-blue, rustic-wood and casino-green, and not
 * one of those five ids was a key in TABLE_SKINS. resolveSkin is
 * `TABLE_SKINS[tid] || TABLE_SKINS.classic_green`, so every id that reached it
 * as a theme id — the felt reads `table_id || theme_id || settings.theme`, and
 * a row written before the Table tab existed carries no table_id — fell through
 * to the same green felt. Five names, one table.
 *
 * The CSS that looked like it handled them made it worse rather than better:
 * seventeen `[data-felt-theme='...']` rules setting --felt-gradient /
 * --bg-gradient / --rail-gradient, custom properties defined 37 times across
 * TablePage.css and design-tokens.css and read by `var()` ZERO times. Dead CSS
 * shaped like a feature is why nobody noticed for months.
 *
 * These are PROPERTIES, not lists. Add a sixth preset with a real skin behind
 * it and they stay quiet. Add one that collides with an existing felt, or one
 * that resolves to nothing, or bring back a gradient token that nothing reads,
 * and they fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TABLE_SKINS, TABLE_SKIN_IDS } from '../../src/assets/tableAssets';
import { resolveSkin, THEME_PRESET_SKINS } from '../../src/lib/tableTheme';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');

/** The ids the Themes tab actually renders, read from the shipped source. */
function offeredThemeIds(): string[] {
  const block = THEME_MODAL.match(/export const THEME_PRESETS[^=]*= \[([\s\S]*?)\n\];/);
  expect(block, 'the shared theme preset catalogue was not found').toBeTruthy();
  const ids = [...block![1].matchAll(/id: '([a-z0-9_-]+)'/g)].map((m) => m[1]);
  expect(ids.length, 'themes tab parsed empty').toBeGreaterThan(0);
  return ids;
}

describe('a theme preset repaints the table', () => {
  it('every id the Themes tab offers has a real skin behind it', () => {
    const dead = offeredThemeIds().filter((id) => {
      const alias = THEME_PRESET_SKINS[id];
      return !TABLE_SKINS[id] && !(alias && TABLE_SKINS[alias]);
    });
    expect(
      dead,
      `theme presets that resolve to nothing and so paint the default felt: ${dead.join(', ')}`
    ).toEqual([]);
  });

  it('no two presets resolve to the same skin', () => {
    // This is the bug, restated. Before the alias map all five landed on
    // classic_green, so this set had one member instead of five.
    const ids = offeredThemeIds();
    const painted = ids.map((id) => resolveSkin(id));
    const collisions = ids.filter((id, i) => painted.indexOf(painted[i]) !== i);
    expect(
      collisions,
      `presets painting a table another preset already paints: ${collisions.join(', ')}`
    ).toEqual([]);
    expect(new Set(painted).size).toBe(ids.length);
  });

  it('every alias target is a canonical skin id, not another alias', () => {
    const strays = Object.entries(THEME_PRESET_SKINS).filter(
      ([, skin]) => !TABLE_SKIN_IDS.includes(skin)
    );
    expect(strays, `aliases pointing at non-canonical ids: ${JSON.stringify(strays)}`).toEqual([]);
  });

  it('the preset bundles read the shared map instead of typing table_id again', () => {
    // A second hand-written copy of the pairing is how "Rustic Wood" came to
    // bundle the green casino felt while the felt code disagreed. The bundle
    // must derive table_id, never state it.
    // Body only: the type annotation legitimately names table_id (it Omits it).
    const trimmings = THEME_MODAL.match(/const PRESET_TRIMMINGS[^=]*=\s*\{([\s\S]*?)\n\};/);
    expect(trimmings, 'PRESET_TRIMMINGS not found — bundles were re-inlined?').toBeTruthy();
    expect(
      trimmings![1].includes('table_id'),
      'a preset bundle states table_id itself again; it must come from THEME_PRESET_SKINS'
    ).toBe(false);
    expect(THEME_MODAL).toContain('THEME_PRESET_SKINS');
  });
});

// ─── Dead styling tokens ─────────────────────────────────────────────────────

describe('the felt, background and rail gradient tokens are read or gone', () => {
  const SRC = path.join(root, 'src');

  function walk(dir: string, exts: string[]): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full, exts);
      return exts.includes(path.extname(e.name)) ? [full] : [];
    });
  }

  /** Family under guard: --felt-*, --bg-* and --rail-* properties whose name
   *  ends in -gradient. Derived by pattern, so a token invented tomorrow is
   *  covered without editing this test. */
  const FAMILY = /^--(?:felt|bg|rail)-[a-z0-9-]*gradient$/;

  it('no stylesheet defines one that no var() reads', () => {
    const cssFiles = walk(SRC, ['.css']);
    expect(cssFiles.length, 'no stylesheets found').toBeGreaterThan(0);

    const defined = new Map<string, string[]>();
    for (const file of cssFiles) {
      for (const m of read(path.relative(root, file)).matchAll(/(--[a-z0-9-]+)\s*:/g)) {
        if (!FAMILY.test(m[1])) continue;
        defined.set(m[1], [...(defined.get(m[1]) ?? []), path.relative(root, file)]);
      }
    }

    // var() calls wrap across lines in this codebase (DealAnimation.css puts the
    // name on its own line), so flatten whitespace before matching or the read
    // is undercounted and a live token looks dead.
    const readNames = new Set<string>();
    for (const file of walk(SRC, ['.css', '.ts', '.tsx', '.js', '.jsx'])) {
      const flat = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      for (const m of flat.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) readNames.add(m[1]);
    }

    const dead = [...defined.keys()].filter((name) => !readNames.has(name));
    expect(
      dead,
      `gradient tokens defined but never read: ${dead
        .map((n) => `${n} (in ${[...new Set(defined.get(n))].join(', ')})`)
        .join('; ')}`
    ).toEqual([]);
  });

  it('the inert [data-felt-theme] theme blocks stay deleted', () => {
    const tablePageCss = read('src/pages/TablePage.css');
    const rules = [...tablePageCss.matchAll(/\.table-page\[data-felt-theme=/g)];
    expect(
      rules.length,
      'the gradient-painted felt theme rules are back; the felt is an <img>, they paint nothing'
    ).toBe(0);
  });
});
