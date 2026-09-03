import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sliceStatement, sliceCall } from '../helpers/sourceWindow';

/**
 * Dan 2026-08-21: "you assign an avatar to every horse, and they use that in
 * the club arena, and their photo for the social media page."
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE
 *
 * `profiles.avatar_url` was one column doing two jobs: the social media profile
 * picture AND the Club Arena avatar. Every attempt to give the Arena an avatar
 * therefore also changed somebody's social picture — which is exactly what
 * happened earlier today, to 17 real accounts, and had to be rolled back.
 *
 * The fix is two columns:
 *   profiles.avatar_url        social media photo. NOT Club Arena's to touch.
 *   profiles.arena_avatar_url  Club Arena avatar. Library art only.
 *
 * That separation is only worth anything if it holds. There were ~60 read sites
 * and 2 write sites across this app; a single `.select('avatar_url')` added next
 * month silently reintroduces the bug on one screen, and a single `.update({
 * avatar_url })` reintroduces it for every player who picks an avatar. Neither
 * fails loudly — the wrong picture just shows up somewhere. So the rule is
 * enforced mechanically rather than remembered.
 */

const ROOT = resolve(__dirname, '../../');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'server/src'))];

/** `clubs.avatar_url` and `unions.avatar_url` are entirely different columns. */
const OTHER_TABLES = /\b(clubs?|unions?|horses)\b/i;

describe('Club Arena never touches the social media photo column', () => {
  it('has no select of profiles.avatar_url that is not aliased to arena_avatar_url', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      const re = /\.from\(\s*['"]profiles['"]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const slice = sliceStatement(src.slice(m.index), '.from(');
        const sel = /\.select\(/.exec(slice);
        if (!sel) continue;
        const intervening = slice.slice(0, sel.index);
        if (/\.(from|update|upsert|insert|delete)\(/.test(intervening)) continue;
        const start = m.index + sel.index + sel[0].length;
        let depth = 1;
        let j = start;
        while (j < src.length && depth) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
          j++;
        }
        const body = src.slice(start, j - 1);
        if (!/\bavatar_url\b/.test(body)) continue;
        // Aliased form `avatar_url:arena_avatar_url` is the correct one for Arena.
        if (/avatar_url\s*:\s*arena_avatar_url/.test(body)) continue;

        // Social Media features are allowed to fetch the real avatar_url
        const relPath = file.replace(ROOT + '/', '');
        if (
          [
            'src/components/social/FriendListPanel.tsx',
            'src/components/social/OnlineFriendsPill.tsx',
            'src/pages/FriendsPage.tsx',
            'src/pages/ProfilePage.tsx',
            'src/services/ProfileService.ts',
            'src/services/FriendSuggestionService.ts',
            // The global header is a World Hub surface embedded in Arena. It
            // intentionally reads both sources and obeys the user's existing
            // use_avatar_as_profile_pic preference; it never writes either.
            'src/stores/useHeaderDataStore.ts',
          ].includes(relPath)
        ) {
          continue;
        }

        offenders.push(`${relPath} -> .select(${body.trim().slice(0, 90)})`);
      }
    }

    expect(
      offenders,
      'These read the SOCIAL MEDIA photo. Use `avatar_url:arena_avatar_url` — ' +
        'aliasing keeps the returned key as `avatar_url`, so no downstream ' +
        'type or component has to change:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('never WRITES profiles.avatar_url from inside Club Arena', () => {
    // The more dangerous half. A bad read shows one wrong picture on one
    // screen; a bad write permanently replaces the player's social media photo.
    const offenders: string[] = [];

    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      const re = /\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,400}?\.(update|upsert|insert)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const tail = sliceCall(src.slice(m.index), `.${m[1]}(`);
        if (/(?<!arena_)\bavatar_url\b\s*:/.test(tail)) {
          offenders.push(`${file.replace(ROOT + '/', '')} -> .${m[1]}({ avatar_url: ... })`);
        }
      }
    }

    expect(
      offenders,
      'Club Arena must write arena_avatar_url. avatar_url is the social media ' +
        'profile picture and belongs to the Hub:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('still reads the engine seat avatar from the Arena column', () => {
    // The single highest-leverage read in the app: it feeds every seat at every
    // table. If this one regresses, the felt shows photographs again.
    const engine = readFileSync(join(ROOT, 'server/src/services/supabase/tables.ts'), 'utf8');
    expect(engine).toMatch(/avatar_url\s*:\s*arena_avatar_url/);
  });

  /**
   * Dan 2026-08-22. The two tests above police the COLUMN NAME. They do not
   * police the WRITE PATH, and that gap had a live occupant:
   * `src/components/avatars/AvatarGenerator.tsx` ran
   * `.from('profiles').update({ arena_avatar_url: selectedImage })` on an
   * AI-image URL straight from a generation endpoint. It named the right
   * column, so it passed — while skipping `normalizeAvatarUrl` and, more to the
   * point, `isLibraryAvatarUrl`, the guard AvatarService exists to be. Its own
   * comment calls a rule that lives only in a component "a locked door in a
   * building with no walls"; this was a second door in the same wall. Nothing
   * mounted the component, so it never fired — which is why it survived.
   *
   * One writer. Anything else that needs to set an Arena avatar calls
   * avatarService.setUserAvatar and gets the normalisation and the guard with it.
   */
  it('has exactly one write path to profiles.arena_avatar_url', () => {
    const offenders: string[] = [];
    const ALLOWED = 'src/services/AvatarService.ts';

    for (const file of FILES) {
      const rel = file.replace(ROOT + '/', '');
      if (rel === ALLOWED) continue;

      const src = readFileSync(file, 'utf8');
      const re = /\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,400}?\.(update|upsert|insert)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/\barena_avatar_url\b\s*:/.test(sliceCall(src.slice(m.index), `.${m[1]}(`))) {
          offenders.push(`${rel} -> .${m[1]}({ arena_avatar_url: ... })`);
        }
      }
    }

    expect(
      offenders,
      `Only ${ALLOWED} may write profiles.arena_avatar_url. It normalises the ` +
        'URL and refuses anything that is not library art; a direct .update() ' +
        'skips both. Call avatarService.setUserAvatar(userId, url) instead:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('leaves clubs and unions avatar_url alone', () => {
    // Guard against an over-eager future sweep. These are club logos and union
    // badges — different tables, different meaning, must keep the plain column.
    const clubsService = readFileSync(join(ROOT, 'src/services/ClubsService.ts'), 'utf8');
    const clubSelects = clubsService
      .split('\n')
      .filter((l) => OTHER_TABLES.test(l) && /avatar_url/.test(l));
    expect(clubSelects.length, 'expected club avatar_url reads to still exist').toBeGreaterThan(0);
    for (const line of clubSelects) {
      expect(line, `club/union avatar_url must NOT be aliased: ${line.trim()}`).not.toMatch(
        /avatar_url\s*:\s*arena_avatar_url/
      );
    }
  });
});
