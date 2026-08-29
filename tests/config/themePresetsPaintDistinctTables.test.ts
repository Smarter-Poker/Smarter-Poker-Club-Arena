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
import {
  feltDesign,
  resolveSkin,
  THEME_PRESET_BUNDLES,
  THEME_PRESET_CATALOG,
  THEME_PRESET_SKINS,
} from '../../src/lib/tableTheme';
import { THEME_PRESETS } from '../../src/components/table/ThemeSettingsModal';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');

/** The ids the Themes tab actually renders, from its shared runtime catalog. */
function offeredThemeIds(): string[] {
  const ids = THEME_PRESET_CATALOG.map((preset) => preset.id);
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

  it('a free preset never bundles a VIP felt that the database will reject', () => {
    const invalid = THEME_PRESETS.filter((preset) => !preset.vipOnly).filter(
      (preset) => feltDesign(THEME_PRESET_SKINS[preset.id]).tier !== 'standard'
    );
    expect(
      invalid.map((preset) => preset.id),
      'free preset tiles must be persistable by a non-VIP player'
    ).toEqual([]);
  });

  it('the picker, resolver and bundle read one composite catalog', () => {
    for (const preset of THEME_PRESET_CATALOG) {
      expect(THEME_PRESET_SKINS[preset.id]).toBe(preset.table_id);
      expect(THEME_PRESET_BUNDLES[preset.id]).toEqual({
        table_id: preset.table_id,
        button_id: preset.button_id,
        background_id: preset.background_id,
        cards_id: preset.cards_id,
      });
    }
    expect(THEME_MODAL).toContain('THEME_PRESET_CATALOG.map');
    expect(THEME_MODAL).toContain('THEME_PRESET_BUNDLES[assetId]');
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
