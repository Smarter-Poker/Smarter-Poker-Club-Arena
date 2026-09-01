/**
 * THREE-BAR ARTWORK IS BANNED (2026-09-01).
 *
 * Navigation drawers keep their behaviour and accessible names, but every
 * visible trigger is a six-tile command grid. Horizontal menu-bar glyphs,
 * their exact SVG geometry, and every retired raster may never return through
 * source, a stale public file, or generated build output.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.map',
  '.ts',
  '.tsx',
  '.webmanifest',
]);
const THREE_BAR_SVG_PATH = /M4\s*6h16M4\s*12h16M4\s*18h16/;
const FORBIDDEN_REFERENCE =
  /(btn-hamburger|icon-hamburger|global-header\/menu\.png|global-header\/global-header-(?:desktop|approved-source)\.png)/;
const RETIRED_ASSETS = [
  'images/btn-hamburger-v4.png',
  'images/btn-hamburger.png',
  'images/btn-hamburger.webp',
  'images/global-header/menu.png',
  'images/global-header/global-header-approved-source.png',
  'images/global-header/global-header-desktop.png',
] as const;

function productionTextFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

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

function containsRetiredThreeRectGeometry(source: string): boolean {
  const signatures = [
    [
      /x(?:=|:)\s*["']?3["']?/,
      /y(?:=|:)\s*["']?4["']?/,
      /width(?:=|:)\s*["']?18["']?/,
      /height(?:=|:)\s*["']?2\.5["']?/,
    ],
    [
      /x(?:=|:)\s*["']?3["']?/,
      /y(?:=|:)\s*["']?10\.75["']?/,
      /width(?:=|:)\s*["']?18["']?/,
      /height(?:=|:)\s*["']?2\.5["']?/,
    ],
    [
      /x(?:=|:)\s*["']?3["']?/,
      /y(?:=|:)\s*["']?17\.5["']?/,
      /width(?:=|:)\s*["']?18["']?/,
      /height(?:=|:)\s*["']?2\.5["']?/,
    ],
  ];

  return signatures.every((signature) => signature.every((pattern) => pattern.test(source)));
}

const sourceFiles = [
  ...productionTextFiles(join(ROOT, 'src')),
  join(ROOT, 'index.html'),
  join(ROOT, 'public/sw-bus.js'),
];
const builtFiles = productionTextFiles(join(ROOT, 'dist'));

describe('three-horizontal-line artwork can never return', () => {
  it('contains no three-bar glyph in production source or generated output', () => {
    const offenders = [...sourceFiles, ...builtFiles]
      .filter((file) => /[☰≡≣]/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('contains no retired SVG path or three-rectangle geometry', () => {
    const offenders = [...sourceFiles, ...builtFiles]
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return THREE_BAR_SVG_PATH.test(source) || containsRetiredThreeRectGeometry(source);
      })
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('contains no retired asset or runtime reference outside cache tombstones', () => {
    const removedSourceAssets = RETIRED_ASSETS.map((path) => join(ROOT, 'public', path));
    const removedBuiltAssets = RETIRED_ASSETS.map((path) => join(ROOT, 'dist', path));
    expect([...removedSourceAssets, ...removedBuiltAssets].filter(existsSync)).toEqual([]);

    // sw-bus.js is the sole deliberate exception: its retired URL strings are
    // cache tombstones that delete already-installed copies.
    const offenders = [...sourceFiles, ...builtFiles]
      .filter((file) => !file.endsWith('sw-bus.js'))
      .filter((file) => FORBIDDEN_REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('locks the rebuilt header and six-tile command-grid implementation', () => {
    const header = readFileSync(
      join(ROOT, 'public/images/global-header/global-header-command-center-v1.png')
    );
    const commandGrid = readFileSync(
      join(ROOT, 'src/components/navigation/CommandGridIcon.tsx'),
      'utf8'
    );

    expect(createHash('sha256').update(header).digest('hex')).toBe(
      'bb62242b86cef3eb440e152390b09e966f5a4fc28487ddf2ed701a2c4adae3f9'
    );
    expect(commandGrid).toContain('data-command-grid="six-tile"');
    expect(commandGrid).toContain('[7, 19, 31]');
    expect(commandGrid).toContain('[8, 28]');
  });

  it('wires the six-tile grid to every navigation drawer trigger', () => {
    for (const path of [
      'src/components/navigation/GlobalHeader.tsx',
      'src/components/navigation/FloatingHamburger.tsx',
      'src/components/table/TableMenu.tsx',
      'src/components/Shell.tsx',
    ]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source).toContain('import { CommandGridIcon }');
      expect(source).toContain('<CommandGridIcon');
    }
  });

  it('keeps ClubButtons on a four-tile command-grid path', () => {
    const clubButtons = readFileSync(
      join(ROOT, 'src/components/club-buttons/ClubButtons.tsx'),
      'utf8'
    );
    expect(clubButtons).toContain('M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z');
  });

  it('purges every retired stable URL from persistent media caches', () => {
    const worker = readFileSync(join(ROOT, 'public/sw-bus.js'), 'utf8');
    for (const path of RETIRED_ASSETS) {
      expect(worker).toContain(`/hub/club-arena/${path}`);
    }
    expect(worker).toContain('purgeDecommissionedThreeBarArtwork()');
  });
});
