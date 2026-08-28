import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('table appearance modes and portrait-safe backgrounds', () => {
  it('offers both light and dark modes inside Table Studio', () => {
    const modal = read('src/components/table/ThemeSettingsModal.tsx');
    expect(modal).toContain("(['light', 'dark'] as const)");
    expect(modal).toContain('handleUiModeChange(mode)');
    expect(modal).toContain('persistInterfaceTheme(userId, mode)');
  });

  it('applies a selected mode immediately to the document root', () => {
    const store = read('src/stores/useSettingsStore.ts');
    expect(store).toContain("document.documentElement.setAttribute('data-theme', theme)");
    expect(store).toContain('document.documentElement.style.colorScheme = theme');
  });

  it('preserves the complete background frame on portrait screens', () => {
    const css = read('src/pages/TablePage.css');
    const page = read('src/pages/TablePage.tsx');
    expect(css).toContain('@media (max-aspect-ratio: 3 / 4)');
    expect(css).toContain('--sp-background-layers-size: cover, cover, 100% 100%');
    expect(page).toContain('var(--sp-background-layers-size');
  });

  it('uses the event-only Final Table skin for MTTs', () => {
    const page = read('src/pages/TablePage.tsx');
    const assets = read('src/assets/tableAssets.ts');
    expect(assets).toContain('final_table: skinFinalTable');
    expect(page).toContain('setTableState((prev) => ({ ...prev, isFinalTable: true }))');
    expect(page).toContain("/\\bfinal table\\b/i.test(table.name || '')");
    expect(page).toContain("? 'final_table'");
  });
});
