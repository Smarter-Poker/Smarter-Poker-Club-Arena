import { describe, expect, it } from 'vitest';
import { TABLE_BACKGROUND_IDS } from '../../src/assets/tableAssets';
import { BUTTON_ASSETS, THEME_PRESETS } from '../../src/components/table/ThemeSettingsModal';
import { CARD_BACK_CATALOG } from '../../src/components/table/CardImage';
import { TABLE_FELT_CATALOG } from '../../src/lib/tableTheme';

const MINIMUM_DESIGNS = 10;

describe('every player appearance category offers a full collection', () => {
  const categories = {
    themes: THEME_PRESETS,
    tables: TABLE_FELT_CATALOG,
    backgrounds: TABLE_BACKGROUND_IDS,
    decks: CARD_BACK_CATALOG,
    buttons: BUTTON_ASSETS,
  };

  for (const [name, designs] of Object.entries(categories)) {
    it(`offers at least ${MINIMUM_DESIGNS} ${name}`, () => {
      expect(designs.length, `${name} dropped below the product minimum`).toBeGreaterThanOrEqual(
        MINIMUM_DESIGNS
      );
    });
  }

  it('does not pad a category with duplicate ids', () => {
    for (const [name, designs] of Object.entries(categories)) {
      const ids = designs.map((design) => (typeof design === 'string' ? design : design.id));
      expect(new Set(ids).size, `${name} contains duplicate designs`).toBe(ids.length);
    }
  });
});
