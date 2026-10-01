/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A PROFILE SHOWS STRANGERS ONLY WHAT THE TABLE NEEDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 2 (public and private
 * fields). Ruling 25 (docs/DIAMOND-RULINGS.md), decided by Claude on Dan's
 * delegation of 2026-09-30: a stranger sees only what playing with you needs
 * - display name, username, avatar, player number and public statistics.
 * Anything that reveals a person's money, real identity or whereabouts is
 * readable only by that person and by platform staff.
 *
 * Migration 20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door
 * opened the doors and moved the database's own readers; the column revoke
 * that closes the table is its own migration, applied once every reader had
 * moved. What this pins:
 *  - the staff door answers platform staff only, the presence door answers a
 *    boolean and never the heartbeat, and neither is open to a visitor;
 *  - the owner door is get_my_full_profile(), pinned, not rewritten;
 *  - the eleven database readers changed only by asserted substitution (live
 *    md5 pinned, the clause found once, the reverse proved), keeping grants;
 *  - no Club Arena read of public.profiles names a private column - not in a
 *    select, a filter or an order - because Postgres refuses the WHOLE
 *    statement, and several readers here swallow 42501 as "no profile";
 *  - the player's own private fields are read through the owner door, and
 *    who is online through the presence door.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { blankNonCode, sliceBetween } from './helpers/sourceWindow';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/--[^\n]*/g, ' ');

const DOORS = migrationNames()
  .filter((n) => n.endsWith('_a_profiles_private_fields_have_an_owner_and_a_staff_door.sql'))
  .at(-1);
if (!DOORS) throw new Error('the profile doors migration is missing');
const MIG = migrationText(DOORS);
const STAFF = code(
  sliceBetween(
    MIG,
    'CREATE FUNCTION public.get_full_profiles_for_staff',
    'COMMENT ON FUNCTION public.get_full_profiles_for_staff'
  )
);
const PRESENCE = code(
  sliceBetween(
    MIG,
    'CREATE FUNCTION public.fn_profile_presence',
    'COMMENT ON FUNCTION public.fn_profile_presence'
  )
);
const EDITS = sliceBetween(
  MIG,
  '-- 2. READERS THAT NAME A STRANGER STOP READING PRIVATE FIELDS',
  '-- 3. THE ESTATE IS AS IT WAS'
);
const FINAL = code(sliceBetween(MIG, '-- 3. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

/** The columns of public.profiles only their owner and platform staff read. */
const PRIVATE = [
  'diamonds',
  'diamond_balance',
  'diamond_multiplier',
  'first_name',
  'last_name',
  'full_name',
  'birth_year',
  'city',
  'state',
  'country',
  'last_seen',
  'last_login',
  'last_login_date',
  'last_active',
  'updated_at',
  'referred_by',
  'poker_near_me_preferences',
];
const word = (c: string) => new RegExp(`(^|[^a-z0-9_])${c}([^a-z0-9_]|$)`);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|__tests__/.test(p)) out.push(p);
  }
  return out;
}

const PLAYER_NAME_COLUMNS = (() => {
  const m = read('src/utils/playerDisplayName.ts').match(
    /export const PLAYER_NAME_COLUMNS\s*=\s*'([^']*)'/
  );
  if (!m) throw new Error('PLAYER_NAME_COLUMNS is not a single string literal');
  return m[1];
})();

