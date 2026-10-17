/**
 * DAILY CHALLENGES ENTRY PARITY (2026-09-22)
 *
 * Every door into /challenges keeps the club the player is standing in, the
 * tile intent warms the lazy route shell App.tsx actually mounts, the
 * completion toast is itself a door, the painted route shell paints the
 * accent of the page that replaces it, Go Back on a cold deep link has
 * somewhere to go, the lobby tile's live label prints inside the art's title
 * plate, and 200% text grows the title and wraps it inside its column. One
 * `it` per fix; the reasons are in
 * docs/changelog/2026-09-22-daily-challenges-entry-parity.md and
 * docs/changelog/2026-09-22-daily-challenges-certification-follow-up.md.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { preloadRoute, resolvePreloadRouteKey } from '../src/utils/ChunkPreloader';
import { withClubContext } from '../src/utils/clubScopedPath';

/* The preloader is exercised, not only read: the two lazy modules it warms are
   replaced by stubs that count their own loading, so firing the /challenges
   intent proves which chunks it actually requests. */
const warmed = vi.hoisted(() => ({ page: 0, shell: 0 }));
vi.mock('../src/pages/DailyChallengesPage', () => {
  warmed.page += 1;
  return { default: () => null };
});
vi.mock('../src/components/challenges/DailyChallengesRoute', () => {
  warmed.shell += 1;
  return { default: () => null };
});

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

