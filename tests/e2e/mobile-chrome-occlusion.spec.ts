/**
 * MOBILE CHROME OCCLUSION — the vertical half of "everything fits into one
 * screen" (Dan, 2026-08-22).
 *
 * mobile-fit-audit.spec.ts answers the horizontal question: nothing may run
 * off the right edge. This answers the vertical one, which is where the
 * damage actually hides: the app frames every page between a sticky header
 * and — on club pages — a FIXED bottom nav. A fixed bar is out of flow, so a
 * page that does not deliberately reserve its height renders its last row of
 * content UNDERNEATH it. The content is not clipped and the page does not
 * scroll any further, so nothing looks broken in a screenshot: the row is
 * simply unreachable. That is exactly the "the footer links are not at the
 * bottom" symptom recorded in globals.css on 2026-08-20, which is when
 * `--bottom-nav-clearance` was introduced as "what a page must actually
 * reserve".
 *
 * Two checks per route:
 *
 *   TOP     at scroll 0, no content may sit under the sticky header. The
 *           header is in normal flow today, so this should be free — it is
 *           here because a page that gives itself a negative margin, or its
 *           own fixed sub-header, reintroduces the bug silently.
 *   BOTTOM  scrolled all the way down, no content may sit under the fixed
 *           bottom bar. This is the one that catches a missing clearance.
 *
 * Deliberately measured on LEAF elements only, and only on elements that
 * carry something a person can read or press. A wrapper that extends under
 * the bar while its children stop short is not a defect, and counting it
 * would make this spec cry wolf on every page with a full-height background.
 */
import { test, expect, type Page } from '@playwright/test';

const CLUB = process.env.AUDIT_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const CLUB_ARENA_PATH = '/hub/club-arena';

/* The routes that carry the fixed bottom nav, plus a few plain ones so the
   top check has non-club coverage too. */
const ROUTES = [
  'profile',
  'wallet',
  'settings',
  'friends',
  `clubs/${CLUB}`,
  `clubs/${CLUB}/members`,
  `clubs/${CLUB}/rules`,
  `clubs/${CLUB}/announcements`,
  `clubs/${CLUB}/promotions`,
  `clubs/${CLUB}/jackpot`,
  `clubs/${CLUB}/lobby`,
  `clubs/${CLUB}/messages`,
];

/** Tolerance: sub-pixel layout and 1px borders are not defects. */
const SLACK = 4;

interface Occlusion {
  route: string;
  edge: 'top' | 'bottom';
  coveredPx: number;
  sel: string;
  text: string;
}

type ChromeProbeResult = {
  hits: Array<Omit<Occlusion, 'route'>>;
  hadTop: boolean;
  hadBottom: boolean;
};

async function evaluateAcrossDocumentReplacement(
  page: Page,
  pageFunction: (arg: { SLACK: number }) => Promise<ChromeProbeResult>,
  arg: { SLACK: number }
): Promise<ChromeProbeResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, arg);
    } catch (error) {
      const contextReplaced =
        /execution context was destroyed|most likely because of a navigation/i.test(String(error));
      if (!contextReplaced || attempt === 3) throw error;

      // A World Hub publish can replace the document once while this audit is
      // measuring it. Wait for that real navigation to settle, then measure
      // the replacement page. This is not a Playwright test retry, and it does
      // not skip the strict geometry assertion.
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(750);
    }
  }
  throw new Error('Club Arena document never settled for measurement.');
}

