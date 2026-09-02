/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TAP SWEEP'S OWN RULES, TESTED WITHOUT A LOGIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mobile-tap-targets.spec.ts` runs against production, signed in, in the
 * post-deploy tier. That makes it the right place to FIND defects and the
 * wrong place to prove its own judgement: it needs `SP_PASS` (a CI secret), it
 * needs whatever happens to be on the live pages that minute, and a run that
 * cannot sign in reports `checked: 0` and proves nothing either way.
 *
 * Its judgement is what changed on 2026-08-30 — it stopped accusing controls
 * that sit under FIXED chrome on a page that still scrolls, because the friends
 * list's fifth Challenge button was reported at "reachable 0px" while the four
 * above it reached the full 42px. That rule is exactly the kind of thing that
 * quietly rots into "excuses everything", so it is pinned HERE, where the DOM
 * is built by hand, nothing is authenticated, and the beats run in the merge
 * gate in about a second.
 *
 * Four cases, and the two that must still FAIL are the point of the file:
 *
 *   1. a plain small control, nothing over it    -> fine (the sweep measures
 *                                                  occlusion, not smallness)
 *   2. under fixed chrome, page scrolls         -> excused (scroll reveals it)
 *   3. partly under fixed chrome, centre clear  -> excused (scroll reveals it)
 *   4. under fixed chrome, page does NOT scroll -> REPORTED (nowhere to go)
 *   5. overlapped by an ordinary sibling        -> REPORTED (a real defect)
 *
 * The rule under test is copied from the sweep rather than imported, because
 * the sweep's copy lives inside a `page.evaluate` callback and cannot be
 * imported. `the sweep still contains this rule` below is what stops the two
 * copies drifting apart: it reads the real spec file and fails if the
 * expressions that make the rule are gone.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REACH = 20; // MIN(44) / 2 - 2, as the sweep computes it

/** Build a page: a scrollable (or not) list with a control, optionally under
 *  fixed chrome, optionally overlapped by an ordinary sibling. */
function page(opts: { scrolls: boolean; fixedChrome: boolean; sibling: boolean }) {
  return `<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; }
    body { font: 14px sans-serif; }
    #main-content { padding: 0; }
    .filler { height: ${opts.scrolls ? 2000 : 10}px; }
    .row { position: relative; height: 60px; }
    .target { position: absolute; left: 20px; top: 20px; height: 21px; width: 120px; }
    .sibling { position: absolute; left: 20px; top: 14px; height: 34px; width: 120px;
               background: rgba(0,0,0,0.01); }
    .chrome { position: fixed; left: 0; right: 0; bottom: 0; height: 120px;
              background: rgba(0,0,0,0.02); }
  </style></head><body><div id="main-content">
    <div class="row">
      <button class="target">Challenge</button>
      ${opts.sibling ? '<p class="sibling"></p>' : ''}
    </div>
    <div class="filler"></div>
  </div>
  ${opts.fixedChrome ? '<nav class="chrome"><a href="#x">Nav</a></nav>' : ''}
  </body></html>`;
}

/** The sweep's decision, verbatim in shape: is this control REPORTED as a miss? */
const DECIDE = ({ reachNeeded }: { reachNeeded: number }) => {
  const el = document.querySelector('.target') as HTMLElement;
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2;
  const cy = b.top + b.height / 2;

  const inFixedLayer = (node: Element | null) => {
    let q: Element | null = node;
    while (q) {
      if (getComputedStyle(q).position === 'fixed') return true;
      q = q.parentElement;
    }
    return false;
  };

  let reach = 0;
  let firstBlockersAreFixedChrome = false;
  for (let d = 0; d <= reachNeeded; d += 4) {
    const up = document.elementFromPoint(cx, Math.max(1, cy - d));
    const down = document.elementFromPoint(cx, Math.min(window.innerHeight - 1, cy + d));
    const owns = (t: Element | null) => !!t && (t === el || el.contains(t) || t.contains(el));
    if (!owns(up) || !owns(down)) {
      const blockers = [up, down].filter((candidate) => !owns(candidate));
      firstBlockersAreFixedChrome =
        blockers.length > 0 && blockers.every((candidate) => inFixedLayer(candidate));
      break;
    }
    reach = d;
  }
  const reachablePx = reach * 2;

  const pageScrolls =
    document.documentElement.scrollHeight > window.innerHeight + 1 ||
    document.body.scrollHeight > window.innerHeight + 1;

  const excused = reachablePx < reachNeeded * 2 && pageScrolls && firstBlockersAreFixedChrome;

  return { reachablePx, excused, reported: reachablePx < reachNeeded * 2 && !excused };
};

