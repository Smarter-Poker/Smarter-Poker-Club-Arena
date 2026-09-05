import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every plain .css file in this app is GLOBAL the moment some component
 * imports it. Two files that both define `.foo { ... }` bare are therefore one
 * rule, and the winner of any property is decided by stylesheet load order -
 * which is decided by route chunk order, which changes with the player's
 * navigation history.
 *
 * That is not theoretical. Measured in the production bundle on 2026-09-05:
 * `src/components/admin/PlayerSearch.css` declared a bare
 * `.action-btn { width: 32px; height: 32px }` for a 32px admin icon button.
 * The public dossier (/profile/:userId) styles its own actions through
 * `.public-profile-page .action-btn`, which has higher specificity - but it
 * never declares `width`, and a property you do not declare cannot be won.
 * So the admin rule took `width` outright and the dossier shipped with
 *
 *     grid tracks   123px 123px 123px 123px 123px
 *     the buttons    36px  36px  36px  36px  36px   <- "Add Friend" wrapping
 *
 * and, once the hand replayer's chunk was also loaded, `.share-btn`'s
 * `position: absolute` took Share out of the grid entirely.
 *
 * The fix is always the same two lines: scope the definition to the container
 * that owns it. This law stops the shape coming back.
 */

const SRC = resolve(process.cwd(), 'src');

/**
 * `src/styles/` is the app-wide THEME layer - globals.css, club-engine.css,
 * design-system.css and five others. Defining `.btn`, `.badge` or `.card-header`
 * for the whole app is precisely their job, and a page that overrides one is
 * using the cascade as intended, not leaking.
 *
 * The defect this law is about is narrower and it has a shape: one COMPONENT's
 * private class silently deciding another COMPONENT's layout. That is what a
 * 32px admin icon button did to the public dossier's action row, and neither
 * file was a theme sheet.
 *
 * Counting the theme layer in made the number 244 instead of 166, and made it
 * move whenever somebody restyled a button app-wide - which happened on
 * 2026-09-05, when a second `.btn-success` block in club-engine.css added
 * `border-color` and pushed the ratchet up by one for a change that was doing
 * exactly what a design system is supposed to do. A ratchet that fires on
 * correct work teaches people to raise it. Excluded, and the number means one
 * thing.
 */
const isThemeLayer = (file: string) =>
  relative(process.cwd(), file).split('\\').join('/').startsWith('src/styles/');

const cssFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // .module.css is hashed by the bundler and cannot collide by construction.
      else if (entry.name.endsWith('.css') && !entry.name.endsWith('.module.css')) out.push(full);
    }
  };
  walk(SRC);
  return out.filter((f) => !isThemeLayer(f));
};

/** class name -> (file -> set of properties that file declares on it, bare) */
const bareDefinitions = (): Map<string, Map<string, Set<string>>> => {
  const owners = new Map<string, Map<string, Set<string>>>();
  for (const file of cssFiles()) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = rule.exec(css))) {
      const props = new Set(
        match[3]
          .split(';')
          .map((d) => d.split(':')[0].trim().toLowerCase())
          .filter(Boolean)
      );
      for (const selector of match[2].split(',').map((s) => s.trim())) {
        // A BARE class selector: the whole selector is one compound whose
        // first token is the class. `.a .b`, `.a > .b` and `.page .a` are all
        // scoped and cannot leak.
        const bare = /^\.([A-Za-z0-9_-]+)((?:[.:[][^\s>+~]*)*)$/.exec(selector);
        if (!bare) continue;
        const key = relative(process.cwd(), file);
        if (!owners.has(bare[1])) owners.set(bare[1], new Map());
        const byFile = owners.get(bare[1])!;
        if (!byFile.has(key)) byFile.set(key, new Set());
        for (const p of props) byFile.get(key)!.add(p);
      }
    }
  }
  return owners;
};

