import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUTTON_ASSETS } from '../../src/components/table/ThemeSettingsModal';

const read = (path: string) => readFileSync(path, 'utf8');

describe('visual customization integration contracts', () => {
  const studio = read('src/components/table/ThemeSettingsModal.tsx');
  const gallery = read('src/components/customization/AvatarGallery.tsx');
  const table = read('src/pages/TablePage.tsx');
  const multi = read('src/pages/MultiTablePage.tsx');

  it('routes every Table Studio asset through the canonical ordered writer', () => {
    expect(studio).toContain('applyTableAppearance(patch');
    expect(studio).not.toMatch(/from\('user_theme_settings'\)\.upsert/);
    expect(studio).toContain('pickThemeRow(data || []');
  });

  it('keeps the client starter row aligned with canonical database defaults', () => {
    const hook = read('src/hooks/useUserThemeSettings.ts');
    const migration = read('supabase/migrations/20260827220315_canonical_user_theme_defaults.sql');
    for (const id of [
      'default-dark',
      'classic_green',
      'classic-white',
      'midnight',
      'classic_red',
    ]) {
      expect(hook + studio).toContain(id);
      expect(migration).toContain(id);
    }
  });

  it('publishes avatar and cosmetic changes before awaiting persistence', () => {
    const cosmeticStart = gallery.indexOf("source: 'cosmetic-picker'");
    const cosmeticWrite = gallery.indexOf('await avatarService.setCosmetics');
    const avatarStart = gallery.indexOf("source: 'avatar-picker'");
    const avatarWrite = gallery.indexOf('await avatarService.setUserAvatar');
    expect(cosmeticStart).toBeGreaterThan(-1);
    expect(cosmeticStart).toBeLessThan(cosmeticWrite);
    expect(avatarStart).toBeGreaterThan(-1);
    expect(avatarStart).toBeLessThan(avatarWrite);
    expect(gallery).toContain("source: 'rollback'");
  });

  it('does not mistake a rapid return to the original avatar for an already-applied choice', () => {
    expect(gallery).toContain('if (newUrl === previousUrl)');
    expect(gallery).not.toContain('if (newUrl === currentAvatarUrl)');
    expect(gallery).toContain('const previousUrl = selectedAvatarRef.current');
  });

  it('binds all five art selections to the live table surface', () => {
    expect(table).toContain('data-felt-theme=');
    expect(table).toContain('data-background-theme=');
    expect(table).toContain("data-button-theme={v8Theme.button_id || 'classic-white'}");
    expect(table).toContain('data-cards-theme={activeCardBack}');
    expect(table).toContain("data-theme-preset={v8Theme.theme_id || 'default-dark'}");
  });

  it('makes every selectable control theme reach the gameplay action buttons', () => {
    const controlCss = read('src/components/table/ControlThemeTokens.css');
    const actionCss = read('src/components/table/ActionPanel.css');
    const preview = read('src/components/table/TableStudioGameplayPreview.tsx');
    const tablePage = read('src/pages/TablePage.tsx');

    for (const asset of BUTTON_ASSETS) {
      const selector = `[data-button-theme='${asset.id}']`;
      expect(
        (controlCss.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [])
          .length
      ).toBe(1);
    }
    expect(controlCss).toContain('--dealer-btn-bg:');
    expect(controlCss).toContain('--action-control-overlay:');
    expect(actionCss).toContain('var(--action-control-overlay, transparent)');
    expect(actionCss).toContain('var(--action-control-radius, 14px)');
    expect(studio).toContain('theme-asset__actionset');
    expect(studio).toContain("import './ControlThemeTokens.css'");
    expect(tablePage).toContain("import '../components/table/ControlThemeTokens.css'");
    expect(preview).toContain('data-button-theme={selection.button_id}');
  });

  it('mounts a real TablePage for every persistent multi-table slot', () => {
    expect((multi.match(/<TablePage/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(multi).toContain('embeddedTableId={table.id}');
  });
});