test.describe('the tap sweep excuses only what it genuinely cannot see', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('1. a small control with only its own ancestors around it is FINE', async ({ page: p }) => {
    /* Worth pinning because it is the sweep's least obvious property, and the
       first draft of this file got it wrong: the sweep measures OCCLUSION, not
       smallness. Its ownership test is
       `t === el || el.contains(t) || t.contains(el)`, so a point that lands on
       an ANCESTOR still counts as the control's. A 21px button inside a 60px
       row is therefore fully reachable - and correctly so, because a thumb
       landing just above or below it hits nothing that would steal the tap.
       This is why the misses the tier reports are always something covering
       something, and why the two exclusion beats below are about who is doing
       the covering. */
    await p.setContent(page({ scrolls: true, fixedChrome: false, sibling: false }));
    const r = await p.evaluate(DECIDE, { reachNeeded: REACH });
    expect(r.excused, 'nothing was covering it, so nothing may be excused').toBe(false);
    expect(r.reported, 'an unobstructed control inside its own row is not a miss').toBe(false);
  });

  test('2. under fixed chrome on a SCROLLING page is EXCUSED', async ({ page: p }) => {
    await p.setContent(page({ scrolls: true, fixedChrome: true, sibling: false }));
    // Put the control under the chrome by scrolling it down there.
    await p.evaluate(() => {
      const el = document.querySelector('.target') as HTMLElement;
      el.style.top = `${window.innerHeight - 60}px`;
    });
    const r = await p.evaluate(DECIDE, { reachNeeded: REACH });
    expect(r.reachablePx, 'the chrome really is covering it').toBeLessThan(REACH * 2);
    expect(r.excused, 'the player can scroll it out, so this is not a defect').toBe(true);
    expect(r.reported).toBe(false);
  });

  test('3. partly under fixed chrome with its centre clear is EXCUSED', async ({ page: p }) => {
    await p.setContent(page({ scrolls: true, fixedChrome: true, sibling: false }));
    await p.evaluate(() => {
      const el = document.querySelector('.target') as HTMLElement;
      // Footer begins 120px above the bottom. The centre is still clear, but
      // the lower half of the required 44px thumb band crosses into it. Model
      // the 106px lobby campaign control that exposed this exact case.
      el.style.height = '106px';
      el.style.top = `${window.innerHeight - 185}px`;
    });
    const r = await p.evaluate(DECIDE, { reachNeeded: REACH });
    expect(r.reachablePx).toBeGreaterThan(0);
    expect(r.reachablePx).toBeLessThan(REACH * 2);
    expect(r.excused).toBe(true);
    expect(r.reported).toBe(false);
  });

  test('4. under fixed chrome on a page that CANNOT scroll is REPORTED', async ({ page: p }) => {
    await p.setContent(page({ scrolls: false, fixedChrome: true, sibling: false }));
    await p.evaluate(() => {
      const el = document.querySelector('.target') as HTMLElement;
      el.style.position = 'fixed';
      el.style.top = `${window.innerHeight - 60}px`;
    });
    const r = await p.evaluate(DECIDE, { reachNeeded: REACH });
    expect(r.excused, 'there is nowhere to scroll to, so it must not be excused').toBe(false);
    expect(r.reported, 'a control pinned under chrome with no way out is a real defect').toBe(true);
  });

  test('5. overlapped by an ORDINARY sibling is REPORTED, not excused', async ({ page: p }) => {
    /* This is the club-identity case: the paragraph above the button was
       winning the hit test. A sibling is not chrome and scrolling does not
       help, so the exclusion must not reach it. */
    await p.setContent(page({ scrolls: true, fixedChrome: false, sibling: true }));
    const r = await p.evaluate(DECIDE, { reachNeeded: REACH });
    expect(r.excused, 'a sibling overlap is a real defect and may never be excused').toBe(false);
    expect(r.reported).toBe(true);
  });

  test('the sweep still contains the rule these beats model', () => {
    /* The rule lives inside a page.evaluate callback in the sweep, so it cannot
       be imported and shared. If it is ever removed or rewritten, these beats
       would keep passing against a copy that no longer ships - so read the real
       file and fail loudly instead. */
    const src = readFileSync(
      resolve(process.cwd(), 'tests/e2e/mobile-tap-targets.spec.ts'),
      'utf8'
    );
    expect(src, 'the sweep no longer computes whether the page scrolls').toContain('pageScrolls');
    expect(src, 'the sweep no longer asks whether the blocker is fixed chrome').toContain(
      'firstBlockersAreFixedChrome'
    );
    expect(src, 'the fixed-chrome exclusion no longer records an unmeasured control').toContain(
      'under fixed chrome'
    );
  });
});