/** Every string constant declared in src, by name (first declaration wins). */
const CONSTANTS = (() => {
  const map = new Map<string, string>();
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const src = readFileSync(path, 'utf8');
    const decl =
      /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*(['`])([^'`]*?)\2/g;
    for (const m of src.matchAll(decl)) if (!map.has(m[1])) map.set(m[1], m[3]);
  }
  map.set('PLAYER_NAME_COLUMNS', PLAYER_NAME_COLUMNS);
  return map;
})();

/** Resolve `${CONSTANT}` references in a column list. */
function resolveConstants(text: string, depth = 0): string {
  if (depth > 4) return text;
  return text.replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (all, name: string) =>
    CONSTANTS.has(name) ? resolveConstants(CONSTANTS.get(name) as string, depth + 1) : all
  );
}

/**
 * Every `.from('profiles')` statement in the Club Arena source, with the text
 * of what it reads: select lists, filter columns and order columns. Writes
 * (update and insert payloads) are not reads and may name a private column.
 */
function profileReads() {
  const reads: { where: string; read: string; select: string }[] = [];
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const src = readFileSync(path, 'utf8');
    const blank = blankNonCode(src);
    const re = /\.from\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blank))) {
      const arg = src.slice(m.index + 6, m.index + 40);
      if (!/^\s*['"`]profiles['"`]\s*\)/.test(arg)) continue;
      // The statement: to the first `;` at depth zero, by the blanked copy.
      let depth = 0;
      let end = blank.length;
      for (let i = m.index; i < blank.length; i++) {
        const c = blank[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth <= 0) {
          end = i;
          break;
        }
      }
      const stmt = src.slice(m.index, end);
      const parts: string[] = [];
      const selects: string[] = [];
      const call =
        /\.(select|eq|neq|in|order|or|ilike|like|gte|lte|gt|lt|is|not|filter|match|contains|textSearch)\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
      let c2: RegExpExecArray | null;
      while ((c2 = call.exec(stmt))) {
        const text = resolveConstants(c2[3]);
        parts.push(text);
        if (c2[1] === 'select') selects.push(text);
      }
      const bare = /\.select\(\s*([A-Z][A-Z0-9_]*)\s*\)/g;
      while ((c2 = bare.exec(stmt))) {
        const text = resolveConstants('${' + c2[1] + '}');
        parts.push(text);
        selects.push(text);
      }
      const line = src.slice(0, m.index).split('\n').length;
      reads.push({
        where: `${relative(ROOT, path)}:${line}`,
        read: parts.join(' | '),
        select: selects.join(' | '),
      });
    }
  }
  return reads;
}

describe('LAW: a profile shows strangers only what the table needs', () => {
  it('opens a staff door that answers platform staff only, and never a visitor', () => {
    expect(STAFF).toContain('RETURNS SETOF public.profiles');
    expect(STAFF).toContain('SECURITY DEFINER');
    expect(STAFF).toContain('SET search_path = public, pg_temp');
    expect(STAFF).toContain(
      'IF auth.uid() IS NULL OR NOT COALESCE(public.fn_is_platform_admin(), false) THEN'
    );
    expect(STAFF).toContain("USING ERRCODE = '42501'");
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.get_full_profiles_for_staff(uuid[]) FROM PUBLIC, anon, authenticated;'
    );
    expect(MIG).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_full_profiles_for_staff(uuid[]) TO authenticated, service_role;'
    );
  });

  it('answers presence as a boolean and never hands out the heartbeat', () => {
    expect(PRESENCE).toContain('RETURNS TABLE (user_id uuid, is_online boolean)');
    expect(PRESENCE).toContain('SECURITY DEFINER');
    expect(PRESENCE).toContain(
      "(COALESCE(p.is_online, false) AND p.last_seen > now() - interval '5 minutes')"
    );
    expect(PRESENCE).toContain('WHERE auth.uid() IS NOT NULL');
    const selected = sliceBetween(PRESENCE, 'SELECT', 'FROM public.profiles');
    expect(selected.replace(/\(COALESCE[\s\S]*?minutes'\)/, '')).not.toMatch(/last_seen/);
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.fn_profile_presence(uuid[]) FROM PUBLIC, anon, authenticated;'
    );
    expect(FINAL).toContain('the presence door must be a definer answering (user_id, is_online)');
  });

  it('keeps the owner door as it is, pinned', () => {
    expect(FINAL).toContain(
      "md5(pg_get_functiondef(v_owner)) <> 'a464244a590dd2615cadc79c63a283ba'"
    );
    expect(FINAL).toContain("has_function_privilege('anon', v_owner, 'EXECUTE')");
    expect(code(MIG)).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.get_my_full_profile/i
    );
  });

  it('moves the eleven database readers only by asserted substitution', () => {
    for (const [sig, pin] of [
      ['public.fn_get_stories(uuid)', 'fc722ae39f052e2d2f3c373256877375'],
      ['public.get_top_mission_completers(uuid,integer)', 'be4dae914d9677fe4d14e2817840c267'],
      ['public.fn_notify_home_member_status()', '3534e6d372b42f836c4116c506d9c3d1'],
      ['public.fn_notify_home_post_comment()', 'd14f2ccabce86272881173c029df720e'],
      ['public.fn_notify_home_post_created()', '1fdad227e6c806fb657efa131cc01a70'],
      ['public.fn_notify_home_post_like()', 'b3268c70394e740f63b105bddf7e69f4'],
      ['public.fn_notify_home_rsvp()', '4f4e631373f4ba26e295ffaf8560cb86'],
      ['public.fn_welcome_new_approved_member()', '3501f4b3fa7f5d98d70b834089d02427'],
      ['public.fn_notify_mention()', 'cd059227571de74328acef69e29e75ab'],
      ['public.get_public_profile_by_username(text)', 'c92d550a49ee4c12c58120a25bc20745'],
      ['public.get_unified_user_profile(uuid)', 'a5dcf9ad960a54892fba42a9eb0f8584'],
    ]) {
      expect(EDITS).toContain(`('${sig}', '${pin}',`);
    }
    expect(EDITS).toContain('IF md5(v_def) <> r.pin THEN');
    expect(EDITS).toContain('IF v_n <> 1 THEN');
    expect(EDITS).toContain('EXECUTE replace(v_def, r.old_text, r.new_text);');
    expect(EDITS).toContain(
      'IF md5(replace(pg_get_functiondef(v_oid), r.new_text, r.old_text)) <> r.pin THEN'
    );
    expect(EDITS).toContain('the grants changed');
    // Each replacement names public fields only.
    const replacements = [...EDITS.matchAll(/\$n\$([\s\S]*?)\$n\$/g)].map((m) => m[1]);
    expect(replacements).toHaveLength(11);
    for (const r of replacements) {
      expect(r).not.toMatch(/\b(p\.)?(full_name|first_name|last_name|diamonds)\b/);
    }
    expect(FINAL).toContain('readers still naming a private field');
  });

  it('writes nothing, prices nothing and opens no switch', () => {
    expect(code(MIG)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(FINAL).toContain('this migration must not open a Diamond switch');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it('selects no real-name column for a name', () => {
    for (const c of ['first_name', 'last_name', 'full_name']) {
      expect(PLAYER_NAME_COLUMNS).not.toMatch(word(c));
    }
  });

  it('never names a private column in a read of public.profiles', () => {
    const reads = profileReads();
    expect(reads.length).toBeGreaterThan(50);
    // A computed column list cannot be checked, so a read names its columns.
    const computed = reads.filter((r) => r.select.includes('${')).map((r) => r.where);
    expect(computed, 'name the columns, or read your own row through ownProfile()').toEqual([]);
    const offending = reads
      .map((r) => ({ ...r, cols: PRIVATE.filter((c) => word(c).test(r.read)) }))
      .filter((r) => r.cols.length > 0)
      .map((r) => `${r.where} reads ${r.cols.join(', ')}`);
    expect(offending, 'read it through ownProfile(), readPresence() or a public column').toEqual(
      []
    );
  });

  it("reads the player's own private fields through the owner door, and presence through its door", () => {
    const door = read('src/lib/ownProfile.ts');
    expect(door).toContain("return supabase.rpc('get_my_full_profile').eq('id', userId);");
    expect(door).toContain("supabase.rpc('fn_profile_presence', {");
    for (const c of PRIVATE) expect(door).toContain(`'${c}'`);
    for (const file of [
      'src/components/wallet/ChipMintModal.tsx',
      'src/components/wallet/DynamicWallet.tsx',
      'src/pages/ClubAdvertisePage.tsx',
      'src/pages/VIPPage.tsx',
      'src/pages/TablePage.tsx',
      'src/pages/ProfilePage.tsx',
      'src/pages/SettingsPage.tsx',
      'src/services/DiamondService.ts',
      'src/services/AchievementTriggerService.ts',
      'src/stores/useUserStore.ts',
      'src/hooks/useProfileAccountSync.ts',
    ]) {
      expect(read(file), file).toContain('ownProfile(');
    }
    for (const file of [
      'src/pages/FriendsPage.tsx',
      'src/pages/AgentDashboardPage.tsx',
      'src/components/social/OnlineFriendsPill.tsx',
      'src/components/social/PresenceIndicator.tsx',
    ]) {
      expect(read(file), file).toContain('readPresence(');
    }
  });
});
