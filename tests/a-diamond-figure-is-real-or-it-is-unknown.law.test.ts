/**
 * LAW: a Diamond figure is real, or it is unknown. It is never a zero we made up.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Created 2026-09-20. The Diamond Arena showed two figures that were not true,
 * and both were wrong in the same direction: they reported an absence of
 * players that nobody had measured.
 *
 * WHAT WAS ACTUALLY BROKEN, read off production on 2026-09-20:
 *
 *  1. The home carousel's ACTIVE count came from
 *     `fn_batch_club_realtime_active_counts`, which reaches its seats through
 *
 *         JOIN public.club_members cm ON cm.club_id = requested.club_id
 *          AND (cm.status IS NULL OR cm.status IN ('active','approved'))
 *
 *     Diamond membership is an ENTITLEMENT, not a roster: the arena holds
 *     exactly ONE `club_members` row and its status is `automatic`. That join
 *     matches nobody, so the count was STRUCTURALLY 0 - not a measurement that
 *     happened to be zero, an arithmetic certainty, for every player, on every
 *     load, however many people were seated. (`clubs.member_count` for the
 *     arena is 0 as well, so the `Math.min` clamp above it was clamping a
 *     figure against a ceiling that means nothing here.)
 *
 *  2. In the lobby, `get_club_home` short-circuits for a diamonds arena at its
 *     line 26 with `{found, access_only, arena_context}` and carries no
 *     `players_playing` key at all. `ClubHomePage` therefore left the figure
 *     null, and `ClubIdentityCard` rendered null as the string "0".
 *
 *  3. `lobbyFigureCache` then filed that 0 as "the last known figure" and
 *     served it back on the next visit, so a later read that genuinely could
 *     not answer found a confident zero already waiting for it.
 *
 * Each of those folds "I could not tell" into "nobody is playing", which
 * CLAUDE.md 10.86 rule 1 forbids by name. The arena has 17 live tables; a
 * player looking at ACTIVE 0 was being told something false about the room.
 *
 * WHAT THIS LAW PINS:
 *
 *  - no Diamond count is derived from `club_members`;
 *  - the count comes from a live-seat read;
 *  - an unreadable figure renders as an unknown, never as `0`;
 *  - the figure cache never SERVES a zero as a known figure (it still stores
 *    one: a game card's "0 of 6 seated" is a real measurement).
 *
 * The three-valued contract itself lives in `src/lib/countFigure.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Comments describe the defect; only code may be judged for committing it. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

describe('a Diamond figure is real or it is unknown', () => {
  describe('no Diamond count is derived from club_members', () => {
    /* The batch RPC is fine for a chip club, where membership IS the roster.
       It may never be the arena's source, and the way that is guaranteed is
       that the arena never reaches the branch which reads it. */
    it('HomePage answers the arena from live seats, not from the membership batch', () => {
      const code = codeOf(read('src/pages/HomePage.tsx'));

      expect(
        code,
        'the arena must be answered by a live-seat read (get_club_players_playing)'
      ).toContain('get_club_players_playing');

      /* The entitlement branch must return BEFORE the batch active-count map
         is consulted, or the structural zero is back. */
      const arenaBranch = code.indexOf('isEntitlementArena');
      const batchRead = code.indexOf('activeCountMap.get(club.id)');
      expect(arenaBranch, 'HomePage must special-case the entitlement arena').toBeGreaterThan(-1);
      expect(batchRead).toBeGreaterThan(-1);
      expect(
        arenaBranch,
        'the entitlement arena must be handled before the club_members-derived count is read'
      ).toBeLessThan(batchRead);
    });

    it('the arena is never clamped against clubs.member_count', () => {
      const code = codeOf(read('src/pages/HomePage.tsx'));
      const arenaStart = code.indexOf('isEntitlementArena');
      const arenaEnd = code.indexOf('const memberCount = memberCountMap.get(club.id)');
      expect(arenaEnd).toBeGreaterThan(arenaStart);
      const arenaBlock = code.slice(arenaStart, arenaEnd);
      expect(
        arenaBlock,
        'a club with no roster has no member ceiling; Math.min against 0 reports an empty room'
      ).not.toContain('Math.min');
    });

    it('the lobby asks for the arena itself, because get_club_home will not tell it', () => {
      const code = codeOf(read('src/pages/ClubHomePage.tsx'));
      expect(code).toContain('get_club_players_playing');
      expect(
        code,
        'a failed arena seat read must say COUNT_UNKNOWN, never fall through to a zero'
      ).toContain('setPlayersPlaying(COUNT_UNKNOWN)');
    });
  });

  describe('null renders as an unknown state, never as 0', () => {
    it('countText gives the three answers three different renderings', async () => {
      const { COUNT_UNKNOWN, COUNT_UNKNOWN_TEXT, countText, isCountUnknown } =
        await import('../src/lib/countFigure');

      expect(countText(7), 'a known figure prints itself').toBe('7');
      expect(countText(0), 'a known zero is still a zero').toBe('0');
      /* Dan: "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS." A first paint has
         not failed at anything, so it is not an unknown. */
      expect(countText(null), 'not yet asked prints the loading zero').toBe('0');
      expect(countText(undefined)).toBe('0');
      expect(countText(COUNT_UNKNOWN), 'a read that could not tell must never print a number').toBe(
        COUNT_UNKNOWN_TEXT
      );
      expect(COUNT_UNKNOWN_TEXT).not.toMatch(/\d/);

      expect(isCountUnknown(COUNT_UNKNOWN)).toBe(true);
      expect(isCountUnknown(0), 'zero is a figure, not an unknown').toBe(false);
      expect(isCountUnknown(null), 'pending is not an unknown either').toBe(false);
    });

    it('neither arena surface turns an unknown back into a zero', () => {
      for (const path of [
        'src/components/club/DiamondArenaCard.tsx',
        'src/components/club-buttons/ClubIdentityCard.tsx',
      ]) {
        const code = codeOf(read(path));
        /* The exact shape that shipped the defect: `x == null ? '0' : ...`.
           Both rails carried one. */
        expect(code, `${path} must not print a literal zero for an absent figure`).not.toMatch(
          /==\s*null\s*\?\s*['"]0['"]/
        );
        expect(code, `${path} must route its count through countText`).toContain('countText');
      }
    });
  });

  describe('the cache never serves a zero as a known figure', () => {
    it('a stored zero never comes back as a figure somebody read', async () => {
      const mod = await import('../src/lib/lobbyFigureCache');
      const { figureOr, isUnknownFigure, readFigures, rememberFigures } = mod;
      mod.resetLobbyFigureCacheForTests();

      expect(isUnknownFigure('0')).toBe(true);
      expect(isUnknownFigure('')).toBe(true);
      expect(isUnknownFigure('0,000')).toBe(true);
      expect(isUnknownFigure('12')).toBe(false);

      /* A zero is still STORED: for a game card "0 of 6 seated" is a real
         measurement, and tests/unit/lobbyFigureCache.test.ts pins that
         deliberately. The rule is about what a zero is worth coming back out. */
      rememberFigures('game:a', { players: 0 });
      expect(readFigures('game:a').players, 'a game card keeps its measured zero').toBe('0');

      /* SERVE SIDE: every browser that has opened the carousel already has a
         "0" for this scope sitting in its localStorage. It must not come back
         as "the last figure we knew". */
      expect(figureOr(null, '0'), 'a cached zero is not a known figure').toBe('0');
      expect(figureOr(null, '0')).toBe(figureOr(null, undefined));
      expect(figureOr(null, '5'), 'a real last known figure is still served').toBe('5');
      expect(figureOr(42, '5'), 'a live figure always wins').toBe('42');

      /* And a card reading the map directly asks the same question. */
      rememberFigures('arena:diamond', { active: 0 });
      expect(isUnknownFigure(readFigures('arena:diamond').active ?? '')).toBe(true);
      rememberFigures('arena:diamond', { active: 1284 });
      expect(isUnknownFigure(readFigures('arena:diamond').active ?? '')).toBe(false);

      mod.resetLobbyFigureCacheForTests();
    });

    it('the arena card only remembers a figure it actually has', () => {
      const code = codeOf(read('src/components/club/DiamondArenaCard.tsx'));
      expect(
        code,
        'COUNT_UNKNOWN is a marker, not a figure: it must never reach the cache'
      ).toMatch(/rememberFigures\([\s\S]{0,160}typeof activePlayers === 'number'/);
      expect(code, 'and a stored zero must not be read back as a last known figure').toContain(
        'isUnknownFigure(cached.active)'
      );
    });
  });
});
