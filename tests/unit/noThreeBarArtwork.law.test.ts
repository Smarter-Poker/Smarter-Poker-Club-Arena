/**
 * STANDALONE LEGACY THREE-BAR ARTWORK IS BANNED (2026-08-31).
 *
 * A navigation drawer may keep its behaviour and accessible name, but its
 * visible trigger uses the metallic command-center artwork outside the global
 * header. The global header is the explicit exception: its complete approved
 * raster contains the user-selected three-bar hamburger and must remain exact.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.jsx', '.ts', '.tsx']);

function productionTextFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTextFiles(path));
    } else if (TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const sourceFiles = [
  ...productionTextFiles(join(ROOT, 'src')),
  join(ROOT, 'index.html'),
  join(ROOT, 'public/sw-bus.js'),
];

describe('standalone three-horizontal-line artwork cannot replace approved navigation', () => {
  it('contains no three-bar glyph in production source, including comments', () => {
    const offenders = sourceFiles
      .filter((file) => /[☰≡≣]/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('contains no legacy three-bar asset or runtime asset reference', () => {
    const removedAssets = [
      'public/images/btn-hamburger-v4.png',
      'public/images/btn-hamburger.png',
      'public/images/btn-hamburger.webp',
      'public/images/global-header/menu.png',
      'public/images/global-header/command-center.png',
    ];
    expect(removedAssets.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);

    const forbiddenReference = /(btn-hamburger|icon-hamburger|global-header\/menu\.png)/;
    // sw-bus.js is the sole deliberate exception: it retains the retired URL
    // strings as cache tombstones so already-installed clients delete them.
    const offenders = sourceFiles
      .filter((file) => !file.endsWith('public/sw-bus.js'))
      .filter((file) => forbiddenReference.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('locks auxiliary command-center artwork and the user-approved global header', () => {
    const commandCenter = readFileSync(
      join(ROOT, 'public/images/global-header/command-center-v1.png')
    );
    const header = readFileSync(
      join(ROOT, 'public/images/global-header/global-header-desktop.png')
    );

    expect(createHash('sha256').update(commandCenter).digest('hex')).toBe(
      '11f1a8f09f01be94d9f0cc3f5838a463d72f3efa396515236685ef319beafac8'
    );
    expect(createHash('sha256').update(header).digest('hex')).toBe(
      '7c5613a84a395abd6b9527785b46c99fb28b6264e2258bee366a04cac5500c7f'
    );
  });

  it('keeps the approved hamburger in the global header and command-center art elsewhere', () => {
    const header = readFileSync(join(ROOT, 'src/components/navigation/GlobalHeader.tsx'), 'utf8');
    const floating = readFileSync(
      join(ROOT, 'src/components/navigation/FloatingHamburger.tsx'),
      'utf8'
    );
    const table = readFileSync(join(ROOT, 'src/components/table/TableMenu.tsx'), 'utf8');
    const shell = readFileSync(join(ROOT, 'src/components/Shell.tsx'), 'utf8');

    expect(header).toContain('global-header-desktop.png');
    expect(header).not.toContain('global-header-command-center-v1.png');
    for (const source of [floating, table, shell]) {
      expect(source).toContain('command-center-v1.png');
    }
  });

  it('purges every retired stable URL from persistent media caches', () => {
    const worker = readFileSync(join(ROOT, 'public/sw-bus.js'), 'utf8');
    for (const path of [
      '/hub/club-arena/images/btn-hamburger-v4.png',
      '/hub/club-arena/images/btn-hamburger.png',
      '/hub/club-arena/images/btn-hamburger.webp',
      '/hub/club-arena/images/global-header/menu.png',
    ]) {
      expect(worker).toContain(path);
    }
    expect(worker).toContain('purgeDecommissionedThreeBarArtwork()');
  });
});
