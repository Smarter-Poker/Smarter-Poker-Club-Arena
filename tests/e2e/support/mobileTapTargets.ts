/** Browser-side measurement shared by the live audit and its real DOM regressions. */
export async function measureMobileTapTargets({ REACH }: { REACH: number }) {
  const root = document.querySelector('#main-content') || document.body;
  const out: Array<{ sel: string; text: string; boxH: number; reachablePx: number }> = [];
  const unmeasured: string[] = [];
  let n = 0;

  for (const el of root.querySelectorAll('button, a[href], [role="button"]')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
    // Controls inside a fixed layer are chrome (nav bars, parked drawers).
    let p: Element | null = el;
    let inFixed = false;
    while (p && p !== root) {
      if (getComputedStyle(p).position === 'fixed') {
        inFixed = true;
        break;
      }
      p = p.parentElement;
    }
    if (inFixed) continue;

    let b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    // Must be on screen to be probed at all.
    if (b.bottom <= 0 || b.top >= window.innerHeight) continue;
    // A horizontal rail can clip a button whose centre is still inside the
    // viewport. The adjacent Filters control then wins the probe. Reveal each
    // scroll-reachable button before measuring; never excuse a genuine overlap.
    for (
      let ancestor = el.parentElement;
      ancestor && ancestor !== root;
      ancestor = ancestor.parentElement
    ) {
      const overflow = getComputedStyle(ancestor).overflowX;
      if (
        !['auto', 'scroll'].includes(overflow) ||
        ancestor.scrollWidth <= ancestor.clientWidth + 1
      )
        continue;
      const clip = ancestor.getBoundingClientRect();
      const left = clip.left + ancestor.clientLeft;
      const right = left + ancestor.clientWidth;
      if (b.left < left || b.right > right) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        b = el.getBoundingClientRect();
      }
    }
    if (b.right <= 0 || b.left >= window.innerWidth) continue;

    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;

    /* A control has to be far enough inside the viewport for the whole
     44px band to be probed, or the measurement is meaningless: this
     walks outward from the centre and `document.elementFromPoint`
     returns null for any y outside the viewport, which reads exactly
     like a control buried under an overlay.

     That is not a hypothetical. On 2026-08-25 the live audit reported
     `hand-history: button.replay-btn box 44px, reachable 0px` - a
     button that already carries `min-height: 44px` and is perfectly
     hittable. Measured on production: its box was at y=798 in an
     812px viewport, so its centre sat at y=820, off the bottom edge,
     and the very first probe came back null. It was the last row of a
     scrolling list; scroll down and it is a 44px target like any
     other.

     So say so instead of accusing it. A control the sweep could not
     measure is recorded and excluded - never counted as a pass, and
     never reported as a miss. */
    if (
      cy - REACH < 1 ||
      cy + REACH > window.innerHeight - 1 ||
      cx < 1 ||
      cx > window.innerWidth - 1
    ) {
      unmeasured.push(
        el.tagName.toLowerCase() +
          (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : '') +
          ' (centre off-screen, not probed)'
      );
      continue;
    }

    n += 1;

    const inFixedLayer = (node: Element | null) => {
      let q: Element | null = node;
      while (q) {
        if (getComputedStyle(q).position === 'fixed') return true;
        q = q.parentElement;
      }
      return false;
    };

    /* Walk outward from the centre and find how far the control still
     wins the hit test. Record WHO wins the first failed probes: a
     large campaign button can keep its centre while its lower thumb
     band is already behind the fixed footer. Looking only at centre
     mislabeled that scroll-reachable state as a broken control. */
    let reach = 0;
    let firstBlockersAreFixedChrome = false;
    for (let d = 0; d <= REACH; d += 4) {
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

    /* ── OCCLUDED BY FIXED CHROME ON A PAGE THAT STILL SCROLLS ────────
     Added 2026-08-30, from this suite's first complete post-deploy
     run. It reported `friends: button.fr-challenge-btn box 21px,
     reachable 0px` — a control that is 42px reachable four rows
     higher on the same page. Measured live: the friends list holds
     376 Challenge buttons, and the fifth one down happens to sit
     UNDER the fixed bottom nav on first paint. Scroll two lines and
     it is a normal target.

     That is the same situation the "centre off-screen" exclusion
     above already handles, arriving through a different door: the
     sweep cannot see the control from where the page currently
     stands, and the player can. Reporting it is an accusation
     against a control that is fine, and a suite that does that on
     every long list is a suite everyone learns to ignore.

     Narrow on purpose. It only excuses a control when BOTH hold:
     what wins the hit test is inside a `position: fixed` layer (so
     it is chrome, not a sibling that overlaps it — that IS a real
     defect and still fails), and the document can still be scrolled
     (so the player has a way to bring it out). A control pinned
     under fixed chrome on a page that cannot scroll has nowhere to
     go and is still reported. */
    const pageScrolls =
      document.documentElement.scrollHeight > window.innerHeight + 1 ||
      document.body.scrollHeight > window.innerHeight + 1;
    if (reachablePx < REACH * 2 && pageScrolls && firstBlockersAreFixedChrome) {
      unmeasured.push(
        el.tagName.toLowerCase() +
          (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : '') +
          ' (under fixed chrome; scrollable, so the player can reach it)'
      );
      continue;
    }

    if (reachablePx < REACH * 2) {
      out.push({
        sel:
          el.tagName.toLowerCase() +
          (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : ''),
        text: (el.textContent || '').trim().slice(0, 24).replace(/\s+/g, ' '),
        boxH: Math.round(b.height),
        reachablePx,
      });
    }
  }
  return { out, n, unmeasured };
}