/* ─────────────────────────────────────────────────────────────────────────────
   THE WELCOME MODAL MUST NOT BE IN FRONT OF WHAT THIS MEASURES (2026-08-29)

   The first complete run of the post-deploy tier reported three controls as
   unreachable on production, including a "Challenge" button with ZERO reachable
   pixels. Probed live, none of them was a tap-target defect: `ClubArenaWelcomeModal`
   was open, and `document.elementFromPoint` was returning its overlay
   (_overlay_ > _modal_ > _content_) for every point on the page. A suite that
   reports every control on every route as unreachable is not a guard, it is a
   wolf-crier, and a wolf-crier gets muted - which would have quietly undone the
   whole reason this spec was given a job to run in.

   global-setup writes STORAGE_KEYS.WELCOME_ACCEPTED into the storageState it
   captures, and that is correct and stays. It is not sufficient here: these
   specs open their own context (`test.use({ isMobile })`), and any route that
   boots before the key is read - or any session where the app rewrites its own
   storage on entry - puts the overlay back. An init script runs before every
   document in this context, so the flag is set no matter how the page arrives.
   Cheap, local, and it cannot affect any other spec.

   If a control genuinely cannot be reached, this now says so about the control.
   ───────────────────────────────────────────────────────────────────────────── */
const WELCOME_ACCEPTED_KEY = 'club_arena_welcome_accepted'; // src/lib/storage.ts

test.beforeEach(async ({ page }) => {
  await page.addInitScript((k) => {
    try {
      localStorage.setItem(k, 'true');
    } catch {
      /* storage blocked - the spec will surface the overlay as a real miss */
    }
  }, WELCOME_ACCEPTED_KEY);
});

