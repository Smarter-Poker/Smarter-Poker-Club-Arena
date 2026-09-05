/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  hubTab — the pure decisions behind a World Hub page living in a table slot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04, verbatim: "when you click the + button from inside the club
 * lobby i should be able to go anywhere, its basically opening up a new browser
 * tab internally, it shouldn't be limited to just poker, if i open the + tab, go
 * to the lobby then hit the hub button and go to social, media, or trivia or
 * training or any other world hub page, I should still see my action bar, I
 * should still be able to swipe right or left to move back and forth between
 * pages."
 *
 * Social, Media, Trivia and Training are World Hub pages - a different
 * application (Next.js on smarter.poker) from this SPA, which is served under
 * /hub/club-arena. The only way to show one of them inside a Club Arena tab
 * while the tab strip and every running table stay mounted is a same-origin
 * <iframe src="/hub/...">. Dan approved that on 2026-09-04 as the ONE sanctioned
 * iframe in this codebase (CLAUDE.md 1.3); it still uses no postMessage and no
 * parent-window reach-back, because same-origin means the container can read the frame's
 * location and listen on its document directly.
 *
 * The container does three things with a hub frame, all decided here so they
 * are unit-testable without a DOM:
 *   1. name the tab from the frame's URL (`hubTabTitle`);
 *   2. notice when the frame is heading back INTO Club Arena and convert the
 *      tab in place instead of booting a second copy of this app inside the
 *      first (`clubArenaPathFromHubUrl`);
 *   3. refuse to frame anything that is not a World Hub page (`isHubPath`) -
 *      a hub tab is a window onto smarter.poker/hub, not a general browser.
 */

/** The World Hub's URL prefix and this SPA's own basename under it. */
export const HUB_PREFIX = '/hub';
export const CLUB_ARENA_PREFIX = '/hub/club-arena';

/** Everything after the origin: pathname plus search, no hash. */
const splitPath = (pathAndSearch: string): { pathname: string; search: string } => {
  const noHash = pathAndSearch.split('#')[0] ?? '';
  const q = noHash.indexOf('?');
  if (q === -1) return { pathname: noHash, search: '' };
  return { pathname: noHash.slice(0, q), search: noHash.slice(q) };
};

/** A same-origin World Hub path: `/hub` or `/hub/<anything>`, never Club Arena itself. */
export function isHubPath(pathAndSearch: string): boolean {
  const { pathname } = splitPath(pathAndSearch);
  if (pathname !== HUB_PREFIX && !pathname.startsWith(`${HUB_PREFIX}/`)) return false;
  return clubArenaPathFromHubUrl(pathAndSearch) === null;
}

/**
 * If this URL points back into Club Arena, the path INSIDE the SPA (relative
 * to its basename) with the search string carried along; otherwise null.
 *
 *   /hub/club-arena              -> '/'
 *   /hub/club-arena/             -> '/'
 *   /hub/club-arena/clubs/x?y=1  -> '/clubs/x?y=1'
 *   /hub/club-arenas             -> null   (a different page, not a prefix hit)
 *   /hub/social                  -> null
 */
export function clubArenaPathFromHubUrl(pathAndSearch: string): string | null {
  const { pathname, search } = splitPath(pathAndSearch);
  if (pathname === CLUB_ARENA_PREFIX) return `/${search}`;
  if (!pathname.startsWith(`${CLUB_ARENA_PREFIX}/`)) return null;
  const rest = pathname.slice(CLUB_ARENA_PREFIX.length);
  return `${rest === '/' ? '/' : rest}${search}`;
}

/**
 * The name the tab strip shows for a hub page.
 *
 * The first segment after /hub, with dashes and underscores read as spaces
 * and every word capitalised - the same First Letter Of Every Word rule the
 * popups follow. A handful of pages have names the segment does not spell:
 * those are listed. `/hub` on its own is the Hub.
 */
const NAMED: Record<string, string> = {
  vip: 'VIP',
  'vip-membership': 'VIP',
  'diamond-store': 'Diamonds',
  messenger: 'Messages',
  jarvis: 'Jarvis',
  ai: 'AI',
};

