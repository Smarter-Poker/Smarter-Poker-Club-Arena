/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EVERY THEME AND SKIN YOU CAN PICK MUST BE ONE THAT EXISTS (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Same defect as the card backs, on the theme surfaces. `components/
 * customization/ThemeSelector` offered eight themes — classic, midnight,
 * crimson, ocean, royal, sunset, neon, gold — and not one of those ids existed
 * anywhere in the codebase: no `[data-theme='...']` block, no felt, no token.
 * Every tile painted three flat swatches, and picking any of them changed
 * nothing on screen and wrote nothing anywhere.
 *
 * These tests pin the PROPERTY, not the list. Add a theme with real tokens and
 * they stay quiet; offer one without and they fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const DESIGN_TOKENS = read('src/styles/design-tokens.css');
const GLOBALS = read('src/styles/globals.css');
const TABLE_THEME_SELECTOR = read('src/components/table/ThemeSelector.tsx');
const CUSTOMIZATION_SELECTOR = read('src/components/customization/ThemeSelector.tsx');
const TABLE_ASSETS = read('src/assets/tableAssets.ts');
const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');
const TABLE_THEME_LIB = read('src/lib/tableTheme.ts');

/** Every id with a real `[data-theme='<id>']` rule in the shipped stylesheets. */
function idsWithThemeTokens(): Set<string> {
  const css = DESIGN_TOKENS + '\n' + GLOBALS;
  const ids = [...css.matchAll(/\[data-theme=['"]([a-z0-9_-]+)['"]\]/g)].map((m) => m[1]);
  expect(ids.length, 'no [data-theme] rules found at all').toBeGreaterThan(0);
  return new Set(ids);
}

/** The ids the one shared theme list offers. */
function tableThemeIds(): string[] {
  const block = TABLE_THEME_SELECTOR.match(/TABLE_THEMES: ThemeOption\[\] = \[([\s\S]*?)\n\];/);
  expect(block, 'TABLE_THEMES not found in table/ThemeSelector.tsx').toBeTruthy();
  const ids = [...block![1].matchAll(/id: '([a-z0-9_-]+)'/g)].map((m) => m[1]);
  expect(ids.length, 'TABLE_THEMES parsed empty').toBeGreaterThan(0);
  return ids;
}

describe('a theme you can pick is a theme that exists', () => {
  it('every TABLE_THEMES id except the default has a [data-theme] token block', () => {
    const real = idsWithThemeTokens();
    const offered = tableThemeIds();
    // 'green' is the bare :root default — the attribute is REMOVED for it,
    // which is why it is the one id allowed to have no block of its own.
    const needsTokens = offered.filter((id) => id !== 'green');
    const dead = needsTokens.filter((id) => !real.has(id));
    expect(dead, `themes offered with no styling behind them: ${dead.join(', ')}`).toEqual([]);
  });

  it('all seven themes are distinct ids', () => {
    const offered = tableThemeIds();
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered.length).toBeGreaterThanOrEqual(7);
  });

  it('the eight invented themes never come back', () => {
    // The exact ids the customization picker used to offer. Every one of them
    // matched nothing. 'gold' is NOT in this list: it is a real theme with a
    // real [data-theme='gold'] block, and it survives.
    const real = idsWithThemeTokens();
    for (const invented of ['classic', 'crimson', 'ocean', 'royal', 'sunset', 'neon', 'midnight']) {
      expect(real.has(invented), `${invented} still has no tokens, so nothing may offer it`).toBe(
        false
      );
      expect(
        CUSTOMIZATION_SELECTOR.includes(`id: '${invented}'`),
        `customization/ThemeSelector offers the dead id ${invented} again`
      ).toBe(false);
    }
  });

  it('the customization picker renders the shared list, not a second copy', () => {
    // A duplicated catalogue is how the card-back bug survived five days after
    // it was "fixed": one copy got the fix, the other kept shipping dead ids.
    expect(CUSTOMIZATION_SELECTOR).toContain('TABLE_THEMES');
    const ownList = CUSTOMIZATION_SELECTOR.match(/previewColors/);
    expect(ownList, 'customization/ThemeSelector is carrying its own theme list again').toBeNull();
  });
});

// ─── Table skins ─────────────────────────────────────────────────────────────

describe('a table skin you can pick is a skin that exists', () => {
  const skinDir = path.join(root, 'src/assets/tables');

  function canonicalSkinIds(): string[] {
    const block = TABLE_ASSETS.match(/TABLE_SKIN_IDS: string\[\] = \[([\s\S]*?)\];/);
    expect(block, 'TABLE_SKIN_IDS not found').toBeTruthy();
    return [...block![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  }

  it('every canonical skin id imports a file that is on disk', () => {
    const ids = canonicalSkinIds();
    expect(ids.length).toBeGreaterThanOrEqual(13);
    const missing = ids.filter((id) => !fs.existsSync(path.join(skinDir, `skin_${id}.png`)));
    expect(missing, `skin ids with no artwork: ${missing.join(', ')}`).toEqual([]);
  });

  it('every skin file on disk is offered by an id (no orphaned artwork)', () => {
    const ids = new Set(canonicalSkinIds());
    const onDisk = fs
      .readdirSync(skinDir)
      .filter((f) => f.startsWith('skin_') && f.endsWith('.png'))
      .map((f) => f.replace(/^skin_/, '').replace(/\.png$/, ''));
    const orphans = onDisk.filter((id) => !ids.has(id));
    expect(orphans, `artwork shipped that nothing can select: ${orphans.join(', ')}`).toEqual([]);
  });

  it('no two skins are the same picture', () => {
    // The card-back defect in its purest form: eight choices, one image.
    const files = fs.readdirSync(skinDir).filter((f) => f.endsWith('.png'));
    const hashes = files.map((f) =>
      crypto
        .createHash('md5')
        .update(fs.readFileSync(path.join(skinDir, f)))
        .digest('hex')
    );
    expect(new Set(hashes).size, 'two table skins are byte-identical').toBe(files.length);
  });

  /* The modal's table tab stopped being a typed-out array on 2026-08-25 - it is
     generated from TABLE_FELT_CATALOG now, which is itself generated from
     TABLE_SKIN_IDS, which is exactly the fix this test was written to demand.
     The scraper still looked for `table: [ ... ]` and matched nothing, so the
     test went red on main against code that had made the defect impossible.
     It reads the new shape and checks the same property, at both hops. */
  it('every skin id the Theme Settings picker offers is in the registry', () => {
    const registry = new Set(
      [...TABLE_ASSETS.matchAll(/^\s{2}'?([a-z0-9_-]+)'?:\s*skin/gm)].map((m) => m[1])
    );
    expect(registry.size, 'TABLE_SKINS registry parsed empty').toBeGreaterThan(0);

    // Hop 1: the tab is derived, not typed. A hand-written list here is how the
    // two pickers drifted apart in the first place.
    const tableTab = THEME_MODAL.match(/\n {2}table: ([A-Za-z_]+),/);
    expect(tableTab, "the modal's table tab was not found").toBeTruthy();
    expect(tableTab![1]).toBe('TABLE_ASSETS');
    expect(THEME_MODAL, 'the table tab is no longer generated from the catalogue').toMatch(
      /const TABLE_ASSETS: ThemeAsset\[\] = TABLE_FELT_CATALOG\.map/
    );

    // Hop 2: the catalogue is built from the registry's own id list...
    expect(TABLE_THEME_LIB, 'TABLE_FELT_CATALOG is no longer derived from TABLE_SKIN_IDS').toMatch(
      /export const TABLE_FELT_CATALOG[\s\S]{0,400}TABLE_SKIN_IDS/
    );

    // ...and every id on that list resolves to a real skin, which is the thing
    // a player would otherwise discover by picking a tile that paints nothing.
    const idBlock = /export const TABLE_SKIN_IDS: string\[\] = \[([\s\S]*?)\];/.exec(TABLE_ASSETS);
    expect(idBlock, 'TABLE_SKIN_IDS not found').toBeTruthy();
    const offered = [...idBlock![1].matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(0);
    const dead = offered.filter((id) => !registry.has(id));
    expect(dead, `table skins offered that resolve to nothing: ${dead.join(', ')}`).toEqual([]);
  });
});

// ─── Backgrounds and club logos ──────────────────────────────────────────────

describe('backgrounds and club logos are real and distinct', () => {
  it('every background id has its own artwork', () => {
    const block = TABLE_ASSETS.match(/TABLE_BACKGROUND_IDS: string\[\] = \[([\s\S]*?)\];/);
    expect(block).toBeTruthy();
    const ids = [...block![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const dir = path.join(root, 'src/assets/backgrounds');
    const missing = ids.filter((id) => !fs.existsSync(path.join(dir, `bg_${id}.jpg`)));
    expect(missing, `background ids with no artwork: ${missing.join(', ')}`).toEqual([]);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'));
    const hashes = files.map((f) =>
      crypto
        .createHash('md5')
        .update(fs.readFileSync(path.join(dir, f)))
        .digest('hex')
    );
    expect(new Set(hashes).size, 'two backgrounds are byte-identical').toBe(files.length);
  });

  it('all 25 club logo presets exist and none is a duplicate', () => {
    const src = read('src/components/ClubLogoSelector.tsx');
    const files = [...src.matchAll(/file: '(\/club-logos\/[a-z0-9-]+\.webp)'/g)].map((m) => m[1]);
    expect(files.length).toBe(25);
    const missing = files.filter((f) => !fs.existsSync(path.join(root, 'public', f)));
    expect(missing, `preset logos referenced but not shipped: ${missing.join(', ')}`).toEqual([]);
    const hashes = files.map((f) =>
      crypto
        .createHash('md5')
        .update(fs.readFileSync(path.join(root, 'public', f)))
        .digest('hex')
    );
    expect(new Set(hashes).size, 'two preset logos are the same image').toBe(files.length);
  });
});
