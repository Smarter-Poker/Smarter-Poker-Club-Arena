/**
 * LAW: IN THE CLUB ARENA, A PLAYER IS CALLED BY THEIR POKER ALIAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
 * POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
 *
 * He had said it twice before - 2026-08-23 ("IM DAN BEKAVAC ON SOCIAL AND
 * KINGFISH IN THE CLUB ARENA. NOTHING ELSE.") and again on 2026-09-02 about
 * the club card - and both times the fix landed on ONE screen while forty
 * others went on printing legal names.
 *
 * WHY A LAW AND NOT A CODE REVIEW
 *
 * The defect never looked like a defect. It looked like `a || b`, written
 * independently in about ninety places, each one locally reasonable. Measured
 * against production on the day this landed:
 *
 *   - `display_name` is an exact copy of `full_name` on 264 of 1,308 profiles,
 *     and `use_real_name` is true on 0 of them. Nobody opted in.
 *   - 18,873 rows of `tournament_players.username` held a player's full name.
 *   - 24 of 29 bad-beat jackpot hits scrolled a real name across the ticker.
 *   - `fn_search_players` searched `alias` and answered with `display_name`.
 *
 * TWO FAILURE MODES, TWO CHECKS. The obvious one is rendering a raw column.
 * The quiet one is asking for the wrong COLUMNS: `playerDisplayName` resolves
 * `alias -> username -> display_name`, so a query that selects only
 * `display_name, username` degrades silently to the username - which is
 * itself the full name on 137 rows. That happened for real during this very
 * sweep: ClubDetailPage's render was converted while its select was not, and
 * the screen looked fixed while still leaking. Hence the second check.
 *
 * TO ADD A NEW SCREEN THAT SHOWS A NAME: select PLAYER_NAME_COLUMNS, render
 * playerDisplayName(row). That is the whole contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

/** Comments describe the bug; they must not BE the bug. Strip before scanning. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({
  path: relative(ROOT, f).split('\\').join('/'),
  body: code(readFileSync(f, 'utf8')),
}));

/**
 * THE SURVIVORS, each one checked and each one NOT a profiles name.
 *
 * This list is deliberately small and deliberately annotated. A new entry is
 * not a formality: it is a claim that the `display_name` in question does not
 * belong to a person's profile, or has already been resolved upstream. If you
 * cannot say which, you are looking at the bug this law exists to catch.
 */
const RENDER_EXEMPT: Record<string, string> = {
  // `chat_messages.display_name` - a per-message snapshot, not a profile
  // column. What gets written into it comes from ClubDashboard, which resolves
  // through playerDisplayName before passing it down.
  'src/components/club/ClubChat.tsx': 'chat_messages column, fed by a resolved prop',

  // `club_members.display_name` / `.nickname` - the club's own nickname for a
  // member, a different column on a different table.
  'src/pages/CashierPage.tsx': 'club_members nickname columns',

  // These four BUILD a profile record out of auth metadata at sign-up. They
  // are writers, not renderers. (They are also how `display_name` comes to
  // hold `full_name` in the first place - see the note at the bottom.)
  'src/core/IdentityDNA.ts': 'writes the identity record',
  'src/components/auth/AuthGuard.tsx': 'writes the identity record',
  'src/hooks/useAuthUser.ts': 'writes the identity record',
  'src/stores/useUserStore.ts': 'carries the raw columns so the resolver can read them',

  // Writes the player's real name into the profile, on purpose. That is the
  // column's legitimate job; the arena simply must not READ it.
  'src/components/modals/CompleteProfileModal.tsx': 'writes the real name deliberately',

  // Server-resolved: these read `display_name` out of an RPC that now returns
  // fn_arena_name (migrations 20260903120000 / 121000 / 121500). The field
  // name is the RPC's contract; the value is already the alias.
  'src/components/modals/FindPlayerModal.tsx': 'fn_search_players returns the arena name',
  // Same contract: /search consumes fn_search_players for players since 2026-09-05.
  'src/pages/SearchPage.tsx': 'fn_search_players returns the arena name',
  'src/components/union/UnionWalletModal.tsx': 'fn_union_player_directory returns the arena name',
  'src/pages/UnionDashboardPage.tsx': 'fn_union_player_directory returns the arena name',
  'src/pages/ClubDetailPage.tsx': 'fn_list_pending_members returns the arena name',
  'src/pages/club/ClubDashboard.tsx': 'ca_club_members / ca_club_top_players return the arena name',
  'src/pages/AntiCheatPage.tsx': 'reads a map already built through playerDisplayName',
  'src/pages/XMTTPage.tsx': 'reads a field already built through playerDisplayName',
};

