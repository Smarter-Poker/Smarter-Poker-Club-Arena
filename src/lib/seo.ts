/**
 * Route-level SEO for the Club Arena SPA.
 *
 * The World Hub (Next.js) renders its <head> on the server. Club Arena is a
 * Vite SPA served under smarter.poker/hub/club-arena, so its <head> ships once
 * from index.html and every route shares it. Until 2026-09-16 that shared head
 * said `noindex, nofollow`, which told Google to drop the entire arena.
 *
 * This module is the per-route answer. index.html now carries the indexable
 * defaults for the landing page; `applySeo` rewrites title, description,
 * canonical, robots and JSON-LD as the router moves, so:
 *
 *   - the public surfaces (landing, help centre, legal documents) are
 *     indexable with their own title, description, canonical and schema;
 *   - every signed-in surface (lobby data, cashier, wallet, tables, club
 *     dashboards, messages...) is `noindex` and carries no canonical, so a
 *     crawler that renders the app never files a player's private page.
 *
 * Googlebot renders JavaScript and honours robots meta set at render time as
 * long as the raw HTML does not already say noindex. Bing and the AI crawlers
 * mostly do not render; for them the static index.html head is the answer.
 *
 * Only DOM is touched here. No dependency, no context, no React import.
 */
import { WEB_APP_URL, WEB_ORIGIN } from './appBase';
import { FAQ_ITEMS } from '../pages/helpContent';

export const SITE_NAME = 'Smarter.Poker';
/**
 * Poker Arena's own 1200x630 share card (discoverability phase 6, 2026-09-17),
 * served by the World Hub from public/images/og-poker-arena.jpg. Before this
 * every arena link previewed as the generic Smarter.Poker poster.
 */
export const DEFAULT_OG_IMAGE = `${WEB_ORIGIN}/images/og-poker-arena.jpg`;
export const ROBOTS_INDEX =
  'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';
export const ROBOTS_NOINDEX = 'noindex, nofollow';

export type JsonLd = Record<string, unknown>;

export interface SeoEntry {
  /** Page <title>. `| Smarter.Poker` is appended unless already present. */
  title: string;
  description: string;
  /** In-app path the canonical URL is built from ('' or '/' is the landing). */
  canonicalPath: string;
  /** true = discoverable; false = noindex, nofollow, no canonical. */
  index: boolean;
  jsonLd?: JsonLd | JsonLd[];
}

const ORGANIZATION: JsonLd = {
  '@type': 'Organization',
  '@id': `${WEB_ORIGIN}/#organization`,
  name: SITE_NAME,
  url: WEB_ORIGIN,
  logo: `${WEB_ORIGIN}/smarter-poker-logo.png`,
};

const POKER_ARENA_APP: JsonLd = {
  '@type': 'SoftwareApplication',
  '@id': `${WEB_APP_URL}#app`,
  name: 'Poker Arena',
  alternateName: ['Club Arena', 'Smarter.Poker Club Arena'],
  url: WEB_APP_URL,
  applicationCategory: 'GameApplication',
  applicationSubCategory: 'Poker',
  operatingSystem: 'Web, iOS, Android',
  isAccessibleForFree: true,
  inLanguage: 'en',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  publisher: { '@id': `${WEB_ORIGIN}/#organization` },
  description:
    'Private Online Poker Clubs On Smarter.Poker With Real Time Cash Games And Tournaments, Hand Histories, Player Statistics, Leaderboards, Unions And Full Club Management.',
  featureList: [
    'Private Poker Clubs',
    'Real Time Cash Games',
    'Multi Table Tournaments',
    'Hand Histories And Replays',
    'Player Statistics And Leaderboards',
    'Club Cashier And Chip Management',
    'Unions And Cross Club Games',
    'Diamond Arena Games',
  ],
};

function breadcrumbs(items: Array<{ name: string; path: string }>): JsonLd {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: SITE_NAME, item: WEB_ORIGIN },
      ...items.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 2,
        name: item.name,
        item: canonicalUrl(item.path),
      })),
    ],
  };
}

const ARENA_CRUMB = { name: 'Poker Arena', path: '/' };

/**
 * Google's FAQPage rich result for the Help Center, built from the same
 * FAQ_ITEMS the page (and its prerender) renders, so the schema can never
 * say something the page does not. Answers are plain text already.
 */
