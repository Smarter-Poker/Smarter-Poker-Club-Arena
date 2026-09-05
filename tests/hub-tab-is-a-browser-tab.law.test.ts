/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW — THE "+" TAB IS AN INTERNAL BROWSER TAB (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "when you click the + button from inside the club lobby i
 * should be able to go anywhere, its basically opening up a new browser tab
 * internally, it shouldn't be limited to just poker, if i open the + tab, go
 * to the lobby then hit the hub button and go to social, media, or trivia or
 * training or any other world hub page, I should still see my action bar, I
 * should still be able to swipe right or left to move back and forth between
 * pages."
 *
 * Social, Media, Trivia and Training are World Hub pages, a different app.
 * They live in a tab through ONE same-origin <iframe> - HubFrame - which Dan
 * approved on 2026-09-04 as the single exception to CLAUDE.md 1.3 ("Never add
 * iframe code"). The exception is exactly that wide, and these pins keep it so:
 *
 *   - the frame is same-origin and talks to nobody: no postMessage, no
 *     window.parent, no sandbox that would make it a foreign origin;
 *   - it is the only <iframe> element in the app;
 *   - a swipe that starts on the hub page still moves the strip;
 *   - the frame heading back into /hub/club-arena converts the tab in place
 *     rather than booting a second Club Arena inside the first;
 *   - the "+" lobby has the Hub button (GlobalHeader in the tab), and that
 *     header does not impersonate the real one (#global-header, the root
 *     height variable, the window-level hamburger listeners);
 *   - a hub tab is not a table anywhere a table is counted, and not a lobby
 *     anywhere a lobby is reused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FRAME = read('src/components/table/HubFrame.tsx');
const MULTI = read('src/pages/MultiTablePage.tsx');
const HEADER = read('src/components/navigation/GlobalHeader.tsx');
const CONTEXT = read('src/context/InTabLobbyContext.tsx');
const STRIP = read('src/components/table/TableTabBar.tsx');
const CLAUDE_MD = read('CLAUDE.md');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
};

describe('the hub frame is the one sanctioned iframe, and it talks to nobody', () => {
  it('is the only <iframe> element in src/', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p) => /<iframe\b/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p))
      // ShareHand hands an embed-code STRING to third-party sites; it renders
      // no frame here. NotificationsPage and hubTab.ts mention one in prose.
      .filter((p) => !/ShareHand\.tsx|NotificationsPage\.tsx|utils\/hubTab\.ts$/.test(p));
    expect(offenders).toEqual(['src/components/table/HubFrame.tsx']);
  });

  it('uses no postMessage, no window.parent, no sandbox', () => {
    expect(FRAME).not.toMatch(/\.postMessage\(/);
    expect(FRAME).not.toMatch(/window\.parent\b/);
    expect(FRAME).not.toMatch(/\bsandbox\s*=/);
    // The same holds for the container that hosts it (a CALL, not the word -
    // its comments are allowed to explain what is forbidden).
    expect(MULTI).not.toMatch(/\.postMessage\(/);
  });

  it('reads the frame location itself (same-origin) and polls, because pushState is silent', () => {
    expect(FRAME).toContain('iframe.contentWindow?.location.href');
    expect(FRAME).toContain('window.setInterval(check, HUB_FRAME_POLL_MS)');
  });

  it('reads src ONCE, at mount - a re-render must never reload the page the player is on', () => {
    expect(FRAME).toContain('const initialSrc = useRef(src).current;');
    expect(FRAME).toMatch(/src=\{initialSrc\}/);
  });
});

describe('a swipe that starts on the hub page still moves the strip', () => {
  it('attaches the container swipe handlers to the frame document on every load', () => {
    for (const ev of ['touchstart', 'touchmove', 'touchend']) {
      expect(FRAME).toContain(`doc.addEventListener('${ev}'`);
    }
    expect(FRAME).toContain("iframe.addEventListener('load', onLoad)");
  });

  it('the container hands its handlers over through a ref that is kept current', () => {
    expect(MULTI).toContain('const hubSwipeRef = useRef<HubFrameSwipeHandlers>');
    expect(MULTI).toContain('hubSwipeRef.current = {');
    expect(MULTI).toContain('swipe={hubSwipeRef}');
  });
});

