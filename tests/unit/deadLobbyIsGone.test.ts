/**
 * THE OLD LOBBY IS GONE, AND IT STAYS GONE.
 *
 * Dan, 2026-08-23: "any time there experiences a crash, and you click back, you
 * get brought to this page which i believe is a very old and rough club arena
 * lobby. this needs to be 100% removed and deleted and never allowed to be seen
 * or displayed again."
 *
 * `ClubCarouselPage` was a SECOND lobby living at /clubs, predating the real one
 * on `/`. It drew clubs as generic bank glyphs instead of their card art, had no
 * ACTIVE stat at all, and derived club level through a different code path - so
 * it could, and did, disagree with the real lobby about the same club. Nobody
 * navigated to it on purpose any more. It was reached by history: a crash, then
 * Back, landing on whatever the previous entry was, plus nine stale `/clubs`
 * links still scattered around the app.
 *
 * WHY A TEST AND NOT JUST A DELETION
 * Deleting a component is not the same as making a route unreachable. Had the
 * route been left pointing at nothing, /clubs would render blank - still a
 * broken page a crash could land you on. And a lazy import is easy to
 * reintroduce by autocomplete. So this pins all three halves of "gone":
 *
 *   1. the component and its stylesheet do not exist
 *   2. nothing imports them
 *   3. /clubs REDIRECTS rather than rendering, so every stale link, bookmark
 *      and Back-button landing ends up at the real lobby
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (p: string) => resolve(process.cwd(), p);
const APP = readFileSync(root('src/App.tsx'), 'utf8');

describe('the old /clubs lobby', () => {
  it('has no component file left on disk', () => {
    expect(existsSync(root('src/pages/ClubCarouselPage.tsx'))).toBe(false);
    expect(existsSync(root('src/pages/ClubCarouselPage.css'))).toBe(false);
  });

  it('is imported by nothing', () => {
    // A lazy() import of a deleted file fails at RUNTIME, on the route, in
    // front of a player - not at build time. So assert on the source.
    expect(APP).not.toMatch(/import\(['"].*ClubCarouselPage['"]\)/);
    const preloader = readFileSync(root('src/utils/ChunkPreloader.ts'), 'utf8');
    expect(preloader).not.toMatch(/ClubCarouselPage/);
  });

  it('redirects /clubs instead of rendering a page there', () => {
    /* The whole point. An unrouted /clubs would still be a blank page a crash
       could land on; a redirect cannot be seen at all. */
    const route = /<Route\s+path="clubs"\s+element=\{<Navigate\s+to="\/"\s+replace\s*\/>\}\s*\/>/;
    expect(APP).toMatch(route);
  });

  it('still imports Navigate, or the redirect above is a runtime crash', () => {
    expect(APP).toMatch(/import\s*\{[^}]*\bNavigate\b[^}]*\}\s*from\s*'react-router-dom'/);
  });

  it('leaves no route rendering the old component', () => {
    expect(APP).not.toMatch(/<ClubCarouselPage\s*\/>/);
  });
});
