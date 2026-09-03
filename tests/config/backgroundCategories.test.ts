import { TABLE_BACKGROUND_IDS } from '../../src/assets/tableAssets';
import { BACKGROUND_SKIN_IDS } from '../../src/components/table/ThemeSettingsModal';

describe('background customization categories', () => {
  it('provides ten recognizable place backgrounds', () => {
    expect(TABLE_BACKGROUND_IDS.filter((id) => id.startsWith('place_'))).toHaveLength(10);
  });

  it('provides ten poker-pattern skins', () => {
    expect(BACKGROUND_SKIN_IDS.size).toBe(10);
    expect([...BACKGROUND_SKIN_IDS].every((id) => TABLE_BACKGROUND_IDS.includes(id))).toBe(true);
  });

  it('keeps rooms and places separate from pattern skins', () => {
    expect(TABLE_BACKGROUND_IDS.filter((id) => !BACKGROUND_SKIN_IDS.has(id))).toHaveLength(20);
  });
});