/** The source between two markers, failing loudly when either has moved. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `marker not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `marker not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return source.slice(from, to);
}

const CLUB = 'deep-stack-society';

describe('every Daily Challenges entry keeps the club and the shell paints the page accent', () => {
  /* ClubDetailPage.tsx is retained but routed nowhere (it is on the
     unreachable list in tests/every-file-under-src-is-reachable.law.test.ts),
     so no player reaches this card today. It is kept correct so that routing
     the page again cannot bring back a door that drops the club. */
  it('the retained Club Detail card opens Daily Challenges inside its club', () => {
    const page = read('src/pages/ClubDetailPage.tsx');
    const card = between(page, '>Daily Challenges</h3>', 'View Challenges');

    expect(page).toContain("import { withClubContext } from '../utils/clubScopedPath';");
    // The route id the page's other club links (`/clubs/${clubId}/...`) use.
    expect(page).toContain('const { clubId } = useParams();');
    expect(card).toContain("onClick={() => navigate(withClubContext('/challenges', clubId))}");
    expect(page).not.toContain("navigate('/challenges')");
    // The card's copy prints in the schema's muted ink, not an off-schema grey.
    expect(card).toContain("color: '#9aa5b3'");
    expect(card).not.toContain('#8a9aaa');
  });

  it('the wallet Daily Challenges door keeps the club the wallet was opened in', () => {
    const wallet = read('src/pages/PlayerWalletPage.tsx');

    expect(wallet).toContain(
      "import { readClubContextParam, withClubContext } from '../utils/clubScopedPath';"
    );
    // The club the URL names, spelled as the URL spelled it, and nothing
    // else: the same rule as the Rewards rail on the same page. The store's
    // remembered club (a UUID) never reaches the address bar from here.
    expect(wallet).toContain('const linkClubId = readClubContextParam(location.search);');
    expect(wallet).not.toContain('readClubContextParam(location.search) ?? currentClubId');
    expect(wallet).toContain(
      "onClick={() => navigate(withClubContext('/challenges', linkClubId))}"
    );
    expect(wallet).not.toContain("navigate('/challenges')");
  });

  it('the /challenges intent warms the lazy route shell App.tsx mounts, and the page behind it', async () => {
    const preloader = read('src/utils/ChunkPreloader.ts');
    const entry = between(preloader, "'/challenges':", "'/settings':");

    expect(read('src/App.tsx')).toContain("import('./components/challenges/DailyChallengesRoute')");
    expect(entry).toContain("void import('../pages/DailyChallengesPage').catch(() => {});");
    expect(entry).toContain("return import('../components/challenges/DailyChallengesRoute');");
    expect(preloader).not.toContain("'/challenges': () => import('../pages/DailyChallengesPage')");

    // A stamped cycle link resolves to that entry, and firing it loads both.
    expect(resolvePreloadRouteKey(`/challenges/monthly?club=${CLUB}`)).toBe('/challenges');
    preloadRoute('/challenges');
    await vi.waitFor(() => {
      expect(warmed.shell).toBe(1);
      expect(warmed.page).toBe(1);
    });
  });

  it('every Rewards workspace card carries the club the same way the section rail beside it does', () => {
    const workspaces = read('src/pages/workspaces/ArenaWorkspacePages.tsx');
    const grid = between(workspaces, 'function WorkspacePage(', 'function useClubWorkspaceGroup(');

    // One club source for the rail and the grid, stamped the same way.
    const rail = read('src/components/navigation/ArenaSectionRail.tsx');
    expect(rail).toContain('const { routeClubId } = useClubWorkspace();');
    expect(rail).toContain('to={withClubContext(item.path, routeClubId)}');
    expect(grid).toContain('const { routeClubId } = useClubWorkspace();');
    expect(grid).toContain('to={withClubContext(item.path, routeClubId)}');
    expect(grid).not.toContain('to={item.path}');
    expect(workspaces).toContain(
      "{ label: 'Challenges', description: 'Daily Objectives And Progress', path: '/challenges' }"
    );

    // Stamping every card changes only the routes that are about a club.
    expect(withClubContext('/challenges', CLUB)).toBe(`/challenges?club=${CLUB}`);
    expect(withClubContext('/marketplace', CLUB)).toBe(`/marketplace?club=${CLUB}`);
    for (const path of [
      '/legal/tos',
      '/help',
      '/search',
      '/friends?tab=requests',
      '/unions',
      `/clubs/${CLUB}/cashier`,
    ]) {
      expect(withClubContext(path, CLUB)).toBe(path);
    }
    expect(withClubContext('/challenges', null)).toBe('/challenges');
  });

  it('the challenge completion toast is a door to Daily Challenges in the current club', () => {
    const listener = read('src/components/notifications/ChallengeToastListener.tsx');

    expect(listener).toContain("import { useLocation, useNavigate } from 'react-router-dom';");
    // The club a club page carries in its path, else the ?club= a
    // club-scoped global page carries.
    expect(listener).toContain(
      'clubIdFromPath(location.pathname) ?? readClubContextParam(location.search)'
    );
    // At a live table the toast only informs: it never navigates.
    expect(listener).toContain('const AT_LIVE_TABLE = /^\\/table(?:\\/|$)/;');
    expect(listener).toContain(
      'openDailyChallengesRef.current = AT_LIVE_TABLE.test(location.pathname)'
    );
    expect(listener).toMatch(
      /toastRef\.current\.success\(\s*`Challenge Complete: \$\{completion\.name\}\.\$\{rewardCopy\}`,\s*undefined,\s*openDailyChallenges\s*\)/
    );
    expect(listener).not.toContain(
      'toastRef.current.success(`Challenge Complete: ${completion.name}.${rewardCopy}`);'
    );

    // Router hooks need a router: App.tsx mounts the listener, and main.tsx
    // renders App inside BrowserRouter.
    expect(read('src/App.tsx')).toContain('<ChallengeToastListener />');
    expect(read('src/main.tsx')).toMatch(/<BrowserRouter[^>]*>\s*<App \/>\s*<\/BrowserRouter>/);
  });

  it('the route shell paints the live schema accent the page resolves, not hard-coded colours', () => {
    const css = read('src/components/challenges/DailyChallengesRouteFallback.module.css');

    expect(css).toContain('--cycle-color: var(--realism-cyan, #55e8ff);');
    expect(css).toContain('--cycle-glow: color-mix(in srgb, var(--cycle-color) 20%, transparent);');
    expect(css).toContain('--cycle-color: var(--realism-gold, #ffc93c);');
    expect(css).toContain('--cycle-glow: color-mix(in srgb, var(--cycle-color) 24%, transparent);');
    expect(css).not.toContain('--cycle-color: #55e8ff');
    expect(css).not.toContain('--cycle-color: #ffc93c');
    expect(css).not.toContain('rgba(85, 232, 255');
    expect(css).not.toContain('rgba(214, 173, 82');
    // Weekly stays in step with the page's own literal.
    expect(css).toContain('--cycle-color: #c8d5da;');

    // The tokens are live: declared on :root in the schema main.tsx loads.
    expect(read('src/main.tsx')).toContain("import './styles/club-engine.css';");
    const schema = read('src/styles/club-engine.css');
    for (const token of ['--realism-cyan:', '--realism-gold:']) {
      const at = schema.indexOf(token);
      expect(at, token).toBeGreaterThan(-1);
      const opener = schema.lastIndexOf('{', at);
      expect(schema.slice(opener, at), `${token} is inside that block`).not.toContain('}');
      expect(schema.slice(schema.lastIndexOf('}', opener) + 1, opener).trim()).toMatch(/:root$/);
    }
  });

  it('Go Back on a cold deep link opens the club home, or the arena, instead of doing nothing', () => {
    const fallback = read('src/components/challenges/DailyChallengesRouteFallback.tsx');
    const crash = between(
      fallback,
      'export function DailyChallengesCrashFallback(',
      '</StandardContentLayout>'
    );

    expect(fallback).toContain(
      "import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';"
    );
    expect(crash).toContain('const { routeClubId } = useClubWorkspace();');
    expect(crash).toContain('if (window.history.length > 1) {');
    expect(crash).toContain('window.history.back();');
    expect(crash).toContain("navigate(routeClubId ? `/clubs/${routeClubId}` : '/');");
    expect(crash).toContain('onClick={goBack}');
    expect(fallback).not.toContain('onClick={() => window.history.back()}');
  });

  it('the lobby tile image is a block, so its wrapper is the exact 2:3 box the art needs', () => {
    // An inline <img> left a ~7.7px descender gap under every lobby tile: the
    // wrapper measured 64.2x104 at a 393px phone instead of 64.2x96.3, the
    // fill tiles stretched about 8% and the native vault render letterboxed.
    const homeCss = read('src/pages/HomePage.module.css');
    const tileImage = between(homeCss, '.tileImage {', '}');
    expect(tileImage).toContain('display: block;');
    expect(tileImage).toContain('height: 100%;');
    expect(homeCss).toMatch(/\.tileImageWrapper\s*\{[^}]*aspect-ratio:\s*2 \/ 3/s);
  });

  it('the Challenge Vault label prints on one line inside the art title plate, sized by the tile', () => {
    const homeCss = read('src/pages/HomePage.module.css');
    // The wrapper holding the native render is the label's container.
    expect(homeCss).toContain(
      '.tileImageWrapper:has(> .tileImageNative) {\n  container-type: inline-size;'
    );
    // The plate runs from 88.5% to 95.5% of the art's height.
    const label = between(homeCss, '.tileLabel {', '}');
    expect(label).toContain('top: 88.5%;');
    expect(label).toContain('bottom: 4.5%;');
    expect(label).not.toContain('bottom: 3.8%;');
    const title = between(homeCss, '.tileLabel strong {', '}');
    expect(title).toContain('white-space: nowrap;');
    expect(title).toMatch(/font-size:\s*min\([\d.]+cqi,/);
    expect(title).not.toContain('vw');
    // The status only prints where the plate is tall enough for two lines.
    const status = between(homeCss, '.tileLabel small {', '}');
    expect(status).toContain('display: none;');
    expect(status).toContain('white-space: nowrap;');
    const wide = between(homeCss, '@container (min-width: 140px) {', '\n}\n');
    expect(wide).toContain('.tileLabel small {\n    display: block;');
  });

  it('the page title is a hidden heading, so no visible title can clip at 200% text', () => {
    // Dan 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS". The giant hero
    // title is gone, so the 200%-text rule that kept it inside its column
    // (WCAG 1.4.4, #5065) has nothing left to hold: the h1 is visually hidden
    // in the page bar and keeps its exact text for the browser outline.
    for (const partial of readdirSync(resolve(__dirname, '../src/pages/daily-challenges'))) {
      const css = read(`src/pages/daily-challenges/${partial}`);
      expect(css, partial).not.toMatch(/container-type/);
      expect(css, partial).not.toMatch(/\.heroCopy\b/);
    }
    const hero = read('src/components/challenges/dashboard/MissionHero.tsx');
    expect(hero).toContain('title={TIER_PRESENTATION[tier].title}');
    expect(hero).toContain('titleId="missions-title"');
    expect(hero).toContain('aria-labelledby="missions-title"');
  });

  it('the route shell paints the same frame width as the page it hands over to', () => {
    // StandardContentLayout reads at 680px; the page widens its column, and
    // the shell must match or the hero jumps width at the handover above 768px.
    // The page's width is the last top-level declaration in manifest order.
    const manifest = read('src/pages/DailyChallengesPage.module.css');
    let pageFrame: string | undefined;
    for (const [, partial] of manifest.matchAll(/@import '\.\/daily-challenges\/([^']+)';/g)) {
      const css = read(`src/pages/daily-challenges/${partial}`);
      for (const rule of css.matchAll(/^\.container > div \{([^}]*)\}/gm)) {
        pageFrame = rule[1].match(/max-width:\s*([^;]+);/)?.[1] ?? pageFrame;
      }
    }
    expect(pageFrame).toBe('1240px');
    const shell = read('src/components/challenges/DailyChallengesRouteFallback.module.css');
    expect(between(shell, '.container > div {', '}')).toContain(`max-width: ${pageFrame};`);
  });

  it('the route shell names the page without printing a hero', () => {
    // The shell is the first paint the preloader warms. It names the cycle
    // for screen readers and prints only its state, never the eyebrow,
    // giant title or scene art (Dan 2026-10-17).
    const css = read('src/components/challenges/DailyChallengesRouteFallback.module.css');
    expect(css).not.toMatch(/container-type|cqi/);
    expect(css).not.toMatch(/\.heroCopy\b|\.heroArtwork\b|\.eyebrow\b/);
    const fallback = read('src/components/challenges/DailyChallengesRouteFallback.tsx');
    expect(fallback).toContain('<h1 className={styles.srOnly}>{TITLES[tier]}</h1>');
    expect(fallback).not.toContain('EYEBROWS');
    expect(fallback).not.toContain('daily-missions-casino-v2');
  });
});