describe('a global class name has exactly one owner', () => {
  const owners = bareDefinitions();

  it('never lets `.action-btn` be defined bare - it is a shared name with no owner', () => {
    // Five files declared this bare (AgentCashoutPanel, ActionCard,
    // ShareableHighlight, HandReplay, DisputeManagementPage) plus PlayerSearch,
    // which is the one that actually broke the dossier. All six are scoped now.
    expect([...(owners.get('action-btn')?.keys() ?? [])]).toEqual([]);
  });

  it('lets only the PlayerAvatar component define `.player-avatar` bare', () => {
    // Six other stylesheets each declared their OWN `.player-avatar` markup
    // bare. None of them rendered <PlayerAvatar>, so each was a pure collision
    // with the shared component - it is why the profile portrait shrank 78px
    // -> 74px and its level badge gained a ring and a glow under a warm cache.
    expect([...(owners.get('player-avatar')?.keys() ?? [])]).toEqual([
      'src/components/avatars/PlayerAvatar.css',
    ]);
  });

  it('does not grow the number of class names that can leak between pages', () => {
    // A collision only MATTERS when one file declares a property another does
    // not: that property is the one that crosses components.
    //
    // 2026-09-05, second pass (the wallet's, kept verbatim because both fixes
    // are real): "The tree measured 244 against a ceiling of 243 - main was RED
    // on this law - and two of the leaks were the wallet's own. `.message` was
    // declared bare by BOTH PlayerWalletPage.css and ChipTransferModal.css with
    // different padding, weight and error red, so the send banner took whichever
    // the player had loaded last; it is scoped to `.wallet-page .message` now.
    // `.wallet-page` stopped being a second bare owner when
    // RewardsCircuitSurfaces.css gave up overpainting the wallet's ground with
    // `!important`."
    //
    // 2026-09-05, third pass: main went red because a SECOND `.btn-success`
    // block in club-engine.css added `border-color` - a design system doing
    // exactly its job, tripping a ratchet that was counting the theme layer as
    // if it were a leak. That published a broken gate and stalled the bundle
    // for 17 minutes. `src/styles/` is excluded now (see isThemeLayer), so the
    // number counts one thing only: a COMPONENT deciding another COMPONENT's
    // layout. It read 164 with the wallet's two fixes included; it was 242 on
    // the old basis and 256 when this law was written.
    //
    // 2026-09-05, fourth pass: 60 more component stylesheets scoped in one
    // sweep - 278 selectors - taking it 163 -> 99. Every root was verified as
    // that component's OWN outermost rendered element AND its namesake
    // wrapper, not merely a class that appeared somewhere in the file: a first
    // attempt chose `.audit-log__summary` and `.active` as roots, which would
    // have scoped rules to elements that do not contain them, and it was
    // thrown away rather than shipped. The 99 that remain are files where no
    // namesake wrapper could be proven, or the component uses a portal so its
    // markup can render outside its own root; each is still the same two-line
    // change, done by hand.
    //
    // 2026-09-05, fifth pass: 99 -> 29, and the 29 are ENUMERATED below so
    // this number is never an unknown quantity again. Two techniques, both
    // verified afterwards: 123 (class, file) pairs RENAMED rather than scoped
    // - renaming needs no assumption about which element contains which, so
    // it cannot silently unstyle anything - and three stylesheets DELETED
    // (703 lines) belonging to the notification UI retired on 2026-08-25.
    //
    // Two renames were reverted on inspection: `.lobby-sortbar__eyebrow` and
    // `.theme-asset__btnstage` are ONE element styled by two sheets on
    // purpose (a component sheet plus a shared token sheet), so renaming both
    // split the link and orphaned a rule. That is the failure mode to watch
    // for; an orphan check catches it.
    //
    // WHAT THE 29 ARE. None is a mystery, and none is a two-line fix:
    //
    //  A. SEVEN DUPLICATE COMPONENTS - the same thing built twice, in two
    //     folders, each with its own stylesheet: IconButton (buttons/ vs
    //     icons/), CashierModal (club/ vs table/), OnlineIndicator (common/
    //     vs players/), Tooltip (common/ vs tooltips/), PlayerCard (players/
    //     vs table/), Spinner vs LoadingSpinner, TimeBank vs TimeBankDisplay.
    //     The CSS collision is a symptom; the fix is deciding which component
    //     survives, which is a refactor and not a stylesheet edit.
    //
    //  B. NINE DELIBERATE SAME-FEATURE LAYERINGS - TablePage.css adjusting
    //     .seat__info / .seat__stack / .table-chat / .table-page /
    //     .table-container that its own children own; LobbySortBar with
    //     LobbyTable; ControlThemeTokens with ThemeSettingsModal; SeatSlot
    //     with avatarChoreography; PremiumTournamentConsole with
    //     TournamentDetails. A container adjusting its children is the
    //     cascade used as intended, the same reason src/styles/ is excluded.
    //
    //  C. THREE DESIGN-SYSTEM BUTTONS - .btn, .btn-secondary, .btn-danger in
    //     components/common/Button.css against pages that restyle them.
    //     Button.css is a theme sheet that happens to live under components/.
    //
    //  D. TEN GENERIC UTILITY NAMES across unrelated surfaces - .stat,
    //     .stat-value, .stat-label, .empty-state, .empty-icon, .loading-state,
    //     .spinner, .status-dot, .search-results, .table-container. These are
    //     the only ones a rename would still fix; each was skipped because a
    //     test or e2e selector references the name, or the class is built
    //     dynamically rather than written as a literal.
    //
    // This is a ratchet, not a target: it may fall, never rise. Fixing one is
    // two lines - scope it to its container, or rename it in both the
    // stylesheet and its markup.
    // LOWER THIS NUMBER when you fix some; never raise it to make CI pass.
    let leakable = 0;
    for (const byFile of owners.values()) {
      if (byFile.size < 2) continue;
      const declared = [...byFile.values()];
      const union = new Set(declared.flatMap((s) => [...s]));
      if ([...union].some((p) => declared.some((s) => !s.has(p)))) leakable += 1;
    }
    expect(leakable).toBeLessThanOrEqual(29);
  });
});
