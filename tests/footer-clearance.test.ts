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
    expect(app).toContain('shouldShowClubFooter(location.pathname)');
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
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?width:\s*102\.68%/);
    expect(css).toMatch(/\.artworkImage\s*\{[\s\S]*?transform:\s*translateX\(-50%\)/);
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
});
