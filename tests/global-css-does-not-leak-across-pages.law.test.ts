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
  return out;
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
    // not: that property is the one that crosses pages. 254 such classes remain
    // app-wide (measured 2026-09-05). This is a ratchet, not a target - it may
    // fall, never rise. Fixing one is two lines: scope it to its container.
    let leakable = 0;
    for (const byFile of owners.values()) {
      if (byFile.size < 2) continue;
      const declared = [...byFile.values()];
      const union = new Set(declared.flatMap((s) => [...s]));
      if ([...union].some((p) => declared.some((s) => !s.has(p)))) leakable += 1;
    }
    expect(leakable).toBeLessThanOrEqual(254);
  });
});