const SELECT_EXEMPT: Record<string, string> = {
  'src/components/club/ClubChat.tsx': 'selects chat_messages, not profiles',
  'src/pages/CashierPage.tsx': 'selects club_members, not profiles',
  'src/core/IdentityDNA.ts': 'identity record store',
  'src/services/ProfileService.ts': 'data layer: returns the raw profile record',
  'src/pages/SettingsPage.tsx': 'the screen where you EDIT your own real name',
  // A lookup key, not a rendered name: "add friend by username" matches on the
  // column and never displays it.
  'src/components/social/FriendListPanel.tsx': 'username lookup, renders nothing',
  'src/pages/AuthPage.tsx': 'sign-up existence check',
  // Horse orchestration: creates, seats and rotates the fleet. Legitimate
  // horse plumbing under CLAUDE.md 10.5, and neither query renders a name.
  'src/services/HorseOrchestrator.ts': 'fleet orchestration, renders nothing',
};

describe('the arena is always the alias', () => {
  it('no Club Arena source renders a raw profile-name chain', () => {
    /* `x.display_name || y` is the shape of the bug: ninety hand-rolled
       fallback chains, each one locally reasonable, collectively printing
       legal names across the platform. */
    const offenders: string[] = [];
    for (const { path, body } of FILES) {
      if (RENDER_EXEMPT[path]) continue;
      const hits = body.match(/[\w?.[\]]*\bdisplay_name\s*\|\|/g);
      if (hits) offenders.push(`${path} (${hits.length})`);
    }
    expect(
      offenders,
      'Render the name with playerDisplayName(row) instead. If this display_name ' +
        'is NOT a profiles column (a chat snapshot, a club nickname, an RPC that ' +
        'already resolved it), add it to RENDER_EXEMPT above WITH THE REASON.'
    ).toEqual([]);
  });

  it('every profiles query that wants a name asks for all the name columns', () => {
    /* THE QUIET HALF OF THIS BUG. playerDisplayName resolves
       alias -> username -> display_name. Hand it a row selected as
       'display_name, username' and it cannot see the alias, so it answers with
       the username - which IS the full name on 137 production rows. The screen
       looks fixed and is not. */
    const offenders: string[] = [];
    for (const { path, body } of FILES) {
      if (SELECT_EXEMPT[path]) continue;
      const hits = body.match(/\.select\(\s*['"][^'"]*\bdisplay_name\b[^'"]*['"]/g);
      if (hits) offenders.push(`${path} (${hits.length})`);
    }
    expect(
      offenders,
      'Use .select(`id, ${PLAYER_NAME_COLUMNS}, ...`) so the alias is actually ' +
        'fetched. A quoted literal listing display_name means the resolver will ' +
        'silently fall through to the username.'
    ).toEqual([]);
  });

  it('the resolver still refuses the real name on an arena surface', () => {
    const resolver = readFileSync(join(SRC, 'utils', 'playerDisplayName.ts'), 'utf8');
    // The arena branch resolves the handle first and never consults the
    // real-name preference. Both are load-bearing; the behavioural cases live
    // in tests/unit/playerDisplayName.test.ts.
    expect(code(resolver)).toContain('handleName(p) || pseudonymousDisplayName(p) || FALLBACK');
    expect(resolver).toContain('PLAYER_NAME_COLUMNS');
  });

  it('Postgres resolves the arena name the same way the client does', () => {
    /* The client was corrected on 2026-08-23 and Postgres was not, so three
       SQL resolvers went on disagreeing with it and with each other for ten
       days - two of them naming full_name outright as a fallback. The
       migration below is what made them agree. */
    const migrations = join(ROOT, 'supabase', 'migrations');
    const resolver = readdirSync(migrations).find((f) => f.includes('the_arena_name_is_the_alias'));
    expect(
      resolver,
      'supabase/migrations/*the_arena_name_is_the_alias* defines public.fn_arena_name, ' +
        'which every Club Arena RPC resolves names through. Do not delete it.'
    ).toBeTruthy();
    const sql = readFileSync(join(migrations, resolver!), 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_arena_name');
    // display_name is allowed through ONLY when it is not the real name.
    expect(sql).toContain('lower(btrim(p_display_name)) = lower((SELECT rn FROM real_name))');
  });

  it('the LAST migration to define fn_search_players still resolves the arena name', () => {
    /* THIS CHECK EXISTS BECAUSE IT ALREADY HAPPENED, the same afternoon.
       20260903120000 taught fn_search_players to answer with the arena name.
       20260902214500 (trigram search + affiliations - a good change, written
       on another branch against the older body) replaced the whole function
       and went back to emitting p.display_name. It was applied to production
       AFTER the fix, so Find Player was answering with real names again and
       nothing said a word.

       Neither agent did anything wrong locally, which is exactly why a person
       cannot be the check here. Whoever rewrites this function next gets told
       by CI: keep fn_arena_name in the payload, or your migration is the one
       that undid it. */
    const dir = join(ROOT, 'supabase', 'migrations');
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        /CREATE OR REPLACE FUNCTION\s+public\.fn_search_players|proname\s*=\s*'fn_search_players'/.test(
          readFileSync(join(dir, f), 'utf8')
        )
      )
      .sort();
    expect(defining.length, 'no migration defines fn_search_players any more').toBeGreaterThan(0);
    const last = defining[defining.length - 1];
    expect(
      readFileSync(join(dir, last), 'utf8'),
      `${last} is the newest migration touching fn_search_players and it does not mention ` +
        'fn_arena_name. A rewrite that drops the resolver silently re-leaks every player’s ' +
        'real name into search results. Emit fn_arena_name(...) as display_name.'
    ).toMatch(/fn_arena_name/);
  });

  it('the "show real name" toggle no longer claims to change the felt', () => {
    /* It writes profiles.use_real_name, which the SOCIAL branch still honours,
       so the preference is real and stays. What changed is its reach: the
       arena ignores it. A toggle that promises to rename the seat above your
       stack, and cannot, is worse than no toggle. */
    const tableMenu = readFileSync(join(SRC, 'components', 'table', 'TableMenu.tsx'), 'utf8');
    expect(code(tableMenu)).toContain("label: 'Social Name'");
    const hamburger = readFileSync(
      join(SRC, 'components', 'navigation', 'HamburgerMenu.tsx'),
      'utf8'
    );
    expect(code(hamburger)).toContain('Show Real Name On Social');
    // ...and the header name is resolved unconditionally.
    expect(code(hamburger)).not.toContain('prefUseRealName');
  });

  it('a partial hydration cannot erase the alias the full load established', () => {
    /* THE HALF THE 2026-09-02 SWEEP MISSED, and Dan saw it the next day:
       "IT SHOULD SAY THE POKER ALIAS (KingFish) NOT DAN BEKAVAC."

       Adding `alias` to loadProfile's select was necessary and not sufficient,
       because `setUser` REBUILT the stored user from its argument. Five call
       sites pass a partial carrying only id/username/display_name/avatar_url
       off the JWT, and one of them - IdentityDNA's background profile load -
       lands AFTER loadProfile. So the sequence was: alias arrives, alias is
       wiped, the resolver falls through to `display_name`, and `display_name`
       is the legal name on 264 of 1,308 rows, this account among them.

       The store merges over the previous row for the same id now, which is
       what makes the ordering stop mattering, so that is what is pinned. */
    const store = code(readFileSync(join(SRC, 'stores', 'useUserStore.ts'), 'utf8'));
    expect(store).toContain('const previous = get().user;');
    expect(store).toMatch(/previous && previous\.id === userData\.id \? previous : \{\}/);
    for (const field of [
      'alias',
      'first_name',
      'last_name',
      'full_name',
      'display_name_preference',
      'use_real_name',
    ]) {
      expect(store, `${field} must be merged, not read off userData alone`).toContain(
        `${field}: pick('${field}')`
      );
    }
  });

  it('no hydration path files a real name under display_name', () => {
    /* `display_name` is the arena resolver's LAST RESORT, so a legal name
       parked there gets printed at the tables. Three paths used to fold the
       JWT's `full_name` into it - `metadata?.display_name || metadata?.full_name`
       - which is both the first-paint leak and the mechanism by which 264
       profiles came to hold their own legal name in that column. The real name
       goes in `full_name` now, where the resolver recognises and refuses it. */
    for (const rel of [
      'core/IdentityDNA.ts',
      'components/auth/AuthGuard.tsx',
      'hooks/useAuthUser.ts',
    ]) {
      const body = code(readFileSync(join(SRC, rel), 'utf8'));
      expect(body, `${rel} still folds a real name into display_name`).not.toMatch(
        /display_name:\s*(metadata|user_metadata)\?\.display_name\s*\|\|\s*(metadata|user_metadata)\?\.full_name/
      );
      expect(body, `${rel} must carry the real name in full_name`).toMatch(
        /full_name:\s*(metadata|user_metadata)\?\.full_name/
      );
    }
  });

  it('the second profile loader asks for the name columns too', () => {
    /* There are TWO loaders. `useUserStore.loadProfile` was fixed on
       2026-09-02; `IdentityDNA.loadUserProfile` still selected
       `id, username, display_name, avatar_url, tier, ...`, so the write it
       makes into the store could not carry an alias even in principle. It
       imports the shared column list rather than retyping it, so the two
       selects cannot drift apart again. */
    const identity = code(readFileSync(join(SRC, 'core', 'IdentityDNA.ts'), 'utf8'));
    expect(identity).toContain("import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName'");
    expect(identity).toMatch(/\.select\(\s*`id, \$\{PLAYER_NAME_COLUMNS\}/);
    expect(identity).toContain('alias: profile.alias ?? null');
  });
});

/**
 * STILL OPEN, and deliberately not fixed here.
 *
 * 1. CLOSED 2026-09-03, and it was not the small thing this note called it.
 *    "Sign-up seeds display_name FROM full_name (IdentityDNA, AuthGuard,
 *    useAuthUser)" was filed here as a product decision about the World Hub's
 *    identity record. It was not: those three write into THIS app's store on
 *    every load, not only at sign-up, and `setUser` rebuilt the whole user from
 *    each partial - so the write also ERASED the alias the profile load had
 *    just fetched. Deferring it is what left Dan's card reading "Dan Bekavac"
 *    the day after the sweep that was supposed to fix exactly that. All three
 *    now file the real name under `full_name`, and the store merges. Pinned by
 *    the three tests above.
 *
 *    What genuinely remains a World Hub decision is the 264 EXISTING rows whose
 *    `display_name` column already holds a legal name. Nothing reads them on an
 *    arena surface any more (the resolver compares the two and refuses a match),
 *    so they are inert here, and rewriting somebody's stored profile is not a
 *    rendering fix.
 *
 * 2. Three dormant profiles have no alias, no usable display_name, and a
 *    username that IS their full name, so the handle step returns a real name
 *    for them. None is seated or has a tournament row. Suppressing it would
 *    render them nameless while the app still prints "@username" beside search
 *    results, which is an inconsistency rather than a privacy gain.
 *
 * 3. The `home_game` / `home_group` RPC family (56 functions) still selects
 *    display_name. This repo calls none of them - they are World Hub surfaces,
 *    where Dan says the real name belongs. That boundary is the reason they
 *    were left alone, and it is worth re-checking if Club Arena ever starts
 *    calling one.
 */
