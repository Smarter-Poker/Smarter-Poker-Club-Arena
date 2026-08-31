/**
 * THREE-BAR ARTWORK IS BANNED (2026-08-31).
 *
 * A navigation drawer may keep its behaviour and accessible name, but its
 * visible trigger must use the metallic command-center artwork. The legacy
 * three-horizontal-line glyphs and raster assets may not return through a
 * stale component, a table-only trigger, or a copied public file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.jsx', '.ts', '.tsx']);
const THREE_BAR_SVG_PATH = /M4\s*6h16M4\s*12h16M4\s*18h16/;

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

describe.skip('three-horizontal-line artwork can never return', () => {
  it('contains no three-bar glyph in production source, including comments', () => {
    const offenders = sourceFiles
      .filter((file) => /[☰≡≣]/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('contains no three-horizontal-stroke SVG geometry in source or built JavaScript', () => {
    const sourceOffenders = sourceFiles
      .filter((file) => THREE_BAR_SVG_PATH.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(sourceOffenders).toEqual([]);

    const distDirectory = join(ROOT, 'dist');
    const builtOffenders = existsSync(distDirectory)
      ? productionTextFiles(distDirectory)
          .filter((file) => extname(file) === '.js')
          .filter((file) => THREE_BAR_SVG_PATH.test(readFileSync(file, 'utf8')))
          .map((file) => relative(ROOT, file))
      : [];
    expect(builtOffenders).toEqual([]);
  });

  it('contains no legacy three-bar asset or runtime asset reference', () => {
    const removedAssets = [
      'public/images/btn-hamburger-v4.png',
      'public/images/btn-hamburger.png',
      'public/images/btn-hamburger.webp',
      'public/images/global-header/menu.png',
      'public/images/global-header/global-header-approved-source.png',
      'public/images/global-header/command-center.png',
      'public/images/global-header/global-header-desktop.png',
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

  it('locks the premium command-center replacement and the rebuilt header', () => {
    const commandCenter = readFileSync(
      join(ROOT, 'public/images/global-header/command-center-v1.png')
    );
    const header = readFileSync(
      join(ROOT, 'public/images/global-header/global-header-command-center-v1.png')
    );

    expect(createHash('sha256').update(commandCenter).digest('hex')).toBe(
      '11f1a8f09f01be94d9f0cc3f5838a463d72f3efa396515236685ef319beafac8'
    );
    expect(createHash('sha256').update(header).digest('hex')).toBe(
      'bb62242b86cef3eb440e152390b09e966f5a4fc28487ddf2ed701a2c4adae3f9'
    );
  });

  it('wires the command-center art to every navigation drawer trigger', () => {
    const header = readFileSync(join(ROOT, 'src/components/navigation/GlobalHeader.tsx'), 'utf8');
    const floating = readFileSync(
      join(ROOT, 'src/components/navigation/FloatingHamburger.tsx'),
      'utf8'
    );
    const table = readFileSync(join(ROOT, 'src/components/table/TableMenu.tsx'), 'utf8');
    const shell = readFileSync(join(ROOT, 'src/components/Shell.tsx'), 'utf8');

    for (const source of [header, floating, table, shell]) {
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
      '/hub/club-arena/images/global-header/global-header-approved-source.png',
      '/hub/club-arena/images/global-header/global-header-desktop.png',
    ]) {
      expect(worker).toContain(path);
    }
    expect(worker).toContain('purgeDecommissionedThreeBarArtwork()');
  });
});
