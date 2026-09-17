import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MASTER_WIDTHS = new Map<string, number>([
  ['/assets/club-buttons/console/spade-console-v1/', 1000],
  ['/assets/club-buttons/console/shark-console-v1/', 733],
  ['/assets/club-buttons/console/riveted-console-v1/', 729],
  ['/assets/club-buttons/popups/buy-in-v1/', 1000],
]);

describe('Diamond game console artwork', () => {
  it.each(['SpadeConsole', 'DeckConsole'])(
    '%s ships every referenced background',
    (consoleName) => {
      const css = readFileSync(
        resolve(process.cwd(), `src/components/console/${consoleName}.css`),
        'utf8'
      );
      const assets = [...css.matchAll(/url\(['"]?(\/assets\/[^'")]+\.png)['"]?\)/g)].map(
        (match) => match[1]
      );
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of new Set(assets)) {
        // Missing public files are left as root URLs by Vite. They then hit the
        // World Hub instead of the mounted Arena and leave the controls unframed.
        const png = readFileSync(resolve(process.cwd(), `public${asset}`));
        expect(png.subarray(0, 8).toString('hex'), asset).toBe('89504e470d0a1a0a');
        const master = [...MASTER_WIDTHS].find(([prefix]) => asset.startsWith(prefix));
        expect(master, `${asset}: register the approved master at its native width`).toBeDefined();
        expect(png.readUInt32BE(16), asset).toBe(master?.[1]);
        expect(png.readUInt32BE(20), asset).toBeGreaterThan(0);
      }
    }
  );
});
