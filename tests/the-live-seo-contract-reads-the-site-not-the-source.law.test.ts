/**
 * THE LIVE SEO CONTRACT IS CHECKED AGAINST PRODUCTION, WITH NO ROUTE LIST.
 *
 * Discoverability phase 3 (2026-09-17). Every other SEO guarantee here reads
 * source files; this one reads the deployed site after each publish, from
 * post-deploy-e2e.yml, and derives what to check from the bundle's own
 * prerender manifest and sitemap. These pin the parsers it relies on and
 * that the job is wired in independently of the engine certificate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bodyWords,
  inspectHead,
  ldTypes,
  parseSitemapLocs,
} from '../scripts/ci/check-live-seo-contract.mjs';

const ROOT = join(__dirname, '..');

const HEAD = `<html><head><title>Help Center | Smarter.Poker</title>
<meta name="description" content="Answers To The Most Common Poker Arena Questions: Accounts, Joining And Running Clubs, Cash Games And Tournaments." />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="https://smarter.poker/hub/club-arena/help" />
<meta property="og:image" content="https://smarter.poker/images/og-poker-arena.jpg" />
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"FAQPage"}]}</script>
</head><body><style>.x{}</style><script>var a=1</script><!-- c --><div id="root"><h1>Help Center</h1><p>${'word '.repeat(150)}</p></div></body></html>`;

describe('the live SEO contract checker', () => {
  it('reads title, robots, canonical, description and a @graph from a prerendered page', () => {
    const head = inspectHead(HEAD);
    expect(head.title).toBe('Help Center | Smarter.Poker');
    expect(head.robots).toMatch(/^index, follow/);
    expect(head.canonical).toBe('https://smarter.poker/hub/club-arena/help');
    expect(head.description!.length).toBeGreaterThan(60);
    expect(head.h1).toBe(true);
    expect(ldTypes(head.ld)).toEqual(['BreadcrumbList', 'FAQPage']);
    expect(head.ogImage).toBe('https://smarter.poker/images/og-poker-arena.jpg');
  });

  it('proves the share card the landing names is a real image on the live site (phase 6)', () => {
    const src = readFileSync(join(ROOT, 'scripts/ci/check-live-seo-contract.mjs'), 'utf8');
    expect(src).toContain('async function checkShareImage(head)');
    expect(src).toContain("if (entry.route === '/') await checkShareImage(head);");
    expect(src).toContain('expected 200 image/*');
  });

  it('reports a JSON-LD block that does not parse instead of ignoring it', () => {
    const head = inspectHead(HEAD.replace('{"@context"', '{"@context'));
    expect(head.ld).toBeNull();
    expect(head.ldError).toBeTruthy();
  });

  it('counts words a reader gets without JavaScript, not scripts, styles or comments', () => {
    expect(bodyWords(HEAD)).toBe(152);
    expect(bodyWords('<html><body><script>x</script></body></html>')).toBe(0);
  });

  it('lists every <loc> in a sitemap', () => {
    expect(
      parseSitemapLocs(
        '<urlset><url><loc>https://a/</loc></url><url><loc> https://b/x </loc></url></urlset>'
      )
    ).toEqual(['https://a/', 'https://b/x']);
  });

  it('is wired into post-deploy-e2e.yml as its own job, gated on the publication verdict, not on the engine', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
    const job = wf.indexOf('  seo-contract:');
    expect(job).toBeGreaterThan(-1);
    const body = wf.slice(job, wf.indexOf('  production-e2e:', job));
    expect(body).toContain('needs: publication-gate');
    expect(body).toContain("needs.publication-gate.outputs.should_run == 'true'");
    expect(body).toContain(
      'node scripts/ci/check-live-seo-contract.mjs --sha "${{ needs.publication-gate.outputs.client_target_sha }}"'
    );
    expect(body).toContain('ref: ${{ needs.publication-gate.outputs.client_target_sha }}');
    expect(body).not.toContain('github.event.workflow_run.head_sha');
    expect(body).not.toContain('engine.smarter.poker');
  });
});
