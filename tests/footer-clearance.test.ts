import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('global Club Arena footer mounting and clearance', () => {
  it('mounts ClubBottomNav once at the app root and nowhere in individual pages', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    const pageMounts = walk(join(ROOT, 'src/pages')).filter(
      (file) => file.endsWith('.tsx') && readFileSync(file, 'utf8').includes('<ClubBottomNav')
    );

    expect(app.match(/<ClubBottomNav/g)).toHaveLength(1);
    // Route OR in-tab lobby (tests/the-lobby-always-has-its-footer.law.test.ts).
    expect(app).toContain('shouldShowClubFooterFor(location.pathname, inTabLobbyActive)');
    expect(pageMounts).toEqual([]);
  });

  it('has no second generic fixed-bottom application footer implementation', () => {
    const navigationFiles = walk(join(ROOT, 'src/components/navigation'));
    const obsoleteTabBar = navigationFiles.filter((file) => /\/TabBar\.(tsx|css)$/.test(file));
    const sourceFiles = walk(join(ROOT, 'src')).filter((file) => /\.(tsx|ts)$/.test(file));
    const duplicateMounts = sourceFiles.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /<(?:ArenaFooter|ClubArenaFooter|BottomNav|BottomNavigation|MobileFooter|DesktopFooter|GlobalFooter)\b/.test(
        source
      );
    });

    expect(obsoleteTabBar).toEqual([]);
    expect(duplicateMounts).toEqual([]);
  });

  it('shares the lossless artwork ratio, touch-safe minimum, and safe-area clearance', () => {
    for (const sheet of [
      'src/styles/club-engine.css',
      'src/styles/globals.css',
      'src/styles/design-system.css',
    ]) {
      const css = readFileSync(join(ROOT, sheet), 'utf8');
      expect(css).toContain('--bottom-nav-height: clamp(44px, 13.72vw, 132px)');
      expect(css).toContain(
        '--bottom-nav-clearance: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom, 0px))'
      );
    }
  });

  it('always scales the complete artwork to the viewport without horizontal scrolling', () => {
    const css = readFileSync(join(ROOT, 'src/components/club/ClubBottomNav.module.css'), 'utf8');

    expect(css).toMatch(/\.viewport\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.artwork\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.artwork\s*\{[\s\S]*?height:\s*var\(--bottom-nav-height/);
    // The measured frame (x=25 y=14 1866x230 of a 1916x256 canvas) is scaled
    // until it covers the footer box on BOTH axes, pushing the canvas's black
    // gutter off every edge. The horizontal pair has always been here as
    // `width: 102.68%` + `translateX(-50%)`; the vertical pair replaced
    // `height: 100%` on 2026-09-04, which was leaving the gutter's 14 top rows
    // inside the box as a black band above the frame (Dan: "YOU NEED TO CLIP
    // THE BACKGROUND AROUND THE EDGES OF THE FOOTER FRAME").
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?width:\s*102\.6795%/);
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?left:\s*-1\.3398%/);
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?height:\s*111\.3043%/);
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?top:\s*-6\.087%/);
    // A global `img { max-width: 100% }` reset would clamp that overscan and
    // letterbox the frame back inside the box. This is the immunisation.
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?max-width:\s*none/);
    expect(css).not.toContain('overflow-x: auto');
    expect(css).not.toContain('width: 640px');
    expect(css).not.toContain('min-width: 640px');
  });

  it('reserves footer clearance on routed pages but not the footerless root lobby', () => {
    const appLayout = readFileSync(
      join(ROOT, 'src/components/layouts/AppLayout.module.css'),
      'utf8'
    );
    const home = readFileSync(join(ROOT, 'src/pages/HomePage.module.css'), 'utf8');

    expect(appLayout).toMatch(/\.main\s*\{[\s\S]*?padding-bottom:[^;]*--bottom-nav-clearance/);
    expect(home).toMatch(/\.mainContent\s*\{[\s\S]*?padding:\s*0 16px 16px/);
    expect(home.match(/\.mainContent\s*\{[\s\S]*?\}/)?.[0]).not.toContain('--bottom-nav-clearance');
  });

  it('keeps the approved production artwork lossless after the dist optimizer', () => {
    const optimizer = readFileSync(join(ROOT, 'scripts/optimize-dist-media.mjs'), 'utf8');
    expect(optimizer).toContain("{ prefix: 'images/club-footer/', maxDim: 0 }");
  });

  /**
   * THE ARTWORK CARRIES ITS OWN TRANSPARENCY (Dan, 2026-09-04).
   *
   * The frame is a rounded rectangle drawn on a rectangular canvas. While that
   * canvas was opaque, the four corners outside the curve were solid black
   * squares sitting on the page, and no amount of CSS could clip them. Both
   * halves of the fix have to hold together: the asset must have an alpha
   * channel, and nothing behind it may paint a colour back in.
   */
  it('ships an alpha channel and paints nothing opaque behind it', () => {
    const art = readFileSync(join(ROOT, 'public/images/club-footer/club-arena-footer-v2.webp'));
    expect(art.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(art.subarray(8, 12).toString('ascii')).toBe('WEBP');
    // Lossless WebP: 'VP8L', a 0x2f signature byte, then 14 bits of width-1,
    // 14 of height-1, and one alpha_is_used bit.
    expect(art.subarray(12, 16).toString('ascii')).toBe('VP8L');
    expect(art[20]).toBe(0x2f);
    const header = art.readUInt32LE(21);
    expect((header & 0x3fff) + 1).toBe(1916);
    expect(((header >>> 14) & 0x3fff) + 1).toBe(256);
    expect((header >>> 28) & 1).toBe(1);

    const css = readFileSync(join(ROOT, 'src/components/club/ClubBottomNav.module.css'), 'utf8');
    expect(css).toMatch(/\.bottomNav\s*\{[\s\S]*?background:\s*transparent/);
    expect(css).toMatch(/\.artwork\s*\{[\s\S]*?background:\s*transparent/);
    expect(css).not.toContain('background: #000');
  });
});
