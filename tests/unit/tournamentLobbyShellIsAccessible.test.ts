/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TOURNAMENT LOBBY SHELL - the tablist must be a real tablist
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found 2026-08-26 auditing the seven tabs. The strip declared
 * `role="tablist"` with `role="tab"` children and implemented none of the
 * pattern that declaration promises.
 *
 * That is WORSE than plain buttons. A screen reader reads the role and
 * announces "tab, 3 of 7", which tells the player arrow keys will move between
 * them - and then the arrow keys did nothing, every tab was its own tab stop,
 * and the panel announced itself as an unnamed "tab panel" because it carried
 * no `aria-labelledby`. Claiming a widget you have not built sends someone
 * looking for controls that are not there.
 *
 * The pattern, per WAI-ARIA:
 *   - exactly ONE tab is tabbable (tabIndex 0), the rest are -1
 *   - Left/Right move between tabs and WRAP at the ends
 *   - Home/End jump to first/last
 *   - each tab points at the panel with aria-controls, and the panel points
 *     back with aria-labelledby, so the panel announces which tab it belongs to
 *
 * These assertions read the source rather than rendering, deliberately: the
 * page needs a router, an auth session, a supabase client and a live
 * tournament row to mount, and none of that makes the ARIA contract any more
 * or less true.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(
  join(process.cwd(), 'src/pages/tournament/TournamentDetails.tsx'),
  'utf8'
);
const SHARED_CSS = readFileSync(join(process.cwd(), 'src/styles/tournament-lobby-3d.css'), 'utf8');

describe('the tab strip implements the tablist pattern it declares', () => {
  it('still declares the roles (if these go, the rest of this file is moot)', () => {
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('role="tab"');
    expect(PAGE).toContain('role="tabpanel"');
  });

  it('has exactly one tabbable tab - roving focus, not seven tab stops', () => {
    expect(PAGE).toContain('tabIndex={activeTab === tab.id ? 0 : -1}');
  });

  it('moves with Left and Right and WRAPS at both ends', () => {
    expect(PAGE).toContain("e.key === 'ArrowRight'");
    expect(PAGE).toContain("e.key === 'ArrowLeft'");
    // Wrapping is the half everyone forgets: last -> first, first -> last.
    expect(PAGE).toMatch(/ArrowRight'\)\s*next = i === last \? 0 : i \+ 1/);
    expect(PAGE).toMatch(/ArrowLeft'\)\s*next = i === 0 \? last : i - 1/);
  });

  it('supports Home and End', () => {
    expect(PAGE).toContain("e.key === 'Home'");
    expect(PAGE).toContain("e.key === 'End'");
  });

  it('actually moves focus, not just selection', () => {
    // Changing activeTab alone leaves focus on a tab that is now tabIndex -1.
    expect(PAGE).toContain('tabRefs.current[next]?.focus();');
    expect(PAGE).toContain('const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);');
  });

  it('does not swallow keys it has no opinion about', () => {
    // preventDefault must be reached ONLY after a handled key matched,
    // otherwise Tab and typing are broken inside the strip.
    expect(PAGE).toMatch(/if \(next === -1\) return;\s*e\.preventDefault\(\);/);
  });

  it('wires the tabs and the panel to each other by id', () => {
    expect(PAGE).toContain('id={`tl-tab-${tab.id}`}');
    expect(PAGE).toContain('aria-controls="tl-tabpanel"');
    expect(PAGE).toContain('id="tl-tabpanel"');
    // The panel names itself after whichever tab is selected, so it announces
    // "Ranking, tab panel" rather than an anonymous "tab panel".
    expect(PAGE).toContain('aria-labelledby={`tl-tab-${activeTab}`}');
  });

  it('marks the selected tab', () => {
    expect(PAGE).toContain('aria-selected={activeTab === tab.id}');
  });
});

describe('the shared 3D layer does not defeat its own affordances', () => {
  it('shows a real focus ring on an interactive row', () => {
    /* This suppressed the outline and leaned on a border tint, which is
       invisible on a row that is ALREADY tinted - the hero row, an agent's
       downline row - i.e. exactly the rows worth tabbing to. */
    const rule = SHARED_CSS.slice(
      SHARED_CSS.indexOf('.tl-row--interactive:focus-visible'),
      SHARED_CSS.indexOf('.tl-row--interactive:active')
    );
    expect(rule, 'the focus ring was removed again').not.toMatch(/outline:\s*none/);
    expect(rule).toMatch(/outline:\s*2px solid/);
    expect(rule, 'an outline flush against the bevel reads as part of it').toMatch(
      /outline-offset/
    );
  });

  it('pulses something that is actually visible on a tl-row', () => {
    /* `.tl-row` paints an ~88% opaque gradient, so animating background-color
       underneath it barely reaches the eye - RankingTab had to override the
       whole rule locally to get a legible pulse, which is the tell. Animate
       the rim: nothing covers a border. */
    const kf = SHARED_CSS.slice(
      SHARED_CSS.indexOf('@keyframes tlPulse'),
      SHARED_CSS.indexOf('.tl-pulse {')
    );
    expect(kf, 'back to an invisible background pulse').not.toMatch(/background-color/);
    expect(kf).toMatch(/border-color/);
  });

  it('still turns the pulse off for prefers-reduced-motion', () => {
    const reduced = SHARED_CSS.slice(SHARED_CSS.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('.tl-pulse');
    expect(reduced).toContain('animation: none;');
  });
});

describe('tabProps depends on what it reads', () => {
  it('lists isWatchable, not isRunning', () => {
    /* The body reads `isWatchable` (LATE_REG is watchable; RUNNING alone does
       not cover it) while the dep array listed `isRunning`. It survived only
       because the `tournament` object identity changes on a status transition
       and re-runs the memo anyway - luck, not a guarantee. */
    const memo = PAGE.slice(PAGE.indexOf('const tabProps'), PAGE.indexOf('if (isLoading)'));
    expect(memo).toContain('onWatchPlayer: isWatchable ? watchTable : undefined');
    const deps = memo.slice(memo.lastIndexOf('    ['));
    expect(deps, 'the memo reads isWatchable but does not depend on it').toContain('isWatchable');
  });
});
