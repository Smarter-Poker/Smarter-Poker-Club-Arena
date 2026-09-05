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
    // layout. It reads 164 with the wallet's two fixes included; it was 242 on
    // the old basis and 256 when this law was written.
    //
    // 2026-09-05, fourth pass: 161. Two came off by DELETING rather than
    // scoping - VIPUpgradeModal.css and VIPProgressRing.css were exported from
    // the vip barrel and rendered nowhere, so half of each collision was a
    // stylesheet no page ever loaded. A dead stylesheet is still a live
    // collision, because the bundler ships whatever the barrel re-exports.
    // The number also had 2 of slack against reality when it was last set;
    // this closes that, so the next regression is caught by one, not three.
    //
    // This is a ratchet, not a target: it may fall, never rise. Fixing one is
    // two lines - scope it to its container, or delete the sheet if nothing
    // renders it.
    // LOWER THIS NUMBER when you fix some; never raise it to make CI pass.
    let leakable = 0;
    for (const byFile of owners.values()) {
      if (byFile.size < 2) continue;
      const declared = [...byFile.values()];
      const union = new Set(declared.flatMap((s) => [...s]));
      if ([...union].some((p) => declared.some((s) => !s.has(p)))) leakable += 1;
    }
    // 2026-09-05, fourth pass: 161, MEASURED after the merge rather than
    // inferred from it. The branch had ratcheted to 162 and main to 161, and
    // subtracting the wallet's two fixes from main's number would have given
    // 159 - wrong, because main already counted them. A ratchet resolved by
    // arithmetic is a ratchet set below what the tree can actually hold, and
    // it fails on somebody else's commit.
    //
    // The merge rule, either way: take the LOWER of the two sides. Both only
    // ever move down, so picking the higher hands back ceiling already earned.
    // 2026-09-05, fifth pass: 155, and this one was earned rather than merged.
    // src/components/notifications/NotificationCenter.css and
    // src/components/social/NotificationCenter.css were ORPHANS - two files of
    // the same name, in different folders, imported by nothing (the real
    // src/pages/NotificationCenter.tsx imports no stylesheet at all). They were
    // still colliding with each other and with their neighbours on bare
    // `.notification-backdrop`, `.notification-header` and `.close-btn`, so
    // dead code was holding six leak pairs on the books. Deleting both took the
    // measured count from 161 to 155.
    //
    // They were last edited on 2026-08-29 by a sweeping hover removal that
    // changed them mechanically without noticing that nothing loads them -
    // which is how an orphan survives: every pass treats it as real.
    expect(leakable).toBeLessThanOrEqual(155);
  });
});
