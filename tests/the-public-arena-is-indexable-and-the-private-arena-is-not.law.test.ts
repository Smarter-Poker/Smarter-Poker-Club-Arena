/**
 * The arena root, help centre and legal documents are indexable with their
 * own canonical URL; every signed-in surface is noindex with no canonical.
 * Regressing either direction is what this pins.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySeo,
  canonicalUrl,
  fullTitle,
  normalisePath,
  PUBLIC_PATHS,
  resolveSeo,
  ROBOTS_INDEX,
  ROBOTS_NOINDEX,
} from '../src/lib/seo';

describe('resolveSeo', () => {
  it('indexes the public surfaces with their own canonical path', () => {
    for (const path of [
      '/',
      '/help',
      '/legal',
      '/legal/tos',
      '/legal/privacy',
      '/legal/fair-gaming',
      '/legal/promotions',
    ]) {
      const entry = resolveSeo(path);
      expect(entry.index, path).toBe(true);
      expect(entry.canonicalPath, path).toBe(path);
      expect(entry.description.length, path).toBeGreaterThan(60);
    }
  });

  it('tolerates a trailing slash', () => {
    expect(resolveSeo('/help/').canonicalPath).toBe('/help');
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('')).toBe('/');
  });

  it('marks every signed-in surface noindex', () => {
    for (const path of [
      '/cashier',
      '/wallet',
      '/settings',
      '/table/abc',
      '/clubs/123/dashboard',
      '/messages',
      '/profile/9',
      '/share/hand/x',
      '/replay',
    ]) {
      expect(resolveSeo(path).index, path).toBe(false);
    }
  });

  it('exposes the public paths for the sitemap', () => {
    expect(PUBLIC_PATHS).toContain('/');
    expect(PUBLIC_PATHS).toContain('/help');
    expect(PUBLIC_PATHS).not.toContain('/cashier');
  });
});

describe('canonicalUrl', () => {
  it('builds absolute arena URLs with no trailing slash', () => {
    expect(canonicalUrl('/')).toBe('https://smarter.poker/hub/club-arena');
    expect(canonicalUrl('')).toBe('https://smarter.poker/hub/club-arena');
    expect(canonicalUrl('/legal/tos')).toBe('https://smarter.poker/hub/club-arena/legal/tos');
    expect(canonicalUrl('help/')).toBe('https://smarter.poker/hub/club-arena/help');
  });

  it('appends the site name once', () => {
    expect(fullTitle('Help Center')).toBe('Help Center | Smarter.Poker');
    expect(fullTitle('Poker Arena | Smarter.Poker')).toBe('Poker Arena | Smarter.Poker');
  });
});

describe('applySeo', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = '';
  });

  it('writes title, description, canonical, robots and JSON-LD for a public route', () => {
    applySeo(resolveSeo('/help'));
    expect(document.title).toBe('Help Center | Smarter.Poker');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      ROBOTS_INDEX
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://smarter.poker/hub/club-arena/help'
    );
    const ld = document.getElementById('route-jsonld');
    expect(ld?.getAttribute('type')).toBe('application/ld+json');
    expect(JSON.parse(ld!.textContent!)['@graph'][0]['@type']).toBe('BreadcrumbList');
  });

  it('flips a private route to noindex, drops the canonical and leaves the title alone', () => {
    applySeo(resolveSeo('/'));
    document.title = 'Cashier | Smarter.Poker';
    applySeo(resolveSeo('/cashier'));
    expect(document.title).toBe('Cashier | Smarter.Poker');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      ROBOTS_NOINDEX
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.getElementById('route-jsonld')).toBeNull();
  });

  it('reuses the same tags instead of stacking duplicates', () => {
    applySeo(resolveSeo('/'));
    applySeo(resolveSeo('/legal/tos'));
    applySeo(resolveSeo('/'));
    expect(document.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
    expect(document.head.querySelectorAll('meta[name="description"]').length).toBe(1);
  });
});

describe('index.html', () => {
  it('does not tell Google to drop the whole arena', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      ''
    );
    expect(html).not.toMatch(/name="robots"\s+content="noindex/);
    expect(html).toMatch(
      /<link rel="canonical" href="https:\/\/smarter\.poker\/hub\/club-arena" \/>/
    );
    expect(html).toMatch(/application\/ld\+json/);
  });
});
