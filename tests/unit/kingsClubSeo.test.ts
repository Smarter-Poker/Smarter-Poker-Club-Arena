import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySeo,
  DEFAULT_OG_IMAGE,
  KINGS_CLUB_IMAGE,
  PUBLIC_PATHS,
  resolveSeo,
} from '../../src/lib/seo';
import { renderSharePreview, SHARE_PREVIEW_PATHS } from '../../src/prerender/entry-server';
import { composeDocument, verifySharePreview } from '../../scripts/prerender-public-routes.mjs';

const meta = (key: string) =>
  document.head
    .querySelector(`meta[property="${key}"],meta[name="${key}"]`)
    ?.getAttribute('content');
const shell =
  '<html><head><title>Poker Arena</title><link rel="canonical" href="https://smarter.poker/hub/club-arena" /><script id="route-jsonld" type="application/ld+json">{"name":"SHARK CLUB"}</script></head><body><div id="root"></div></body></html>';

describe('Kings Club sharing metadata', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it.each(['kings-club', 'shark-club', '25450', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'])(
    'keeps current and legacy %s metadata on the same public brand',
    (identifier) => {
      for (const section of ['clubs', 'invite']) {
        const entry = resolveSeo(`/${section}/${identifier}`);
        expect(entry.title).toContain('KINGS CLUB');
        expect(entry.image).toBe(KINGS_CLUB_IMAGE);
        expect(entry.canonicalPath).toBe(`/${section}/kings-club`);
        expect(entry.index).toBe(false);
        expect(JSON.stringify(entry.jsonLd)).not.toMatch(/SHARK CLUB|shark-club/);
      }
    }
  );

  it('writes one complete head and replaces a stale initial structured-data script', () => {
    document.head.innerHTML =
      '<script id="route-jsonld" type="application/ld+json">{"name":"SHARK CLUB"}</script>';
    applySeo(resolveSeo('/clubs/shark-club'));
    applySeo(resolveSeo('/clubs/kings-club'));
    expect(document.title).toBe('KINGS CLUB | Smarter.Poker');
    for (const key of ['og:title', 'twitter:title']) expect(meta(key)).toContain('KINGS CLUB');
    for (const key of ['og:image', 'og:image:secure_url', 'twitter:image'])
      expect(meta(key)).toBe(KINGS_CLUB_IMAGE);
    expect(meta('og:image:width')).toBe('1254');
    expect(meta('og:image:height')).toBe('1254');
    expect(meta('twitter:card')).toBe('summary');
    expect(meta('robots')).toBe('noindex, nofollow');
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
    const graph = JSON.parse(document.getElementById('route-jsonld')!.textContent!)['@graph'];
    expect(graph[0].name).toBe('KINGS CLUB');
    expect(graph[0].logo.url).toBe(KINGS_CLUB_IMAGE);
    expect(document.head.innerHTML).not.toMatch(/SHARK CLUB|shark-club/);
  });

  it('keeps private nested pages private and clears Kings previews when leaving the club', () => {
    const nested = resolveSeo('/clubs/kings-club/cashier');
    expect(nested.index).toBe(false);
    expect(nested.jsonLd).toBeUndefined();
    applySeo(nested);
    expect(meta('og:image')).toBe(KINGS_CLUB_IMAGE);
    applySeo(resolveSeo('/clubs/another-club'));
    expect(meta('og:image')).toBe(DEFAULT_OG_IMAGE);
    expect(meta('og:title')).not.toContain('KINGS CLUB');
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('recognizes only exact club query contexts without relabeling public or unrelated pages', () => {
    for (const key of ['club', 'clubId', 'club_id']) {
      expect(resolveSeo('/stats', `?${key}=shark-club`).image).toBe(KINGS_CLUB_IMAGE);
      expect(resolveSeo('/marketplace', `?${key}=25450`).image).toBe(KINGS_CLUB_IMAGE);
    }
    expect(resolveSeo('/help', '?club=kings-club').brandedShare).toBeUndefined();
    expect(resolveSeo('/stats', '?club=another-club').brandedShare).toBeUndefined();
    expect(resolveSeo('/clubs/kings-club-impostor').brandedShare).toBeUndefined();
  });

  it.each(SHARE_PREVIEW_PATHS)(
    'serves %s without JavaScript, without exposing app data or changing the sitemap',
    (route) => {
      const page = renderSharePreview(route);
      const doc = composeDocument({ shell, page, css: '' });
      expect(() => verifySharePreview(route, doc)).not.toThrow();
      expect(doc).toContain('<noscript>');
      expect(doc).toContain('KINGS CLUB Logo');
      expect(doc).toContain(`content="${KINGS_CLUB_IMAGE}"`);
      expect(doc).not.toMatch(/SHARK CLUB|shark-club|wallet|member_count|chip_balance/);
      expect(PUBLIC_PATHS).not.toContain(route);
      expect(() => verifySharePreview(route, doc.replaceAll('KINGS CLUB', 'SHARK CLUB'))).toThrow();
      expect(() =>
        verifySharePreview(
          route,
          doc.replace(
            'property="og:image" content="https://smarter.poker/hub/club-arena/images/kings-club-logo.png"',
            'property="og:image" content="https://smarter.poker/images/og-poker-arena.jpg"'
          )
        )
      ).toThrow();
    }
  );
});
