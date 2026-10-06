/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A PLAYER CANNOT ASK THE DATABASE WHO IS A HORSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE OR
 * USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * `a-horse-is-indistinguishable-from-a-human` pins that OUR CODE does not ask.
 * This pins the half that actually matters, because a player is not limited to
 * our code — they can open a console and write their own query. Measured as an
 * ordinary non-staff logged-in player before the fix:
 *
 *     profiles.is_horse = true     1000 rows   the entire roster
 *     profiles.horse_profile       1308 rows   and the playing style
 *     ai_horses                     100 rows   readable LOGGED OUT
 *
 * The close is a column-level REVOKE on `profiles` plus a deny-all policy on
 * `ai_horses` (migration 20260907221341_horse_identity_is_not_readable_by_a_player).
 *
 * WHY THIS TEST IS SOURCE-LEVEL RATHER THAN A LIVE QUERY: the unit suite has no
 * database. What it CAN guarantee is that the migration which closes the hole
 * is present, says what it does, and is never quietly reverted by a later
 * "restore client read grants" pass — which is exactly how the grant got there
 * in the first place (see 20260822150000_profiles_restore_client_read_grants).
 * The live behaviour was verified by probe at apply time and the numbers are
 * recorded in the migration header.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { blankNonCode } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

const CLOSER = '20260907221341_horse_identity_is_not_readable_by_a_player.sql';

