import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('premium customization suite', () => {
  const modal = read('src/components/table/ThemeSettingsModal.tsx');
  const preview = read('src/components/table/TableStudioGameplayPreview.tsx');
  const tablePage = read('src/pages/TablePage.tsx');
  const assets = read('src/assets/tableAssets.ts');
  const collections = read('src/hooks/useTableStudioCollections.ts');

  it('uses the existing avatar service instead of a duplicate avatar catalog', () => {
    expect(modal).toContain('.getAvatarLibraryResult(userId)');
    expect(modal).toContain('avatar.thumbUrl || avatar.imageUrl');
    expect(preview).not.toContain('/avatars/');
  });

  it('renders full gameplay and Final Table previews', () => {
    expect(preview).toContain('studio-game-preview__seat');
    expect(preview).toContain('studio-game-preview__board');
    expect(preview).toContain('studio-game-preview__actions');
    expect(modal).toContain('finalTable={previewFinalTable}');
  });

  it('keeps the Final Table arena event-only', () => {
    expect(assets).toContain('final_table_broadcast: bgFinalTableBroadcast');
    const selectableIds = assets.match(/TABLE_BACKGROUND_IDS: string\[\] = \[([\s\S]*?)\];/)?.[1];
    expect(selectableIds).not.toContain('final_table_broadcast');
    expect(tablePage).toContain("tableState.isFinalTable ? 'final_table_broadcast'");
    expect(tablePage).toContain("tableState.isFinalTable\n                  ? 'final_table'");
    expect(preview).toContain('? TABLE_SKINS.final_table');
  });

  it('provides mobile discovery and personal loadout controls', () => {
    for (const feature of ["'favorites'", "'recent'", 'Shuffle Look']) {
      expect(modal).toContain(feature);
    }
    expect(collections).toContain('table-studio-loadouts:');
    expect(collections).toContain('table-studio-favorites:');
    expect(collections).toContain(".from('user_table_studio_preferences')");
  });

  it('prioritizes the selected gameplay art while catalog art stays progressive', () => {
    const css = read('src/components/table/ThemeSettingsModal.css');
    expect(preview.match(/fetchPriority="high"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(preview.match(/loading="eager"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(modal).toContain('loading="lazy"');
    expect(assets).toContain('TABLE_SKIN_THUMBNAILS');
    expect(assets).toContain('TABLE_BACKGROUND_THUMBNAILS');
    expect(css).toContain('content-visibility: auto');
  });
});
