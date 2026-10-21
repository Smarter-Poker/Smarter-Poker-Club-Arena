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
  headingCount,
  inspectHead,
  markupOnly,
  ldTypes,
  parseSitemapLocs,
  acceptServedBuild,
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

  it.each([
    '<script id="route-jsonld" type="application/ld+json">',
    '<script type="application/ld+json" nonce="fixture">',
    "<script id='route-jsonld' TYPE = 'application/ld+json'>",
  ])('reads structured data with valid script attributes: %s', (opening) => {
    const html = HEAD.replace('<script type="application/ld+json">', opening);
    expect(ldTypes(inspectHead(html).ld)).toEqual(['BreadcrumbList', 'FAQPage']);
    expect(inspectHead(html.replace('{"@context"', '{"@context')).ldError).toBeTruthy();
  });

  it('does not accept a missing JSON-LD type or a data-type attribute', () => {
    for (const opening of [
      '<script type="application/json">',
      '<script data-type="application/ld+json">',
    ]) {
      const head = inspectHead(HEAD.replace('<script type="application/ld+json">', opening));
      expect(head.ld).toBeNull();
      expect(head.ldError).toBeNull();
    }
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

describe('a quoted heading is not a heading (2026-09-18)', () => {
  // index.html's last-resort boot UI is assigned as a string:
  //   root.innerHTML = '<h1 ...>Loading Failed</h1>...'
  // A raw regex counts three <h1> on every arena page when there is one,
  // so this gate would have accepted a page whose only heading was quoted
  // JavaScript. Same defect #4790 fixed for the prerender verifier.
  const scriptOnly = `<script>root.innerHTML = '<h1 style="x">Loading Failed</h1>';</script>`;

  it('counts real elements and ignores scripts, styles and comments', () => {
    expect(headingCount(scriptOnly)).toBe(0);
    expect(headingCount('<h1>Real</h1>')).toBe(1);
    expect(headingCount(`<h1>Real</h1>${scriptOnly}`)).toBe(1);
    expect(headingCount('<style>h1{color:red}</style>')).toBe(0);
    expect(headingCount('<!-- <h1>commented</h1> -->')).toBe(0);
    expect(headingCount('')).toBe(0);
    expect(markupOnly(scriptOnly)).not.toContain('Loading Failed');
  });

  it('inspectHead reports no heading when the only one is inside a script', () => {
    expect(inspectHead(scriptOnly).h1).toBe(false);
    expect(inspectHead('<h1>Help Center</h1>').h1).toBe(true);
  });
});

describe('a later protected-main release is not a broken contract (2026-10-19)', () => {
  // Runs 39307277919 and 39313288388 waited three minutes for a6af2a2425 while
  // production already served its descendant fd6a602c2e, and went red without
  // reading a page.
  const expected = 'a'.repeat(40);
  const later = 'b'.repeat(40);

  it('accepts the expected release, and anything when no release is named', () => {
    expect(acceptServedBuild(expected, expected, () => false)).toBe(expected);
    expect(acceptServedBuild('', later, () => false)).toBe(later);
  });

  it('checks a proven forward protected-main release instead of waiting for a replaced one', () => {
    const seen: string[][] = [];
    expect(
      acceptServedBuild(expected, later, (a, b) => {
        seen.push([a, b]);
        return true;
      })
    ).toBe(later);
    expect(seen).toEqual([[expected, later]]);
  });

  it('keeps waiting on a rollback, an off-lineage commit or an unreadable SHA', () => {
    expect(acceptServedBuild(expected, later, () => false)).toBeNull();
    expect(acceptServedBuild(expected, 'not-a-sha', () => true)).toBeNull();
    expect(acceptServedBuild(expected, undefined, () => true)).toBeNull();
  });

  it('gives the checker the commit graph it needs to prove lineage', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/post-deploy-e2e.yml'), 'utf8');
    const job = wf.indexOf('  seo-contract:');
    const body = wf.slice(job, wf.indexOf('  production-e2e:', job));
    expect(body).toContain('fetch-depth: 0');
    expect(body).toContain('filter: blob:none');
    const src = readFileSync(join(ROOT, 'scripts/ci/check-live-seo-contract.mjs'), 'utf8');
    expect(src).toContain("'merge-base', '--is-ancestor', expected, served");
    expect(src).toContain("'merge-base', '--is-ancestor', served, 'refs/remotes/origin/main'");
  });
});