test('no chrome covers reachable content at 375px', async ({ page }) => {
  test.setTimeout(ROUTES.length * 15_000 + 120_000);
  await page.setViewportSize({ width: 375, height: 812 });

  const occlusions: Occlusion[] = [];
  const skipped: string[] = [];
  const noChrome: string[] = [];

  for (const route of ROUTES) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (!String(err).includes('ERR_ABORTED')) {
        skipped.push(`${route}: navigation failed`);
        continue;
      }
    }
    await page.waitForTimeout(2600);
    if (page.url().includes('/auth')) {
      skipped.push(route);
      continue;
    }
    const pathname = new URL(page.url()).pathname.replace(/\/$/, '');
    if (pathname !== CLUB_ARENA_PATH && !pathname.startsWith(`${CLUB_ARENA_PATH}/`)) {
      /* Some Club Arena links intentionally hand off to another World Hub
         application (club Messages opens Messenger). That destination owns
         its own chrome and has its own audits; measuring it against Club
         Arena's fixed bottom-nav contract produces a cross-app false alarm. */
      skipped.push(`${route}: routes outside Club Arena to ${pathname}`);
      continue;
    }

    const found = await evaluateAcrossDocumentReplacement(
      page,
      async ({ SLACK }) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const bars = Array.from(document.querySelectorAll('nav,header,div,footer'));
        const isWide = (b: DOMRect) => b.width > vw * 0.8 && b.height > 24;
        const topBar = bars.find((el) => {
          const s = getComputedStyle(el);
          if (s.position !== 'fixed' && s.position !== 'sticky') return false;
          const b = el.getBoundingClientRect();
          return b.top <= 2 && b.bottom > 8 && b.bottom < vh * 0.3 && isWide(b);
        });
        const bottomBar = bars.find((el) => {
          const s = getComputedStyle(el);
          if (s.position !== 'fixed') return false;
          const b = el.getBoundingClientRect();
          return b.bottom >= vh - 3 && b.height > 40 && b.height < 160 && isWide(b);
        });

        const root = document.querySelector('#main-content') || document.body;

        /* Content, for this purpose, is a LEAF that a person can read or
           press. Anything living inside a fixed layer (the bars themselves,
           a parked drawer, a modal) is chrome, not page content. */
        const leaves = () => {
          const out: Array<{ el: Element; b: DOMRect }> = [];
          for (const el of root.querySelectorAll('*')) {
            if (el.children.length > 0) continue;
            if (el.closest('[aria-hidden="true"]')) continue;
            const s = getComputedStyle(el);
            if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue;
            let b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) continue;
            if (b.right <= 0 || b.left >= vw) continue;
            const txt = (el.textContent || '').trim();
            const pressable = Boolean(
              el.closest(
                'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[tabindex]:not([tabindex="-1"])'
              )
            );
            const meaningfulImage =
              el.tagName === 'IMG' && Boolean((el.getAttribute('alt') || '').trim());
            if (!txt && !pressable && !meaningfulImage) continue;

            /* MEASURE THE GLYPHS, NOT THE BOX. A text leaf inside a flex row
               stretches to the row's height by default, so its BOX can run
               hundreds of pixels past text that actually sits at the top —
               the jackpot page's empty-state <p> reported 704px "covered"
               while every word of it was plainly visible. A Range over the
               text node gives the rectangle the reader can actually see. */
            if (txt && el.firstChild && el.firstChild.nodeType === 3) {
              const range = document.createRange();
              range.selectNodeContents(el);
              const rb = range.getBoundingClientRect();
              if (rb.width > 0 && rb.height > 0) b = rb;
            }
            let p: Element | null = el;
            let inFixed = false;
            while (p && p !== root) {
              const ps = getComputedStyle(p);
              if (ps.position === 'fixed') {
                inFixed = true;
                break;
              }
              p = p.parentElement;
            }
            if (inFixed) continue;
            out.push({ el, b });
          }
          return out;
        };

        const describe = (el: Element, b: DOMRect, covered: number) => ({
          coveredPx: Math.round(covered),
          sel:
            el.tagName.toLowerCase() +
            (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : ''),
          text: (el.textContent || '').trim().slice(0, 34).replace(/\s+/g, ' '),
        });

        const hits: Array<{ edge: 'top' | 'bottom' } & ReturnType<typeof describe>> = [];

        // ── TOP: at rest, nothing should already be under the header.
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 350));
        if (topBar) {
          const headerBottom = topBar.getBoundingClientRect().bottom;
          let worst: ReturnType<typeof describe> | null = null;
          for (const { el, b } of leaves()) {
            const covered = headerBottom - b.top;
            if (covered > SLACK && b.bottom > 0) {
              const d = describe(el, b, covered);
              if (!worst || d.coveredPx > worst.coveredPx) worst = d;
            }
          }
          if (worst) hits.push({ edge: 'top', ...worst });
        }

        // ── BOTTOM: only provable once the page cannot scroll further.
        if (bottomBar) {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise((r) => setTimeout(r, 450));
          const navTop = bottomBar.getBoundingClientRect().top;
          let worst: ReturnType<typeof describe> | null = null;
          for (const { el, b } of leaves()) {
            if (b.top >= vh) continue; // below the fold entirely, not on screen
            const covered = b.bottom - navTop;
            if (covered > SLACK) {
              const d = describe(el, b, covered);
              if (!worst || d.coveredPx > worst.coveredPx) worst = d;
            }
          }
          if (worst) hits.push({ edge: 'bottom', ...worst });
        }

        return { hits, hadTop: !!topBar, hadBottom: !!bottomBar };
      },
      { SLACK }
    );

    // The replacement document may be an intentional cross-app handoff. The
    // first pathname check ran before the publish reload; classify the settled
    // destination again before applying Club Arena's chrome contract to it.
    const settledPathname = new URL(page.url()).pathname.replace(/\/$/, '');
    if (settledPathname !== CLUB_ARENA_PATH && !settledPathname.startsWith(`${CLUB_ARENA_PATH}/`)) {
      skipped.push(`${route}: routes outside Club Arena to ${settledPathname}`);
      continue;
    }

    if (!found.hadTop && !found.hadBottom) noChrome.push(route);
    for (const h of found.hits) {
      occlusions.push({ route, edge: h.edge, coveredPx: h.coveredPx, sel: h.sel, text: h.text });
    }
  }

  console.log(
    'MOBILE_CHROME_OCCLUSION ' +
      JSON.stringify({ occlusions, skipped, noChrome, routesChecked: ROUTES.length }, null, 1)
  );

  if (process.env.MOBILE_FIT_STRICT || process.env.CI) {
    expect(
      occlusions,
      `Chrome covering content at 375px (reserve var(--bottom-nav-clearance)):\n${occlusions
        .map((o) => `  ${o.route} [${o.edge}] ${o.coveredPx}px under the bar: ${o.sel} "${o.text}"`)
        .join('\n')}`
    ).toEqual([]);
  }
});
