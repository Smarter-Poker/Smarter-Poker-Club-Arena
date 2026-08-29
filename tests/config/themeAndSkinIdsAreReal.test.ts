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
import { TABLE_FELT_CATALOG, THEME_PRESET_SKINS } from '../../src/lib/tableTheme';
import { THEME_PRESETS } from '../../src/components/table/ThemeSettingsModal';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const TABLE_ASSETS = read('src/assets/tableAssets.ts');
const THEME_MODAL = read('src/components/table/ThemeSettingsModal.tsx');

describe('a theme you can pick is a theme that exists', () => {
  it('every Table Studio preset resolves to a real table skin', () => {
    const realFelts = new Set(TABLE_FELT_CATALOG.map((felt) => felt.id));
    const dead = THEME_PRESETS.filter(
      (preset) => !THEME_PRESET_SKINS[preset.id] || !realFelts.has(THEME_PRESET_SKINS[preset.id])
    ).map((preset) => preset.id);
    expect(dead, `theme presets with no real table skin: ${dead.join(', ')}`).toEqual([]);
  });

  it('all ten premium presets are distinct ids', () => {
    const offered = THEME_PRESETS.map((preset) => preset.id);
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered).toHaveLength(10);
    expect(Object.keys(THEME_PRESET_SKINS).sort()).toEqual([...offered].sort());
  });

  it('the eight invented themes never come back', () => {
    // The exact ids the customization picker used to offer. Every one of them
    // matched nothing. 'gold' is NOT in this list: it is a real theme with a
    // real [data-theme='gold'] block, and it survives.
    const offered = THEME_PRESETS.map((preset) => preset.id);
    for (const invented of ['classic', 'crimson', 'ocean', 'royal', 'sunset', 'neon', 'midnight']) {
      expect(offered.includes(invented), `Table Studio offers the dead id ${invented} again`).toBe(
        false
      );
    }
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

  function eventSkinIds(): string[] {
    const block = TABLE_ASSETS.match(/EVENT_TABLE_SKIN_IDS: string\[\] = \[([\s\S]*?)\];/);
    expect(block, 'EVENT_TABLE_SKIN_IDS not found').toBeTruthy();
    return [...block![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  }

  it('every canonical skin id imports a file that is on disk', () => {
    const ids = canonicalSkinIds();
    expect(ids.length).toBeGreaterThanOrEqual(13);
    const missing = ids.filter((id) => !fs.existsSync(path.join(skinDir, `skin_${id}.png`)));
    expect(missing, `skin ids with no artwork: ${missing.join(', ')}`).toEqual([]);
  });

  it('every skin file on disk is selectable or event-driven (no orphaned artwork)', () => {
    const ids = new Set([...canonicalSkinIds(), ...eventSkinIds()]);
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

  it('the Theme Settings table tab is GENERATED, so it cannot offer a dead skin', () => {
    const registry = new Set(
      [...TABLE_ASSETS.matchAll(/^\s{2}'?([a-z0-9_-]+)'?:\s*skin/gm)].map((m) => m[1])
    );
    expect(registry.size, 'TABLE_SKINS registry parsed empty').toBeGreaterThan(0);

    // 2026-08-25: this used to read a hand-maintained `table: [ ... ]` array out
    // of the modal and check each id against the registry. That array is gone -
    // the tab is derived from TABLE_FELT_CATALOG, which is itself built from the
    // skin registry - so the old locator matched nothing and the test failed on
    // a change that made the bug it guards against impossible. It was RED ON
    // MAIN, which stops the World Hub sync for every agent.
    //
    // Two invariants are pinned now, because they catch different regressions.
    //
    // STRUCTURAL: the tab must be generated, never hand-listed. A literal array
    // here is a regression by itself, since it can drift from the registry.
    expect(THEME_MODAL).toMatch(/^\s{2}table: TABLE_ASSETS,$/m);
    expect(THEME_MODAL).toMatch(/const TABLE_ASSETS: ThemeAsset\[\] = TABLE_FELT_CATALOG\.map/);
    expect(
      THEME_MODAL,
      'the table tab is a literal array again - it can drift from the skin registry'
    ).not.toMatch(/\n\s{2}table: \[/);

    // RESOLUTION: and every id the catalogue offers must still resolve to real
    // artwork. Generating the list makes a hand-typed dead id impossible; it
    // does not make a dead id in the CATALOGUE impossible.
    const offered = TABLE_FELT_CATALOG.map((f) => f.id);
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