describe('LAW: the horse-identity columns are not granted to a browser', () => {
  it('the closing migration exists', () => {
    expect(files, `${CLOSER} is missing — the leak is open again`).toContain(CLOSER);
  });

  it('revokes all three identity columns from both browser roles', () => {
    const sql = read(CLOSER);
    for (const role of ['authenticated', 'anon']) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE SELECT \\(is_horse, horse_profile, horse_status\\) ON public\\.profiles FROM ${role}`
        )
      );
    }
  });

  it('closes the logged-out ai_horses policy', () => {
    const sql = read(CLOSER);
    expect(sql).toContain('DROP POLICY IF EXISTS "Anyone can view horses" ON public.ai_horses');
    expect(sql).toContain('CREATE POLICY deny_all_ai_horses');
  });

  it('asserts its own effect rather than describing it', () => {
    /* The first attempt at this migration revoked a column on `table_seats`,
       where a TABLE-level grant makes that a no-op — and its own post-apply
       assertion caught the lie and rolled the whole thing back. A migration
       that only says what it fixes cannot fail when it does not. */
    const sql = read(CLOSER);
    expect(sql).toContain('POST-APPLY');
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});

describe('LAW: no later migration re-opens it', () => {
  /* This is the real failure mode. The grant existed because a 2026-08-22
     migration called "restore_client_read_grants" handed `authenticated` 102
     columns of `profiles`, and a future pass with the same good intention
     would hand back these three without noticing. */
  const laterThanCloser = files.filter((f) => f > CLOSER && f.endsWith('.sql'));

  it('nothing after the close re-grants the horse columns on profiles', () => {
    const offenders = laterThanCloser.filter((f) => {
      const sql = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');
      if (!/GRANT\s+SELECT[^;]*ON\s+public\.profiles/i.test(sql)) return false;
      return /\bis_horse\b|\bhorse_profile\b|\bhorse_status\b/i.test(sql);
    });

    expect(
      offenders,
      'a later migration grants a horse-identity column back to a browser role'
    ).toEqual([]);
  });

  it('nothing after the close re-opens ai_horses to anon or authenticated', () => {
    const offenders = laterThanCloser.filter((f) => {
      const sql = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');
      return /CREATE\s+POLICY[^;]*ON\s+public\.ai_horses[^;]*USING\s*\(\s*true\s*\)/i.test(sql);
    });
    expect(offenders, 'a later migration makes ai_horses world-readable again').toEqual([]);
  });
});

describe('LAW: the seat and the membership do not say "horse" to a browser', () => {
  /* table_seats.horse_id (965,180 of 1,303,476 seat rows on 2026-10-05) and
     club_members.is_bot were readable by anon and authenticated through a
     TABLE-level grant, under which a column REVOKE is a no-op - the reason the
     2026-09-07 attempt on table_seats rolled itself back. The close replaces
     the table-level SELECT with a column list built from the catalogue, less
     the one column, and asserts it. */
  const SEAT = '20261005115325_a_browser_cannot_read_which_seat_or_member_is_a_horse.sql';
  const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '');

  it('the closing migration exists', () => {
    expect(files, `${SEAT} is missing - the seat mark is readable again`).toContain(SEAT);
  });

  it('replaces the table-level SELECT with every column but the mark, for both browser roles', () => {
    const sql = strip(read(SEAT));
    expect(sql).toContain("('table_seats', 'horse_id'), ('club_members', 'is_bot')");
    expect(sql).toContain(
      "EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', r.tbl);"
    );
    expect(sql).toContain(
      "EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon, authenticated', v_cols, r.tbl);"
    );
    expect(sql).toMatch(/AND a\.attname <> r\.withheld/);
  });

  it('refuses to run while a browser-reachable reader still names the mark, and asserts its effect', () => {
    const sql = strip(read(SEAT));
    expect(sql).toContain('a reader a browser can reach may still read a withheld column');
    expect(sql).toContain('a policy reads a withheld column');
    expect(sql).toContain('a browser-readable view reads a withheld column');
    expect(sql).toContain('still holds table-level SELECT on');
    expect(sql).toContain('can still read %.%');
    expect(sql).toMatch(/reads % of % columns of %, expected %/);
  });

  it('a column added after the close is granted to the browser roles in the same migration', () => {
    /* Column-level SELECT means a NEW column is unreadable by anon and
       authenticated until it is granted; a browser query naming it would 403
       with nothing failing at migration time. So every later ADD COLUMN on
       either table carries its own GRANT SELECT (col) - unless the column is
       itself withheld, which then says so in a comment with "WITHHELD". */
    const later = files.filter((f) => f > SEAT);
    const missing: string[] = [];
    for (const f of later) {
      const raw = read(f);
      const sql = strip(raw).replace(/\/\*[\s\S]*?\*\//g, '');
      const adds = sql.matchAll(
        /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?public\.(table_seats|club_members)\s+([^;]*?ADD\s+COLUMN[^;]*);/gi
      );
      for (const m of adds) {
        for (const col of m[2].matchAll(
          /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi
        )) {
          const granted = new RegExp(
            `GRANT\\s+SELECT\\s*\\([^)]*\\b${col[1]}\\b[^)]*\\)\\s*ON\\s+(TABLE\\s+)?public\\.${m[1]}\\b[^;]*\\b(anon|authenticated)\\b`,
            'i'
          ).test(sql);
          if (!granted && !new RegExp(`WITHHELD[^\\n]*\\b${col[1]}\\b`).test(raw)) {
            missing.push(`${f}: ${m[1]}.${col[1]}`);
          }
        }
      }
    }
    expect(missing, 'a new column is unreadable by the browser until it is granted').toEqual([]);
  });

  it('nothing after the close hands either table back to a browser whole', () => {
    const later = files.filter((f) => f > SEAT);
    const offenders = later.filter((f) => {
      const sql = strip(read(f)).replace(/\/\*[\s\S]*?\*\//g, '');
      return (
        /GRANT\s+(SELECT|ALL)[^;(]*ON\s+(TABLE\s+)?public\.(table_seats|club_members)\s[^;]*TO[^;]*\b(anon|authenticated)\b/i.test(
          sql
        ) ||
        /GRANT\s+SELECT\s*\([^)]*\b(horse_id|is_bot)\b[^)]*\)\s*ON\s+(TABLE\s+)?public\.(table_seats|club_members)/i.test(
          sql
        )
      );
    });
    expect(offenders, 'a later migration re-grants the horse mark to a browser role').toEqual([]);
  });
});

describe('LAW: the SECURITY DEFINER RPCs do not walk around the revoke', () => {
  /* A SECURITY DEFINER function runs as its OWNER, so it reads is_horse
     regardless of what a browser role may SELECT — and then hands it to
     whoever called it. Measured as a PLAIN club member before the mask:
     ca_club_members returned 200 rows with 200 flagged, ca_club_top_players
     100 of 100. Both gate on `ca_can_view_club`, which any member passes. */
  const MASK = '20260907221350_horse_flag_is_masked_for_non_staff_rpcs.sql';

  it('the masking migration exists', () => {
    expect(files, `${MASK} is missing — the RPC bypass is open again`).toContain(MASK);
  });

  it('every flag-returning RPC consults the staff predicate', () => {
    const sql = read(MASK);
    for (const rpc of ['ca_club_members', 'ca_club_top_players', 'fn_club_cashier_members_v2']) {
      expect(sql, `${rpc} must mask the flag`).toContain(rpc);
    }
    expect(sql).toContain('fn_can_see_horse_flag');
    // and it asserts its own effect rather than describing it
    expect(sql).toMatch(/only % of 3 flag-returning RPCs consult the mask/);
  });

  it('the staff predicate is club leadership, not every role with a title', () => {
    /* manager / agent / sub_agent / super_agent are ordinary human users and
       there are many of them. Dan's rule is that a HUMAN USER cannot know. */
    const sql = read(MASK);
    expect(sql).toMatch(/'owner','co_owner','admin'/);
    for (const role of ['manager', 'super_agent', 'sub_agent']) {
      expect(
        sql.match(new RegExp(`cm\\.role IN \\([^)]*'${role}'`)),
        `${role} must not be able to see the flag`
      ).toBeNull();
    }
  });

  it('masks rather than removing, so no caller breaks', () => {
    // Uniform `false` for non-staff. A NULL on some rows and a value on
    // others would itself be the signal.
    expect(read(MASK)).toMatch(/v_may_see AND coalesce\(pr\.is_horse, false\)/);
  });
});

describe('LAW: realtime does not broadcast the answer', () => {
  /* The third door, and the one column grants cannot close: a publication
     carries whatever columns it lists, and Realtime hands that payload to any
     subscriber RLS allows. The client already subscribes to profiles
     postgres_changes for avatars and cosmetics. */
  const RT = '20260907221359_realtime_does_not_broadcast_horse_identity.sql';

  it('the realtime migration exists', () => {
    expect(files, `${RT} is missing — realtime broadcasts horse identity again`).toContain(RT);
  });

  it('withholds exactly the horse columns and keeps the rest', () => {
    const sql = read(RT);
    expect(sql).toMatch(/NOT IN \('is_horse', 'horse_status', 'horse_profile'\)/);
    expect(sql).toMatch(/attname <> 'horse_id'/);
    /* The rest must still publish, or every avatar and cosmetic update on the
       platform silently stops arriving. */
    expect(sql).toMatch(/the list is too narrow/);
  });

  it('does not use SET TABLE, which would unsubscribe every other table', () => {
    const sql = read(RT).replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/ALTER PUBLICATION\s+\S+\s+SET TABLE/i);
    expect(sql).toMatch(/DROP TABLE public\.profiles/);
    expect(sql).toMatch(/ADD TABLE public\.profiles/);
  });
});

describe('LAW: exactly one god account', () => {
  const GOD = '20260907221408_only_one_god_account.sql';

  it('the migration exists and enforces uniqueness in the database', () => {
    expect(files).toContain(GOD);
    const sql = read(GOD);
    /* Demoting one row fixes today. The partial unique index is what makes a
       second god impossible tomorrow, from any client or any agent. */
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS one_god_account_only/);
    expect(sql).toMatch(/WHERE role = 'god'/);
  });

  it('names the one account that keeps it, and refuses to guess', () => {
    const sql = read(GOD);
    /* The migration must pin ONE address, by e-mail, and use that same
       address everywhere it decides: the pre-flight that proves the keeper
       already holds the role, the demotion's exclusion, and the post-flight
       that proves who is left. The literal itself is not written here -
       tests/a-script-never-wears-a-persons-face pins that Dan's personal
       address appears in no test or script, and this one does not need it:
       what matters is that the three decisions agree on a single account. */
    const named = sql.match(/lower\(u\.email\)\s*=\s*'([^']+@[^']+)'/);
    expect(named, 'the pre-flight names the keeper by e-mail').not.toBeNull();
    const keeper = named![1];
    expect(sql).toContain(`lower(u.email) <> '${keeper}'`);
    expect(sql).toContain(`IF v_email <> '${keeper}' THEN`);
    expect(sql.match(/'[^'\s]+@[^'\s]+\.[a-z]+'/g)?.every((lit) => lit === `'${keeper}'`)).toBe(
      true
    );
    // If that address is not already a god, the migration must not demote anyone.
    expect(sql).toMatch(/refusing to demote anyone/);
  });
});

describe('LAW: the bot roster is not readable by a browser', () => {
  /* public.content_authors is the roster itself - 1,000 of 1,000 profile_ids
     were horses on 2026-10-05 - and it was readable logged out through
     "Public can read authors" and a table-level grant of everything to anon
     and authenticated. clip_usage_log says which clip each horse posted. The
     World Hub stopped reading either from a browser (#2127); this migration
     closes them in the database. */
  const ROSTER = '20261005162843_the_bot_roster_is_not_readable_by_a_browser.sql';
  const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the closing migration exists', () => {
    expect(files, `${ROSTER} is missing - the roster is readable again`).toContain(ROSTER);
  });

  it('drops every open policy and revokes both tables, the sequence and the roster RPCs', () => {
    const sql = strip(read(ROSTER));
    for (const p of [
      'Public can read authors',
      'Admins manage authors',
      'Anyone can view clip usage',
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS "${p}"`);
    }
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.content_authors FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.clip_usage_log FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated');
    for (const fn of [
      'fn_horses_without_social_identity',
      'fn_horses_not_social_ready',
      'fn_mint_social_alias',
      'get_random_clip',
      'mark_clip_used',
    ]) {
      expect(sql).toContain(`'${fn}'`);
    }
  });

  it('asserts its own effect and keeps the service role whole', () => {
    const sql = strip(read(ROSTER));
    expect(sql).toContain('a browser role still holds a privilege');
    expect(sql).toContain('a roster RPC is still callable by a browser');
    expect(sql).toContain('a policy is still open on a roster table');
    expect(sql).toContain('the service role lost the roster');
  });

  it('nothing after the close hands the roster back to a browser', () => {
    const offenders = files
      .filter((f) => f > ROSTER)
      .filter((f) => {
        const sql = strip(read(f));
        return (
          /GRANT\s+[^;]*ON\s+(TABLE\s+)?(public\.)?(content_authors|clip_usage_log)\b[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(
            sql
          ) ||
          /CREATE\s+POLICY[^;]*ON\s+(public\.)?(content_authors|clip_usage_log)\b[^;]*TO[^;]*\b(anon|authenticated|public)\b/i.test(
            sql
          ) ||
          /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(public\.)?(fn_horses_without_social_identity|fn_horses_not_social_ready|fn_mint_social_alias|get_random_clip|mark_clip_used)\b[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(
            sql
          )
        );
      });
    expect(offenders, 'a later migration re-opens the roster to a browser role').toEqual([]);
  });
});

