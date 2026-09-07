/**
 * LAW: the felt reads ONE avatar column, and every reader names the same one.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan 2026-09-07: "WHEN A USER CHANGES THEIR AVATAR, IT BOUNCES BACK AND
 * FORTH FROM THEIR OLD AVATAR TO THE NEW ONE. IT NEEDS TO CHANGE AND STAY
 * ACROSS ALL GAMES AND TABLES REGARDLESS OF DEVICE AS WELL."
 *
 * Two readers feed a seat's face: the engine's roster load (`loadSeatedPlayers`,
 * published on every snapshot) and the client's live profile sync
 * (`useSeatedProfileSync`, delivered on every `profiles` UPDATE). If those two
 * ever named DIFFERENT columns, every engine broadcast would paint one picture
 * and every realtime event the other - the bounce, with a second cause that
 * no test would see. On 2026-09-07 they agreed (both `arena_avatar_url`) and
 * the bounce had a timing cause instead (`src/lib/seatIdentityOverrides.ts`).
 * This law keeps the column half from ever becoming a cause.
 *
 * It is enforced by IMPORTING both copies of the rule, not by grepping for a
 * string: the client `src/lib/tableAvatar.ts` and the engine mirror
 * `server/src/services/supabase/tableAvatar.ts` must export identical
 * constants, the engine roster read must select through the mirror, and the
 * sync must read the column through the client helper.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as client from '../src/lib/tableAvatar';
import * as engine from '../server/src/services/supabase/tableAvatar';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('LAW: the felt reads one avatar column', () => {
  it('the client rule and the engine mirror name the same column, byte for byte', () => {
    expect(client.TABLE_AVATAR_COLUMN).toBe('arena_avatar_url');
    expect(engine.TABLE_AVATAR_COLUMN).toBe(client.TABLE_AVATAR_COLUMN);
    expect(engine.TABLE_AVATAR_SELECT).toBe(client.TABLE_AVATAR_SELECT);
    expect(client.TABLE_AVATAR_SELECT).toBe('avatar_url:arena_avatar_url');
  });

  it('the engine roster load selects through the mirror, and the mirror carries the arena alias', () => {
    const tables = read('server/src/services/supabase/tables.ts');
    expect(tables).toMatch(/import \{ SEATED_PROFILE_SELECT \} from '\.\/tableAvatar\.js'/);
    expect(tables).toMatch(/\.from\('profiles'\)[\s\S]{0,1500}?\.select\(SEATED_PROFILE_SELECT\)/);
    expect(engine.SEATED_PROFILE_SELECT).toContain(engine.TABLE_AVATAR_SELECT);
    // The photograph column is not in the projection under any name.
    expect(engine.SEATED_PROFILE_SELECT.replace(engine.TABLE_AVATAR_SELECT, '')).not.toMatch(
      /\bavatar_url\b/
    );
  });

  it('the live profile sync reads the same column through the client helper', () => {
    const sync = read('src/hooks/useSeatedProfileSync.ts');
    expect(sync).toMatch(
      /import \{ TABLE_AVATAR_COLUMN, tableAvatarFromProfileRow \} from '\.\.\/lib\/tableAvatar'/
    );
    // The realtime payload is decoded through the helper, never by naming a column here.
    expect(sync).toMatch(/avatar:\s*tableAvatarFromProfileRow\(row\)/);
    expect(sync).not.toMatch(/row\.avatar_url\b/);
    expect(sync).not.toMatch(/row\.arena_avatar_url\b/);
    // The reconcile read names the column through the constant.
    expect(sync).toMatch(
      /\.select\(`id, \$\{TABLE_AVATAR_COLUMN\}, equipped_frame, equipped_aura`\)/
    );
  });

  it('the helper reads the arena column only, and ignores the photograph beside it', () => {
    expect(
      client.tableAvatarFromProfileRow({
        avatar_url: 'https://lh3.googleusercontent.com/photo.jpg',
        arena_avatar_url: '/avatars/table/free_pirate@2x.webp',
      })
    ).toBe('/avatars/table/free_pirate@2x.webp');
    expect(
      client.tableAvatarFromProfileRow({
        avatar_url: 'https://lh3.googleusercontent.com/photo.jpg',
      })
    ).toBeUndefined();
    expect(client.tableAvatarFromProfileRow({ arena_avatar_url: '   ' })).toBeUndefined();
    expect(client.tableAvatarFromProfileRow({ arena_avatar_url: 7 })).toBeUndefined();
    expect(client.tableAvatarFromProfileRow(null)).toBeUndefined();
  });

  it('the page resolves identity through the override before the card merge, and never at an anonymous table', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/createSeatIdentityOverrides\(\)/);
    expect(page).toMatch(
      /const rosterPlayers = mapped\.isAnonymous\s*\?\s*mapped\.players\s*:\s*seatIdentityOverridesRef\.current\.apply\(mapped\.players\)/
    );
    expect(page).toMatch(/rosterPlayers\.map\(\(p, i\) =>/);
    // The realtime handler records through the same module, so the two
    // readers cannot disagree about which value is newer.
    expect(page).toMatch(/seatIdentityOverridesRef\.current\.record\(change,/);
    // No subscription at an anonymous table.
    expect(page).toMatch(/tableIsAnonymous \? NO_SEATED_IDS : tableState\.players\.map/);
  });

  it('the engine publishes is_anonymous beside max_seats on every payload, and the mapper reads it', () => {
    const eng = read('server/src/engine/ServerTableEngine.ts');
    const maxSeats = eng.match(/max_seats:\s*Number\(this\.tableInfo\?\.max_players\)/g) ?? [];
    const anon = eng.match(/is_anonymous:\s*this\.tableInfo\?\.is_anonymous === true/g) ?? [];
    expect(maxSeats.length).toBeGreaterThan(0);
    expect(anon.length).toBe(maxSeats.length);
    const mapper = read('src/utils/mapEngineSnapshot.ts');
    expect(mapper).toMatch(
      /isAnonymous:\s*\(s as unknown as \{ is_anonymous\?: unknown \}\)\.is_anonymous === true/
    );
  });
});
