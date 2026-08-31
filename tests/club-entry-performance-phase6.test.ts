import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('Phase 6 Club Entry visual and performance contracts', () => {
  it('ships the approved action artwork with semantic feature states and shortcuts', () => {
    const actionBar = read('src/components/home/ClubEntryActionBar.tsx');
    expect(actionBar).toContain('ClubEntryFlags');
    expect(actionBar).toContain('disabled={!flags.create_club}');
    expect(actionBar).toContain('disabled={!flags.find_player}');
    expect(actionBar).toContain('disabled={!flags.join_club}');
    expect(actionBar).toContain('aria-keyshortcuts="C"');
    expect(actionBar).toContain('aria-keyshortcuts="F"');
    expect(actionBar).toContain('aria-keyshortcuts="J"');
    const approved = resolve(
      root,
      'public/images/club-arena/approved-club-entry-action-pill-v1.webp'
    );
    expect(existsSync(approved)).toBe(true);
    expect(statSync(approved).size).toBeLessThanOrEqual(768 * 1024);
    expect(read('scripts/optimize-dist-media.mjs')).toContain(
      "{ prefix: 'images/club-arena/approved-club-entry-action-pill-v1.webp', maxDim: 0 }"
    );
  });

  it('honors reduced motion and increased contrast across the entry surfaces', () => {
    const homeCss = read('src/pages/HomePage.module.css');
    expect(homeCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(homeCss).toContain('@media (prefers-contrast: more)');
    for (const modal of ['CreateClubModal', 'FindPlayerModal', 'JoinClubModal']) {
      const css = read(`src/components/modals/${modal}.module.css`);
      expect(css).toContain('@media (prefers-reduced-motion: reduce)');
      expect(css).toContain('@media (prefers-contrast: more)');
    }
  });

  it('keeps the approved global Smarter.Poker identity raster lossless and unobstructed', () => {
    const header = read('src/components/navigation/GlobalHeader.tsx');
    expect(header).toContain('global-header-desktop.png');
    expect(header).not.toContain('srcSet=');
    expect(header).not.toContain('vault-iris-emblem-v1');
    const approved = resolve(root, 'public/images/global-header/global-header-desktop.png');
    expect(existsSync(approved)).toBe(true);
    expect(statSync(approved).size).toBeLessThanOrEqual(400 * 1024);
    expect(read('scripts/optimize-dist-media.mjs')).toContain(
      "{ prefix: 'images/global-header/', maxDim: 0 }"
    );
  });

  it('keeps production chunk budgets executable in the release gate', () => {
    expect(read('package.json')).toContain('check:club-entry-budgets');
    expect(read('scripts/check-club-entry-budgets.mjs')).toContain('gzipSync');
  });

  it('keeps the lobby route lazy instead of charging every deep link for it', () => {
    const optimizer = read('scripts/optimize-dist-media.mjs');
    expect(optimizer).not.toContain('injectLobbyPreload');
    expect(optimizer).not.toContain('modulepreloads ${chunk}');
  });
});