export function hubTabTitle(pathAndSearch: string): string {
  const { pathname } = splitPath(pathAndSearch);
  const rest = pathname.startsWith(`${HUB_PREFIX}/`)
    ? pathname.slice(HUB_PREFIX.length + 1)
    : pathname === HUB_PREFIX
      ? ''
      : pathname.replace(/^\/+/, '');
  const segment = rest.split('/')[0] ?? '';
  if (!segment) return 'Hub';
  const named = NAMED[segment.toLowerCase()];
  if (named) return named;
  const words = decodeURIComponent(segment)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return words.length > 0 ? words.join(' ') : 'Hub';
}

/**
 * Are these two URLs the same World Hub page? Pathname only, trailing slash
 * ignored: the frame reports its LIVE location, which Next.js may normalise
 * (a trailing slash, a default query), and a second press of the same button
 * must focus the tab that is already there rather than open a twin.
 */
export function sameHubPage(a: string, b: string): boolean {
  const norm = (p: string) => splitPath(p).pathname.replace(/\/+$/, '') || '/';
  return norm(a) === norm(b);
}

/**
 * How often the container reads the frame's location. Next.js moves between
 * pages with pushState, which fires no event a parent can hear, so polling is
 * the honest mechanism - and 250ms is fast enough that a frame heading back
 * into Club Arena is converted before the second app has finished booting.
 */
export const HUB_FRAME_POLL_MS = 250;

/**
 * A frame that has sat behind other tabs this long is unloaded: its page is
 * remembered (`hubUrl`) and reloaded the moment its tab is opened again.
 * Every hub tab is a whole running Next.js app with its own realtime socket,
 * and four of them behind a live felt is memory the felt needs; this is what
 * a phone browser does to background tabs, for the same reason. Fifteen
 * minutes is long enough that switching between a table and a page you are
 * actually reading never trips it.
 */
export const HUB_FRAME_IDLE_SUSPEND_MS = 15 * 60 * 1000;

/**
 * Is this destination somewhere other than smarter.poker? Off-site pages
 * open in a real browser tab, never inside the frame: Stripe Checkout and
 * OAuth providers refuse to render framed (X-Frame-Options: DENY), so
 * letting the frame follow them would show the player a blank tab at the
 * exact moment they are trying to pay or sign in.
 */
export function isOffSite(url: URL, origin: string): boolean {
  return url.origin !== origin;
}

/* ─── HUB TABS SURVIVE A RELOAD ───────────────────────────────────────────────
 *
 * Same reasoning as the lobby drill-in (`ca_lobby_drill_in`): a hub tab holds
 * no seat, no chips and no engine socket, so restoring one can never claim a
 * seat the player may have left - the worst case is a page they had open half
 * an hour ago. The deleted table persistence stored SEATS, which is why it
 * was deleted; this stores URLs. Thirty-minute TTL, because "what you were
 * reading" goes stale fast. */
export const HUB_TABS_KEY = 'ca_hub_tabs';
export const HUB_TABS_TTL_MS = 30 * 60 * 1000;

export function saveHubTabs(
  urls: readonly string[],
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeSession(),
  now = Date.now()
): void {
  if (!storage) return;
  try {
    if (urls.length === 0) {
      storage.removeItem(HUB_TABS_KEY);
      return;
    }
    storage.setItem(HUB_TABS_KEY, JSON.stringify({ at: now, urls }));
  } catch {
    /* private-mode storage throws; a hub tab is a convenience, not a seat */
  }
}

export function readHubTabs(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeSession(),
  now = Date.now()
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(HUB_TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { at?: unknown; urls?: unknown };
    if (typeof parsed?.at !== 'number' || now - parsed.at > HUB_TABS_TTL_MS) {
      storage.removeItem(HUB_TABS_KEY);
      return [];
    }
    // Parsed JSON from storage: validate every entry rather than trusting it,
    // and only ever restore a World Hub path - never Club Arena, never
    // another origin.
    const urls = Array.isArray(parsed.urls) ? parsed.urls : [];
    return urls.filter((u): u is string => typeof u === 'string' && isHubPath(u));
  } catch {
    return [];
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
