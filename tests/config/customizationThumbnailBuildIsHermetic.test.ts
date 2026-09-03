import packageJson from '../../package.json';
// @ts-expect-error - plain .mjs build helper, no type declarations by design
import { shouldGenerateCustomizationThumbnail } from '../../scripts/lib/customization-thumbnail-policy.mjs';

describe('customization thumbnail builds are hermetic', () => {
  it('skips a committed derivative during an ordinary production build', () => {
    expect(shouldGenerateCustomizationThumbnail({ outputExists: true, force: false })).toBe(false);
  });

  it('generates a missing derivative automatically', () => {
    expect(shouldGenerateCustomizationThumbnail({ outputExists: false, force: false })).toBe(true);
  });

  it('regenerates an existing derivative only for an explicit authoring run', () => {
    expect(shouldGenerateCustomizationThumbnail({ outputExists: true, force: true })).toBe(true);
  });

  it('keeps regeneration available as an explicit authoring command', () => {
    expect(packageJson.scripts?.['assets:customization-thumbnails']).toBe(
      'node scripts/generate-customization-thumbnails.mjs --force'
    );
  });
});