describe('LAW: a post does not say who wrote it', () => {
  /* social_posts.origin_type ('horse' on a horse's clips) and metadata (the
     publishing pipeline's notes, only ever on pipeline posts) were readable by
     both browser roles through a table-level SELECT. World Hub #2130 stopped
     every browser read of them; this migration grants the browser roles every
     column but those two and proves it as each role. */
  const POSTS = '20261005174015_a_post_does_not_say_who_wrote_it.sql';
  const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the closing migration exists and withholds exactly the two label columns', () => {
    expect(files).toContain(POSTS);
    const sql = strip(read(POSTS));
    expect(sql).toContain('REVOKE SELECT ON TABLE public.social_posts FROM anon, authenticated;');
    expect(sql).toContain("a.attname NOT IN ('origin_type', 'metadata')");
    expect(sql).toContain('GRANT SELECT (%s) ON TABLE public.social_posts TO anon, authenticated');
    expect(sql).toContain('anon still reads origin_type');
    expect(sql).toContain('authenticated still reads metadata');
  });

  it('nothing after the close hands either label column back to a browser', () => {
    const offenders = files
      .filter((f) => f > POSTS)
      .filter((f) => {
        const sql = strip(read(f));
        return (
          /GRANT\s+(SELECT|ALL)[^;(]*ON\s+(TABLE\s+)?public\.social_posts\b[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(
            sql
          ) ||
          /GRANT\s+SELECT\s*\([^)]*\b(origin_type|metadata)\b[^)]*\)\s*ON\s+(TABLE\s+)?public\.social_posts/i.test(
            sql
          )
        );
      });
    expect(offenders, 'a later migration re-grants the post labels to a browser role').toEqual([]);
  });
});

