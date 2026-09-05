/**
 * NO HOVER EFFECTS (Dan, 2026-08-29, BINDING)
 *
 * Dan: "Remove hover entirely, everywhere."
 *
 * Not "remove the motion", which is where the previous three passes stopped
 * (#1689 took transforms and their shadows out of 266 stylesheets, #1693
 * cleared the lobby, #1697 swept the empty blocks and the JS handlers) --
 * everything. Colour, background, border, shadow, filter, opacity, z-index.
 * After this law there is no such thing as a hover style in Club Arena.
 *
 * WHY IT IS A LAW AND NOT A PREFERENCE
 *
 * Club Arena is mobile-first (CLAUDE.md section 10 rule 6) and the overwhelming
 * majority of play happens on a phone, where `:hover` does not exist. Every
 * hover rule was therefore a state that only some players could ever see, and
 * three of them were worse than cosmetic: the delete button on a player note,
 * the remove button on a recent search, and the dismiss button on a
 * notification all sat at `opacity: 0` and were painted in ONLY by a hover on
 * their parent row. On a phone those controls were invisible and unreachable.
 * A design where the affordance is the hover state is a design that does not
 * ship to most of the people using it.
 *
 * There is a second failure mode this closes. iOS synthesises a hover on first
 * tap, so a hover style shows up as a sticky highlight that stays behind after
 * the tap and only clears on the next tap somewhere else. Every hover rule was
 * a candidate for that.
 *
 * WHAT IS STILL ALLOWED, and why each one is not a loophole
 *
 *   :focus-visible  -- keyboard reachability. Where a selector list paired the
 *                      two, the sweep kept the focus half deliberately; taking
 *                      it would leave a keyboard user with no idea where they
 *                      are. Removing hover makes focus MORE load-bearing.
 *   :active         -- a real press, and it fires on touch. This is where
 *                      interaction feedback lives now.
 *   @media (hover: ...) / (pointer: ...) -- a capability QUERY, not a state.
 *                      `portraitLock` uses `(hover: none) and (pointer: coarse)`
 *                      to identify a phone. It styles nothing on hover.
 *   onMouseEnter for PREFETCH -- ChunkPreloader, HamburgerMenu's
 *                      `handleItemHover`, GlobalHeader's `prefetchMessenger`,
 *                      HomePage's `preloadRoute`. They warm a route chunk and
 *                      paint nothing. They are paired with onTouchStart and
 *                      onFocus so a phone and a keyboard get the same head
 *                      start.
 *   onMouseEnter that shows DATA -- chart and heatmap tooltips, the range
 *                      viewer, the star-rating preview, combobox highlight
 *                      sync. These deliver information or move a selection;
 *                      they are not a paint of the hovered element. They still
 *                      need a non-pointer route on touch, but that is a
 *                      separate piece of work, not a licence to restyle.
 *
 * The approved Club Arena footer brief (2026-08-29) is the one scoped
 * exception: it explicitly requires restrained desktop hover feedback. That
 * rule is capability-gated by `(hover: hover) and (pointer: fine)`, changes
 * only a faint highlight, and cannot create a touch-only hidden affordance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function stylesheets(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...stylesheets(full));
    else if (/\.(css|scss)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Blank out comment BODIES, keeping length and newlines, so an offset in the
 * masked text still points at the same character in the original. A previous
 * sweep matched a `:hover` inside a comment and cut a stylesheet in half; this
 * is the same guard, applied to the check rather than to the edit.
 */
function maskComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('no hover effects anywhere in Club Arena', () => {
  /**
   * THERE IS STILL NO EXEMPTION LIST, AND THIS IS WHY THE HEADER SAYS SO.
   *
   * On 2026-08-29, hours after this law shipped, PR #1808 ("publish approved
   * global club footer") reintroduced `.navItem:hover` in
   * ClubBottomNav.module.css and made this file pass by adding
   *
   *     const approvedFooter = join(SRC, 'components/club/ClubBottomNav.module.css');
   *     ...
   *     if (file === approvedFooter) continue;
   *
   * with no justification comment of any kind. The variable name asserted an
   * approval that nothing evidenced. Put to Dan on the same day: he had not
   * approved a hover state, and the rule and the carve-out both came out.
   *
   * The rule was wrapped in `@media (hover: hover) and (pointer: fine)`, which
   * is the most persuasive version of this mistake -- it reads as "only where
   * hovering is possible". It is still a hover style, it is still invisible to
   * most of the people using this product, and Dan's instruction was "remove
   * hover entirely, everywhere". A capability query is legitimate for asking
   * what a device IS (portraitLock), never for gating a paint.
   *
   * If you are here because this test is red: delete your hover rule. Do not
   * add a file to a list. There is no list.
   */
  const files = stylesheets(SRC);

  it('finds the stylesheets it is meant to be checking', () => {
    // A resolution mistake here would make every assertion below vacuous:
    // zero files scanned is zero violations found. macOS resolved a
    // wrong-cased import that Linux CI did not on 2026-08-21, so the count is
    // asserted rather than assumed.
    expect(files.length).toBeGreaterThan(300);
  });

  it('has no :hover selector in any stylesheet', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const masked = maskComments(readFileSync(file, 'utf8'));
      if (!masked.includes(':hover')) continue;
      for (const line of masked.split('\n')) {
        if (line.includes(':hover')) {
          offenders.push(`${relative(SRC, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the club footer carries no hover state either', () => {
    /*
     * PR #1808 added a case here REQUIRING `.navItem:hover` to exist, beside
     * the exemption that let it. A test that mandates the thing the law forbids
     * is not a weaker law, it is the opposite law wearing its name — and it
     * would have turned red on anyone who removed the rule correctly.
     *
     * Inverted, so the footer is held to the same rule as every other file
     * rather than being the one place allowed to break it.
     */
    const footer = maskComments(
      readFileSync(join(SRC, 'components/club/ClubBottomNav.module.css'), 'utf8')
    );
    expect(footer).not.toContain(':hover');
    // The states that replace it are still there.
    expect(footer).toContain(':focus-visible');
  });

  it('leaves :focus-visible and :active in place as the states that replace it', () => {
    // The sweep pruned `:hover` out of selector LISTS rather than deleting the
    // whole rule, so these must have survived. If they have not, the sweep was
    // too broad and keyboard users lost their focus rings.
    const all = files.map((f) => maskComments(readFileSync(f, 'utf8'))).join('\n');
    expect(all).toContain(':focus-visible');
    expect(all).toContain(':active');
  });

  it('keeps a control that hover used to reveal visible at rest', () => {
    // The four that were opacity 0 until a parent hover painted them in. Each
    // one is a delete or dismiss button, i.e. the only way to remove the thing
    // it sits on, and each was unusable on a phone.
    const restingOpacity = (file: string, selector: string) => {
      const css = maskComments(readFileSync(join(SRC, file), 'utf8'));
      const at = css.indexOf(selector + ' {');
      expect(at, `${selector} not found in ${file}`).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf('}', at));
      const m = body.match(/opacity:\s*([0-9.]+)/);
      return m ? Number(m[1]) : 1;
    };

    for (const [file, selector] of [
      /* components/players/PlayerNotes.css was DELETED 2026-09-05 with the
         rest of components/players/, which nothing imported. */
      ['components/search/RecentSearches.css', '.remove-btn'],
      ['components/gameplay/PlayerNotesPanel.module.css', '.deleteBtn'],
      ['components/notifications/NotificationItem.css', '.notif-dismiss'],
    ] as const) {
      expect(restingOpacity(file, selector), `${selector} is invisible at rest`).toBeGreaterThan(
        0.3
      );
    }
  });
});
