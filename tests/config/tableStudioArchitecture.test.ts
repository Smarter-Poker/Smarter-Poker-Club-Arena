import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TABLE_BACKGROUND_IDS } from '../../src/assets/tableAssets';
import { BUTTON_ASSETS, THEME_PRESETS } from '../../src/components/table/ThemeSettingsModal';
import { TABLE_SETTINGS_META } from '../../src/hooks/useUserTableSettings';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

const MODAL = read('src/components/table/ThemeSettingsModal.tsx');
const MODAL_CSS = read('src/components/table/ThemeSettingsModal.css');
const PREVIEW_CSS = read('src/components/table/TableStudioGameplayPreview.css');
const HAMBURGER = read('src/components/navigation/HamburgerMenu.tsx');
const PANEL = read('src/components/table/SettingsPanel.tsx');
const TOGGLES = read('src/components/table/TableSettingsPanel.tsx');
const SETTINGS = read('src/pages/SettingsPage.tsx');
const MIGRATION = read(
  'supabase/migrations/20260829163000_sync_extended_background_catalog_and_cardback_entitlements.sql'
);

describe('Table Studio is the one owner of selectable table appearance', () => {
  it('keeps every visual category in Table Studio, including Buttons', () => {
    expect(MODAL).toContain("{ key: 'button', label: 'Buttons' }");
    expect(MODAL).not.toContain("{ key: 'button', label: 'Controls' }");
    for (const category of ['Looks', 'Tables', 'Scenes', 'Buttons', 'Cards']) {
      expect(MODAL).toContain(`label: '${category}'`);
    }
  });

  it('removes visual selectors from both table-settings surfaces', () => {
    expect(PANEL).not.toContain('CardBackSelector');
    expect(PANEL).not.toContain('TABLE_THEMES');
    expect(PANEL).not.toContain('tableTheme');
    expect(TOGGLES).not.toContain('onOpenThemeSettings');
    expect(TOGGLES).not.toContain('Theme Settings Link');
    expect(HAMBURGER).not.toContain('Card Colors');
    expect(HAMBURGER).not.toContain('selectedCardColor');
    expect(TABLE_SETTINGS_META.map((setting) => setting.key)).not.toContain('blue_buttons_enabled');
  });

  it('gives each host a premium launcher into the same studio', () => {
    for (const source of [HAMBURGER, PANEL, SETTINGS]) {
      expect(source).toContain('Table Studio');
      expect(source).toContain('<ThemeSettingsModal');
    }
    expect(SETTINGS).not.toContain('Card Back Style');
  });
});

describe('Table Studio defaults and catalogue contract', () => {
  it('keeps White D first, free, and the canonical default', () => {
    expect(BUTTON_ASSETS).toHaveLength(10);
    expect(BUTTON_ASSETS[0]).toMatchObject({
      id: 'classic-white',
      name: 'White D',
      vipOnly: false,
    });
    expect(MODAL).toMatch(/button_id:\s*'classic-white'/);
  });

  it('provides ten complete themes without inventing a second asset model', () => {
    expect(THEME_PRESETS).toHaveLength(10);
    expect(MODAL).toContain('TABLE_FELT_CATALOG.map');
    expect(MODAL).toContain('CARD_BACK_CATALOG.map');
    expect(MODAL).toContain('TABLE_BACKGROUND_IDS.map');
  });

  it('registers every extended background with the database gate', () => {
    expect(TABLE_BACKGROUND_IDS).toHaveLength(30);
    for (const id of TABLE_BACKGROUND_IDS.filter(
      (assetId) => assetId.startsWith('place_') || assetId.startsWith('skin_')
    )) {
      expect(MIGRATION, `${id} must be known to cosmetic_catalog`).toContain(`'${id}'`);
    }
    expect(MIGRATION).toContain("fp.feature = 'card_back_' || p_asset_id");
  });
});

describe('the design is mobile first and never crops selectable artwork', () => {
  it('uses a full mobile viewport and a 3/4-style desktop workstation', () => {
    expect(MODAL_CSS).toContain('height: 100dvh');
    expect(MODAL_CSS).toContain('width: min(92vw, 1440px)');
    expect(MODAL_CSS).toContain('grid-template-columns: minmax(360px, 44%) minmax(0, 56%)');
  });

  it('contains foreground table and background art in tiles and the live preview', () => {
    expect(MODAL_CSS).toMatch(/\.theme-asset__img\s*\{[^}]*object-fit:\s*contain/s);
    expect(MODAL_CSS).toMatch(/\.theme-asset__img--background\s*\{[^}]*object-fit:\s*contain/s);
    expect(PREVIEW_CSS).toMatch(
      /\.studio-game-preview__background\s*\{[^}]*object-fit:\s*contain/s
    );
    expect(PREVIEW_CSS).toMatch(/\.studio-game-preview__table\s*\{[^}]*object-fit:\s*contain/s);
  });

  it('uses ambient duplicates only as framing behind the uncropped art', () => {
    expect(MODAL).toContain('theme-asset__ambient');
    expect(MODAL).toContain('theme-asset__img--background');
    expect(MODAL).toContain('studio');
    expect(MODAL_CSS).toMatch(/\.theme-asset__ambient[^}]*object-fit:\s*cover/s);
    expect(PREVIEW_CSS).toMatch(
      /\.studio-game-preview__background-ambient[^}]*object-fit:\s*cover/s
    );
  });
});
