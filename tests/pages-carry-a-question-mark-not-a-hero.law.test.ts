/**
 * PAGES CARRY A QUESTION MARK, NOT A HERO (Dan, 2026-10-17, BINDING)
 *
 * Dan, verbatim: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL DESCRIPTIONS
 * THAT EXIST LIKE THIS ON ANY AND ALL PAGES. ADD A ? MARK ICON INSTEAD IN THE
 * UPPER RIGHT CORNER OF THE PAGES THAT CAN EXPLAIN ANYTHING AND ALSO LAUNCH A
 * TUTORIAL AT THE BOTTOM WHEN CLICKED. ALL THESE WORDS ARE DISTRACTING AND
 * MAKES IT HARDER TO USE THE SITE, WE NEED TO SIMPLY PAGES."
 *
 * He was looking at the Notifications hero: an eyebrow ("SIGNAL INBOX // LIVE
 * PLAYER NETWORK"), a giant title, a paragraph about the page, decorative
 * figure tiles and hero artwork. Every page header of that shape now prints
 * the page bar (src/components/help/PageBar.tsx): the live state and the
 * page's own controls, the title for assistive technology only, and the
 * painted "?" whose panel at the bottom of the screen explains the page and
 * walks its tutorial.
 *
 * What this pins, so the hero cannot quietly come back:
 *  1. The page bar's title is visually hidden, and it holds the "?".
 *  2. The "?" is the approved painted art, not a glyph or a CSS circle.
 *  3. None of the page-header components accepts an eyebrow, and each one
 *     renders the page bar.
 *  4. The words a header used to print reach the help, not the page.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Every component that used to print a page hero, and now prints the bar. */
const PAGE_HEADERS = [
  'src/components/account/AccountSurfaceHeader.tsx',
  'src/components/community/CommunitySurfaceHeader.tsx',
  'src/components/club/ClubIntegrityHeader.tsx',
  'src/components/rewards/RewardsSurfaceHeader.tsx',
  'src/components/wallet/CashierWorkspace.tsx',
  'src/components/legal/LegalDocumentLayout.tsx',
  'src/pages/workspaces/ArenaWorkspacePages.tsx',
  'src/prerender/LegalPrerender.tsx',
];

describe('pages carry a question mark, not a hero (Dan 2026-10-17)', () => {
  const bar = read('src/components/help/PageBar.tsx');
  const help = read('src/components/help/PageHelp.tsx');

  it('renders the page title and puts the "?" in the bar', () => {
    expect(bar).toMatch(/<Heading className="ca-page-bar__title"/);
    expect(bar).toContain('<PageHelp title={title} summary={summary} steps={steps} />');
    expect(bar).not.toMatch(/\beyebrow\??:/);
  });

  it('paints the approved help art, never a glyph', () => {
    expect(help).toContain("mediaUrl('images/header-help-v4.png')");
    expect(help).toContain('aria-label="Page Help"');
    expect(help).not.toMatch(/>\s*\?\s*</);
  });

  it('explains the page first and then launches the tutorial from the bottom', () => {
    expect(help).toContain("'About This Page'");
    expect(help).toContain("'Start Tutorial'");
    expect(read('src/components/help/PageHelp.css')).toMatch(
      /\.ca-tutorial-popup\s*\{[^}]*position:\s*fixed;[^}]*bottom:/s
    );
  });

  it.each(PAGE_HEADERS)('%s prints the page bar and takes no eyebrow', (path) => {
    const source = read(path);
    expect(source).toMatch(/import PageBar from '[./]+(?:components\/)?help\/PageBar';/);
    expect(source).toContain('<PageBar');
    expect(source).not.toMatch(/\beyebrow\??:\s*string/);
    expect(source).not.toMatch(/\{eyebrow\}/);
  });

  it('sends the words a header used to print to the help, not the page', () => {
    for (const path of PAGE_HEADERS) {
      const source = read(path);
      // A description/summary prop is accepted, and handed to the bar.
      if (/\bdescription[?]?:\s*string/.test(source)) {
        expect(source, path).toMatch(/summary=\{(?:formatPopupText\()?description\)?\}/);
      }
      expect(source, path).not.toMatch(/<p[^>]*>\s*\{(?:formatPopupText\()?description\)?\}/);
    }
  });
});
