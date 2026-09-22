/**
 * THE ARENA SITEMAP LISTS EXACTLY WHAT IT PRERENDERS, WITH EVIDENCE DATES.
 *
 * Discoverability phase 2 (2026-09-17). The World Hub used to carry a
 * hand-typed list of Club Arena URLs; nothing checked it against this repo.
 * scripts/generate-arena-sitemap.mjs now writes dist/sitemap.xml from the
 * prerender manifest, so the sitemap can only ever name a page that a
 * crawler without JavaScript can read, and its lastmod is the newest commit
 * touching that page's source, not the build date.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSitemap, lastModFor, urlFor } from '../scripts/generate-arena-sitemap.mjs';
import { PRERENDER_EXCEPTIONS } from '../src/prerender/entry-server';
import { PUBLIC_PATHS } from '../src/lib/seo';

const ROOT = join(__dirname, '..');
const PRERENDERED = PUBLIC_PATHS.filter((p) => !(p in PRERENDER_EXCEPTIONS));

describe('the arena sitemap', () => {
  it('builds one <url> per prerendered public route, under the arena base, with no trailing slash on the root', () => {
    const xml = buildSitemap(PRERENDERED);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect((xml.match(/<url>/g) || []).length).toBe(PRERENDERED.length);
    expect(xml).toContain('<loc>https://smarter.poker/hub/club-arena</loc>');
    expect(xml).toContain('<loc>https://smarter.poker/hub/club-arena/help</loc>');
    expect(xml).not.toContain('<loc>https://smarter.poker/hub/club-arena/</loc>');
    // The Legal Center is prerendered since 2026-09-22 (it was the one
    // exception, and Google filed it as an alternate of the arena root).
    expect(xml).toContain('<loc>https://smarter.poker/hub/club-arena/legal</loc>');
    expect(urlFor('/legal/tos')).toBe('https://smarter.poker/hub/club-arena/legal/tos');
  });

  it('dates every entry from git history, never the build clock, when history is present', () => {
    for (const route of PRERENDERED) {
      const { date, evidence } = lastModFor(route);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(evidence).toBe('git');
    }
  });

  it('is wired into build:ci after the prerender and before provenance', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const ci: string = pkg.scripts['build:ci'];
    const a = ci.indexOf('prerender-public-routes.mjs');
    const b = ci.indexOf('generate-arena-sitemap.mjs');
    const c = ci.indexOf('stamp-build-provenance.mjs');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
