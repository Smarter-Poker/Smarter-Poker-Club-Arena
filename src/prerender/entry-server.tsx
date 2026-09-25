/**
 * PRERENDER ENTRY - the public arena, readable without JavaScript.
 *
 * AEO PHASE 1 (2026-09-17). Club Arena is a Vite SPA: the origin serves one
 * index.html whose body is `<div id="root"></div>` and every word of every
 * page exists only after the bundle runs. Googlebot renders JavaScript; the
 * crawlers that decide what ChatGPT, Claude, Perplexity and Meta AI can cite
 * (OAI-SearchBot, Claude-SearchBot, PerplexityBot, meta-webindexer) do not,
 * and neither does Bing at scale. To them the whole arena was an empty div.
 *
 * This module is built separately (`vite build --ssr`, see
 * vite.prerender.config.ts) and run once after the client build by
 * scripts/prerender-public-routes.mjs. It renders the PUBLIC pages, and only
 * those, to static HTML with react-dom/server: the landing page, the Help
 * Center, the Legal Center and the four legal documents, exactly the routes
 * src/lib/seo.ts declares indexable. Nothing signed-in is ever rendered here; there is no
 * session, no Supabase, no store. The page components are rendered inside a
 * StaticRouter with the web basename so every <Link> resolves to the public
 * address, and inside nothing else: no AuthGuard, no AppLayout, no providers,
 * because none of the public pages needs one to paint its words.
 *
 * At runtime the ordinary bundle boots on top of the prerendered markup and
 * replaces it (main.tsx uses createRoot, not hydrateRoot), so the app is
 * exactly what it was; the prerender is what a reader gets before, or
 * without, JavaScript.
 */
import React, { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { ROUTER_BASENAME } from '../lib/appBase';
import { PUBLIC_PATHS, resolveSeo, type SeoEntry } from '../lib/seo';
import PokerArenaLandingPage from '../pages/PokerArenaLandingPage';
import HelpPrerender from './HelpPrerender';
import LegalPrerender from './LegalPrerender';
import TermsOfServicePage from '../pages/legal/TermsOfServicePage';
import PrivacyPolicyPage from '../pages/legal/PrivacyPolicyPage';
import FairGamingPage from '../pages/legal/FairGamingPage';
import ClubPromotionRulesPage from '../pages/legal/PromotionsPage';

const PAGES: Record<string, () => React.JSX.Element> = {
  '/': () => <PokerArenaLandingPage />,
  '/help': () => <HelpPrerender />,
  '/legal': () => <LegalPrerender />,
  '/legal/tos': () => <TermsOfServicePage />,
  '/legal/privacy': () => <PrivacyPolicyPage />,
  '/legal/fair-gaming': () => <FairGamingPage />,
  '/legal/promotions': () => <ClubPromotionRulesPage />,
};

/**
 * Indexable routes that are deliberately NOT prerendered, each with the
 * reason. A route here still gets the shell (index.html with the landing
 * markup) and its per-route SEO once the bundle runs.
 */
export const PRERENDER_EXCEPTIONS: Readonly<Record<string, string>> = {
  // '/legal' was the one exception until 2026-09-22: Google filed it as an
  // alternate of the arena root because it served the landing's canonical.
  // It is rendered from pages/legalCenterContent.ts by LegalPrerender.
};

/** The routes this entry can render. With the exceptions, must equal seo.ts PUBLIC_ROUTES. */
export const PRERENDER_PATHS: readonly string[] = Object.keys(PAGES);

export function assertPrerenderCoversPublicRoutes(): void {
  const missing = PUBLIC_PATHS.filter((p) => !(p in PAGES) && !(p in PRERENDER_EXCEPTIONS));
  const extra = [...PRERENDER_PATHS, ...Object.keys(PRERENDER_EXCEPTIONS)].filter(
    (p) => !PUBLIC_PATHS.includes(p)
  );
  if (missing.length || extra.length) {
    throw new Error(
      `prerender routes drift from seo.ts PUBLIC_ROUTES (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`
    );
  }
}

export interface PrerenderedPage {
  path: string;
  html: string;
  seo: SeoEntry;
}

export function renderPublicPage(path: string): PrerenderedPage {
  const Page = PAGES[path];
  if (!Page) throw new Error(`no prerender page for ${path}`);
  const html = renderToString(
    <StrictMode>
      <StaticRouter
        basename={ROUTER_BASENAME}
        location={`${ROUTER_BASENAME}${path === '/' ? '' : path}`}
      >
        {/* At runtime AppLayout supplies <main id="main-content"> around every
            route but the landing, which is its own main. The static page a
            reader gets before, or without, JavaScript has the same landmark
            (discoverability phase 6, 2026-09-17). */}
        {path === '/' ? (
          <Page />
        ) : (
          <main id="main-content" tabIndex={-1}>
            <Page />
          </main>
        )}
      </StaticRouter>
    </StrictMode>
  );
  return { path, html, seo: resolveSeo(path) };
}
