/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: AN ARENA PAGE SAYS IT IS THE ARENA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO phase 3, 2026-09-18. Poker Arena is proxied in under
 * smarter.poker/hub/club-arena and publishes its own sitemap, which
 * robots.txt declares alongside the World Hub's. Two sitemaps, one domain.
 *
 * Five of its six public titles were the bare document name, so with
 * " | Smarter.Poker" appended they read exactly like the World Hub's own
 * pages. Measured live on 2026-09-18:
 *
 *   /hub/club-arena/legal/tos      "Terms Of Service | Smarter.Poker"
 *   /terms                         "Terms Of Service | Smarter.Poker"
 *
 * Identical titles, both indexed, one domain, two different contracts. The
 * privacy pages were the same pair, and the Help Center sat one word away
 * from the World Hub's /hub/help.
 *
 * An engine reading both has no way to tell which document it wants, and
 * the two pages compete for the same result. So every public Arena page
 * names the product whose document it is. The descriptions already did;
 * only the titles did not.
 *
 * This law also pins the budget, because a prefix costs characters: a title
 * a result cuts is the defect this estate has now made five times.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** SEOHead appends this unless the title already carries it. */
const BRAND_SUFFIX = ' | Smarter.Poker';
/** Where a result cuts. Not where a title tag stops being valid. */
const TITLE_BUDGET = 60;

/** "&" is serialised as "&amp;" and costs four more than it shows. */
const renderedLength = (text: string) => text.length + 4 * (text.split('&').length - 1);

function publicTitles(): Array<{ route: string; title: string }> {
  const src = read('src/lib/seo.ts');
  const block = src.slice(src.indexOf('const PUBLIC_ROUTES'), src.indexOf('const PRIVATE_DEFAULT'));
  const out: Array<{ route: string; title: string }> = [];
  const re = /'(\/[^']*)':\s*\{\s*\n\s*title:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push({ route: m[1], title: m[2] });
  return out;
}

describe('an arena page says it is the arena', () => {
  it('finds every public route', () => {
    const titles = publicTitles();
    expect(titles.length).toBeGreaterThanOrEqual(6);
    expect(titles.map((t) => t.route)).toContain('/legal/tos');
  });

  it('every public title names Poker Arena', () => {
    const anonymous = publicTitles().filter((t) => !/Poker Arena/i.test(t.title));
    expect(
      anonymous,
      'A title that is only the document name collides with the World Hub page ' +
        'of the same name, on the same domain. Name the product.'
    ).toEqual([]);
  });

  it('no public title is cut short in a result', () => {
    const over = publicTitles()
      .map((t) => ({
        ...t,
        shipped: t.title.includes('Smarter.Poker') ? t.title : t.title + BRAND_SUFFIX,
      }))
      .filter((t) => renderedLength(t.shipped) > TITLE_BUDGET)
      .map((t) => `${renderedLength(t.shipped)}  ${t.shipped}`);
    expect(over, `a result cuts at ${TITLE_BUDGET} characters, brand suffix counted`).toEqual([]);
  });

  it('the titles the World Hub owns are not reused here', () => {
    // These are the World Hub's own pages. Two documents cannot share one
    // title on one domain and expect an engine to pick the right one.
    const taken = ['Terms Of Service', 'Privacy Policy', 'Help Center', 'Legal Center'];
    const clashes = publicTitles().filter((t) => taken.includes(t.title));
    expect(clashes, 'this title is the World Hub page of the same name').toEqual([]);
  });

  it('the client sets the same Help Center title the head does', () => {
    const helpTitle = publicTitles().find((t) => t.route === '/help')?.title;
    expect(helpTitle).toBeTruthy();
    expect(read('src/pages/HelpPage.tsx')).toContain(
      `document.title = '${helpTitle} | Smarter.Poker'`
    );
  });
});