describe('LAW: a horse keeps a heartbeat like a person', () => {
  /* Presence has one definition: is_online with last_seen under five minutes.
     A horse has no browser, so a pg_cron tick keeps the same two columns the
     way a person's tab does. Without it every horse read offline forever on
     every surface; with a schedule instead it read online half the day. */
  const BEAT = '20261005174041_a_horse_keeps_a_heartbeat_like_a_person.sql';

  it('the heartbeat migration exists, writes only the presence columns, and is not browser-callable', () => {
    expect(files).toContain(BEAT);
    const sql = read(BEAT);
    expect(sql).toContain("cron.schedule('horse-presence-heartbeat', '* * * * *'");
    expect(sql).toContain('UPDATE public.profiles p SET is_online = true, last_seen = v_now');
    expect(sql).toContain('UPDATE public.profiles p SET is_online = false');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.fn_horse_presence_tick() FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain('a browser role can run the horse heartbeat');
  });
});

describe('LAW: a reel does not say who made it, and the post modes are closed', () => {
  /* social_reels.origin_type was 'horse' on every horse Reel and readable by
     both browser roles; World Hub #2144 stopped every browser read of it and
     this grants the browser roles every column but it. horse_post_modes had a
     SELECT policy of `true`; nothing a browser runs reads it. */
  const REELS = '20261006004137_a_reel_does_not_say_who_made_it.sql';
  const MODES = '20261006004222_the_horse_post_modes_are_not_readable_by_a_browser.sql';
  const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('both closing migrations exist and assert their effect', () => {
    expect(files).toContain(REELS);
    expect(files).toContain(MODES);
    const reels = strip(read(REELS));
    expect(reels).toContain('REVOKE SELECT ON TABLE public.social_reels FROM anon, authenticated;');
    expect(reels).toContain("a.attname <> 'origin_type'");
    expect(reels).toContain('anon still reads origin_type');
    const modes = strip(read(MODES));
    expect(modes).toContain(
      'REVOKE ALL ON TABLE public.horse_post_modes FROM PUBLIC, anon, authenticated;'
    );
    expect(modes).toContain('a browser role still reaches horse_post_modes');
  });

  it('nothing after the close hands either back to a browser', () => {
    const offenders = files
      .filter((f) => f > REELS)
      .filter((f) => {
        const sql = strip(read(f));
        return (
          /GRANT\s+(SELECT|ALL)[^;(]*ON\s+(TABLE\s+)?public\.(social_reels|horse_post_modes)\b[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(
            sql
          ) ||
          /GRANT\s+SELECT\s*\([^)]*\borigin_type\b[^)]*\)\s*ON\s+(TABLE\s+)?public\.social_reels/i.test(
            sql
          ) ||
          /CREATE\s+POLICY[^;]*ON\s+(public\.)?horse_post_modes\b/i.test(sql)
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe('LAW: no browser query names a horse column', () => {
  /* The grants above make the database refuse. This is the other half: the
     bundle must not ASK. A query naming is_horse is refused (42501) and fails
     closed - an empty list, a feature that silently does nothing - and the
     question itself, shipped to every player's browser, says which columns
     mark a horse. Found 2026-10-05: HydraService (imported by TablePage, run
     on every buy-in) and HorseOrchestrator (imported by UnionDetailPage) were
     still selecting and filtering on profiles.is_horse, horse_status and
     horse_profile. Both were dead browser-side horse management - the engine
     owns horses - and were deleted rather than fenced. */
  const SRC = join(__dirname, '..', 'src');
  const MARKS = /\b(is_horse|horse_status|horse_profile|horse_id|is_bot)\b/;
  /* horse_bug_reports is the one exception, and it is not the identity mark:
     its horse_id is a free-text reporter label defaulting to 'system', and the
     only thing a browser files there is its own console capture, labelled
     'console'. The table is admin-read only
     (a-horse-report-is-not-a-public-record). */
  const EXEMPT_TABLES = new Set(['horse_bug_reports']);

  function browserFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) browserFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** Every `.from('<table>')` query chain in src, as [file, table, chain]. */
  function queries(): Array<[string, string, string]> {
    const out: Array<[string, string, string]> = [];
    for (const file of browserFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      const cleaned = blankNonCode(src);
      const anchor = /\.from\(\s*(['"`])([a-z_][a-z0-9_]*)\1\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = anchor.exec(src))) {
        // An anchor inside a comment or a string is prose, not a query.
        if (cleaned.slice(m.index, m.index + 6) !== '.from(') continue;
        let depth = 0;
        let end = cleaned.length;
        for (let i = m.index; i < cleaned.length; i++) {
          const c = cleaned[i];
          if (c === '{' || c === '(' || c === '[') depth++;
          else if (c === '}' || c === ')' || c === ']') depth--;
          else if (c === ';' && depth <= 0) {
            end = i + 1;
            break;
          }
        }
        // Comments out, strings kept: the column names live in strings.
        const chain = src
          .slice(m.index, end)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        out.push([relative(join(__dirname, '..'), file), m[2], chain]);
      }
    }
    return out;
  }

  it('no src query selects, filters or writes is_horse, horse_status, horse_profile, horse_id or is_bot', () => {
    const all = queries();
    // The walk saw the reads it guards; an empty walk would pass on nothing.
    expect(all.length).toBeGreaterThan(200);
    const offenders = all
      .filter(([, table, chain]) => !EXEMPT_TABLES.has(table) && MARKS.test(chain))
      .map(([file, table, chain]) => `${file}: from('${table}') names ${chain.match(MARKS)![1]}`);
    expect(offenders, 'a browser query names a horse-identity column').toEqual([]);
  });

  it('the browser horse-management services stay deleted', () => {
    for (const gone of ['src/services/HydraService.ts', 'src/services/HorseOrchestrator.ts']) {
      expect(existsSync(join(__dirname, '..', gone)), `${gone} is back`).toBe(false);
    }
  });
});
