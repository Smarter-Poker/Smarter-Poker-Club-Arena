/**
 * HUB PICTURES LOAD IN THE APP (2026-09-29)
 *
 * Player pictures are stored as root-relative paths on the World Hub's origin
 * ('/avatars/table/...' for 1,243 players' table avatars, the /api/avatars
 * catalog's '/avatars/free/...'). Inside the app the origin is the bundle, so on
 * the Android emulator the Avatar Gallery showed twenty-five question marks and
 * the Complete Your Profile card a broken image. src/lib/native/hubPictureShim
 * loads any root-relative picture the bundle does not hold from smarter.poker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeBundleRoots } from '../../scripts/native/bundle-roots.mjs';
import { hubPictureSrcset, hubPictureUrl } from '../../src/lib/native/hubPictureShim';

const ROOT = resolve(__dirname, '../..');
const ROOTS = new Set(nativeBundleRoots(resolve(ROOT, 'public')));
const APP = 'https://localhost';
const HUB = 'https://smarter.poker';

describe('which pictures come from the World Hub', () => {
  it('the bundle is public/ plus what the build writes beside it', () => {
    for (const own of ['images', 'cards', 'default-avatar.png', 'index.html', 'assets']) {
      expect(ROOTS.has(own), own).toBe(true);
    }
    expect(ROOTS.has('avatars')).toBe(false);
    expect(ROOTS.has('hub')).toBe(false);
  });

  it.each([
    ['/avatars/free/rockstar.webp', `${HUB}/avatars/free/rockstar.webp`],
    ['/avatars/table/free_shark@2x.webp', `${HUB}/avatars/table/free_shark@2x.webp`],
    ['/hub/club-arena/club-logos/shark.png', `${HUB}/hub/club-arena/club-logos/shark.png`],
    ['/smarter-poker-logo.png', `${HUB}/smarter-poker-logo.png`],
    ['/avatars/vip/king.webp?v=2', `${HUB}/avatars/vip/king.webp?v=2`],
    [`${APP}/avatars/free/chef.webp`, `${HUB}/avatars/free/chef.webp`],
  ])('%s loads from the Hub', (input, expected) => {
    expect(hubPictureUrl(input, ROOTS, APP)).toBe(expected);
  });

  it.each([
    '/images/global-header/menu.png',
    '/default-avatar.png',
    '/cards/As.webp',
    '/assets/index-abc123.js',
    '/poker-chip-logo.webp',
    `${APP}/images/club-footer/club-arena-footer-v2.webp`,
    'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/avatars/a.png',
    `${HUB}/avatars/free/chef.webp`,
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    'blob:https://localhost/0b5c',
    '//cdn.example.com/x.png',
    'images/relative.png',
    '',
  ])('%s stays as it is', (input) => {
    expect(hubPictureUrl(input, ROOTS, APP)).toBe(input);
  });

  it('without the build’s list of what the bundle holds, it changes nothing', () => {
    expect(hubPictureUrl('/avatars/free/chef.webp', new Set(), APP)).toBe(
      '/avatars/free/chef.webp'
    );
  });

  it('rewrites each srcset candidate and leaves a data: srcset alone', () => {
    expect(hubPictureSrcset('/avatars/table/a.webp 1x, /images/b.png 2x', ROOTS, APP)).toBe(
      `${HUB}/avatars/table/a.webp 1x, /images/b.png 2x`
    );
    const data = 'data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x';
    expect(hubPictureSrcset(data, ROOTS, APP)).toBe(data);
  });
});

describe('the shim, installed', () => {
  beforeAll(async () => {
    vi.stubGlobal('__NATIVE_BUNDLE_ROOTS__', [...ROOTS]);
    vi.resetModules();
    const shim = await import('../../src/lib/native/hubPictureShim');
    shim.installHubPictureShim();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('catches what React renders (setAttribute)', () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/avatars/free/chef.webp');
    expect(img.getAttribute('src')).toBe(`${HUB}/avatars/free/chef.webp`);
  });

  it('catches what code assigns (img.src = ...)', () => {
    const img = document.createElement('img');
    img.src = '/avatars/table/vip_king@2x.webp';
    expect(img.getAttribute('src')).toBe(`${HUB}/avatars/table/vip_king@2x.webp`);
  });

  it('leaves the bundle’s own pictures and every other element alone', () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/images/icons/sit-button.png');
    expect(img.getAttribute('src')).toBe('/images/icons/sit-button.png');
    const link = document.createElement('a');
    link.setAttribute('href', '/avatars/free/chef.webp');
    expect(link.getAttribute('href')).toBe('/avatars/free/chef.webp');
  });

  it('catches <source srcset>', () => {
    const source = document.createElement('source');
    source.setAttribute('srcset', '/avatars/table/a.webp 1x');
    expect(source.getAttribute('srcset')).toBe(`${HUB}/avatars/table/a.webp 1x`);
  });
});

describe('wiring', () => {
  it('the native boot installs it before React renders, and only the native build', () => {
    const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
    const install = main.indexOf('installHubPictureShim()');
    expect(install).toBeGreaterThan(-1);
    expect(main.lastIndexOf('if (IS_NATIVE_BUILD) {', install)).toBeGreaterThan(-1);
    expect(install - main.lastIndexOf('if (IS_NATIVE_BUILD) {', install)).toBeLessThan(600);
    expect(install).toBeLessThan(main.indexOf('bootReactTree();', install));
  });

  it('the native build hands the shim its list; the web build defines nothing new', async () => {
    const previous = process.env.VITE_NATIVE;
    try {
      process.env.VITE_NATIVE = '1';
      vi.resetModules();
      const native = (await import('../../vite.config')).default as {
        define: Record<string, string>;
      };
      expect(JSON.parse(native.define.__NATIVE_BUNDLE_ROOTS__)).toEqual([...ROOTS].sort());
      delete process.env.VITE_NATIVE;
      vi.resetModules();
      const web = (await import('../../vite.config')).default as { define: Record<string, string> };
      expect(web.define).not.toHaveProperty('__NATIVE_BUNDLE_ROOTS__');
    } finally {
      if (previous === undefined) delete process.env.VITE_NATIVE;
      else process.env.VITE_NATIVE = previous;
    }
  });
});
