import { describe, expect, it } from 'vitest';
import { fontFileName } from '../../scripts/lib/font-file-name.mjs';

describe('a self-hosted font file name', () => {
  it('keeps the name the font pool already holds for a normal gstatic URL', () => {
    expect(
      fontFileName(
        'https://fonts.gstatic.com/s/inter/v19/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2'
      )
    ).toBe('inter-v19-UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2');
  });

  it('names a kit URL by its hash, with nothing a file system or an upload refuses', () => {
    const kit =
      'https://fonts.gstatic.com/l/font?kit=8vIj7ww63mVu7gtR-kwKxNvkNOjw-tbnL4HN_JbF1aPAUkg8uW-Uu3g&skey=f319ae&v=v18';
    const name = fontFileName(kit);
    expect(name).toMatch(/^gstatic-[0-9a-f]{20}\.woff2$/);
    expect(fontFileName(kit)).toBe(name);
    expect(fontFileName(`${kit}x`)).not.toBe(name);
  });

  it('never returns a name with a separator, a colon or a query in it', () => {
    for (const url of [
      'https://fonts.gstatic.com/s/inter/v19/a.woff2?x=1',
      'https://fonts.gstatic.com/s/in:ter/v19/a.woff2',
      'https://example.com/font.woff2',
    ])
      expect(fontFileName(url)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