describe('a link back into Club Arena converts the tab, it never boots a second app', () => {
  it('anchor clicks are caught in the capture phase before the frame follows them', () => {
    expect(FRAME).toContain("doc.addEventListener('click', onClick, true)");
    expect(FRAME).toContain('clubArenaPathFromHubUrl(url.pathname + url.search)');
  });

  it('the container converts in place and routes tournaments to the in-tab renderer', () => {
    expect(MULTI).toContain('const handleHubClubArenaTarget = useCallback');
    expect(MULTI).toContain('onClubArenaTarget={handleHubClubArenaTarget}');
    expect(MULTI).toContain('const tournament = tournamentTargetFromTo(caPath);');
  });
});

describe('the "+" lobby has the Hub button, and it opens in the tab', () => {
  it('GlobalHeader renders at the top of BOTH lobby-tab branches', () => {
    expect(MULTI.split('<GlobalHeader inTab />').length - 1).toBe(2);
  });

  it('in a tab, Hub / VIP / Messages go through openHub instead of window.location', () => {
    expect(CONTEXT).toContain('openHub: (path: string) => boolean;');
    expect(HEADER).toContain('if (inTabHub && inTabHub.openHub(path)) return;');
    expect(HEADER).toContain("inTabHub.openHub('/hub/messenger')");
    expect(MULTI).toContain('openHub: openHubTab');
  });

  it('the in-tab header does not impersonate the real one', () => {
    // The ticker anchors to #global-header and the pinned strip reads the
    // root height variable; a copy inside a scroll container must not set
    // either (see topChrome.ts and MultiTablePage.css).
    expect(HEADER).toContain("id={inTab ? undefined : 'global-header'}");
    expect(HEADER).toContain("tabHost.style.setProperty('--ca-in-tab-header-height', height);");
    expect(HEADER).toMatch(/if \(tabHost\) \{\s*tabHost\.style\.setProperty/);
    // One header answers the hamburger gestures, not two.
    expect(HEADER.split('if (inTab) return;').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('only a lobby tab becomes a hub tab, and only for a /hub page', () => {
    expect(MULTI).toContain('if (!isHubPath(path)) return false;');
    expect(MULTI).toContain('if (!cur || !isLobbyTab(cur)) return false;');
  });
});

describe('a hub tab is not a table, and not a lobby', () => {
  it('every live-table decision asks isTableTab, never !isLobbyTab', () => {
    expect(MULTI).not.toMatch(/!isLobbyTab\(t\)/);
    expect(MULTI).toContain('const isTableTab = (t: TableInstance): boolean => !isPageTab(t);');
  });

  /* The slot model itself (isHubLike, isPageTab, isFreeSlot refusing a hub
     tab, the observe and prune decisions) is pinned by RUNNING it in
     tests/unit/hubTab.test.ts - src/utils is pure and importable, and a
     regex over its source would pass on a line that is present and wrong. */

  it('the strip offers a hub tab nothing a seat would have, and closes it as a tab', () => {
    expect(STRIP).toContain("id.startsWith('lobby:') || id.startsWith('hub:')");
    expect(STRIP).toContain("isHubId(tab.id) ? 'Close Tab'");
  });

  it('the footer still follows the LOBBY only - a hub page has its own', () => {
    expect(MULTI).toContain('publishInTabLobbyActive(!hidden && !!cur && isLobbyTab(cur))');
  });
});

describe('the exception is written where the next agent will read it', () => {
  it('CLAUDE.md names HubFrame as the one sanctioned iframe', () => {
    expect(CLAUDE_MD).toContain('HubFrame');
    expect(CLAUDE_MD).toMatch(/one sanctioned iframe/i);
  });
});