function helpFaqPage(): JsonLd {
  return {
    '@type': 'FAQPage',
    '@id': `${canonicalUrl('/help')}#faq`,
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

/*
 * AEO phase 3 (2026-09-18): these five titles were the bare document name,
 * so with " | Smarter.Poker" appended they read exactly like the World Hub's
 * own pages. /hub/club-arena/legal/tos and /terms both shipped
 * "Terms Of Service | Smarter.Poker", and both are indexed, on one domain,
 * for two different documents. /legal/privacy and /privacy were the same,
 * and /help sat a word away from /hub/help.
 *
 * Each now names the product whose document it is. The descriptions already
 * said "Poker Arena"; only the titles did not. All five render inside the
 * 60 characters a result shows, brand suffix counted.
 */
/** Public, indexable routes. Everything not listed here is noindex. */
const PUBLIC_ROUTES: Record<string, Omit<SeoEntry, 'index'>> = {
  '/': {
    title: 'Poker Arena | Private Online Poker Clubs',
    description:
      'Create Or Join A Private Online Poker Club On Smarter.Poker. Real Time Cash Games, Tournaments, Hand Histories, Player Stats, Leaderboards, Unions And Full Club Management.',
    canonicalPath: '/',
    jsonLd: [ORGANIZATION, POKER_ARENA_APP, breadcrumbs([ARENA_CRUMB])],
  },
  '/help': {
    title: 'Poker Arena Help Center',
    description:
      'Answers To The Most Common Poker Arena Questions: Accounts, Joining And Running Clubs, Cash Games And Tournaments, Rewards, Fair Gaming And Player Safety.',
    canonicalPath: '/help',
    jsonLd: [breadcrumbs([ARENA_CRUMB, { name: 'Help Center', path: '/help' }]), helpFaqPage()],
  },
  '/legal': {
    title: 'Poker Arena Legal Center',
    description:
      'The Poker Arena Legal Center: Terms Of Service, Privacy Policy, Fair Gaming Standards And Club Promotion Rules For Smarter.Poker Private Poker Clubs.',
    canonicalPath: '/legal',
    jsonLd: breadcrumbs([ARENA_CRUMB, { name: 'Legal Center', path: '/legal' }]),
  },
  '/legal/tos': {
    title: 'Poker Arena Terms Of Service',
    description:
      'The Terms Of Service For Playing In And Operating Private Poker Clubs On Poker Arena At Smarter.Poker.',
    canonicalPath: '/legal/tos',
    jsonLd: breadcrumbs([
      ARENA_CRUMB,
      { name: 'Legal Center', path: '/legal' },
      { name: 'Terms Of Service', path: '/legal/tos' },
    ]),
  },
  '/legal/privacy': {
    title: 'Poker Arena Privacy Policy',
    description:
      'How Poker Arena Collects, Uses And Protects Player Information Across Smarter.Poker Private Poker Clubs.',
    canonicalPath: '/legal/privacy',
    jsonLd: breadcrumbs([
      ARENA_CRUMB,
      { name: 'Legal Center', path: '/legal' },
      { name: 'Privacy Policy', path: '/legal/privacy' },
    ]),
  },
  '/legal/fair-gaming': {
    title: 'Poker Arena Fair Gaming Policy',
    description:
      'The Fair Gaming Standards Behind Every Poker Arena Table: Server Side Shuffling, Collusion Detection, Anti Cheat Monitoring And Dispute Resolution.',
    canonicalPath: '/legal/fair-gaming',
    jsonLd: breadcrumbs([
      ARENA_CRUMB,
      { name: 'Legal Center', path: '/legal' },
      { name: 'Fair Gaming Policy', path: '/legal/fair-gaming' },
    ]),
  },
  '/legal/promotions': {
    title: 'Poker Arena Promotion Rules',
    description:
      'The Rules That Govern Club Promotions, Bonuses And Jackpots Inside Poker Arena Private Poker Clubs On Smarter.Poker.',
    canonicalPath: '/legal/promotions',
    jsonLd: breadcrumbs([
      ARENA_CRUMB,
      { name: 'Legal Center', path: '/legal' },
      { name: 'Promotion Rules', path: '/legal/promotions' },
    ]),
  },
};

const PRIVATE_DEFAULT: SeoEntry = {
  title: 'Poker Arena',
  description: PUBLIC_ROUTES['/'].description,
  canonicalPath: '',
  index: false,
};

/** In-app paths the sitemap and the landing page link to. */
export const PUBLIC_PATHS: readonly string[] = Object.keys(PUBLIC_ROUTES);

/** Canonical absolute URL for an in-app path, with no trailing slash. */
export function canonicalUrl(inAppPath: string): string {
  const trimmed = inAppPath.replace(/^\/+|\/+$/g, '');
  return trimmed ? `${WEB_APP_URL}/${trimmed}` : WEB_APP_URL;
}

/** Normalise a router pathname to a lookup key: no trailing slash, '/' root. */
export function normalisePath(pathname: string): string {
  const stripped = pathname.replace(/\/+$/g, '');
  return stripped === '' ? '/' : stripped;
}

export function resolveSeo(pathname: string): SeoEntry {
  const entry = PUBLIC_ROUTES[normalisePath(pathname)];
  return entry ? { ...entry, index: true } : PRIVATE_DEFAULT;
}

// ─── DOM ────────────────────────────────────────────────────────────────────

const JSON_LD_ID = 'route-jsonld';

function upsertMeta(selector: string, attrs: Record<string, string>, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(href: string | null) {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!href) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

function setJsonLd(jsonLd: SeoEntry['jsonLd']) {
  let script = document.getElementById(JSON_LD_ID) as HTMLScriptElement | null;
  if (!jsonLd) {
    script?.remove();
    return;
  }
  if (!script) {
    script = document.createElement('script');
    script.id = JSON_LD_ID;
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  const graph = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
}

export function fullTitle(title: string): string {
  return title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
}

/**
 * Write one route's SEO into <head>. Idempotent: the same tags are reused on
 * every call, and a private route leaves the page title alone so the pages
 * that already set `document.title` for themselves keep doing so.
 */
export function applySeo(entry: SeoEntry): void {
  if (typeof document === 'undefined') return;

  const canonical = entry.index ? canonicalUrl(entry.canonicalPath) : null;
  const ogTitle = fullTitle(entry.title);

  if (entry.index) {
    document.title = ogTitle;
    upsertMeta('meta[name="description"]', { name: 'description' }, entry.description);
    upsertMeta('meta[property="og:title"]', { property: 'og:title' }, ogTitle);
    upsertMeta(
      'meta[property="og:description"]',
      { property: 'og:description' },
      entry.description
    );
    upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title' }, ogTitle);
    upsertMeta(
      'meta[name="twitter:description"]',
      { name: 'twitter:description' },
      entry.description
    );
    if (canonical) upsertMeta('meta[property="og:url"]', { property: 'og:url' }, canonical);
  }

  upsertMeta(
    'meta[name="robots"]',
    { name: 'robots' },
    entry.index ? ROBOTS_INDEX : ROBOTS_NOINDEX
  );
  setCanonical(canonical);
  setJsonLd(entry.index ? entry.jsonLd : undefined);
}
