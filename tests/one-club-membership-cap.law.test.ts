/**
 * ===========================================================================
 *  LAW: ONE CLUB MEMBERSHIP CAP - ONE COUNT, ONE LOCK, ONE LIMIT (2026-09-22)
 * ===========================================================================
 *
 * The club membership cap was a number typed into five SQL functions and two
 * client files. Production migration 20260908125235 raised it from 4 to 10 in
 * the four functions that ENFORCE it and missed the one that TELLS THE PLAYER
 * (fn_get_club_creation_eligibility), while the client kept its own 4 in
 * ClubsService (MAX_CLUBS, a browser count in joinClub) and in CreateClubModal
 * ("four-club allowance"). A player in 4 to 9 clubs was told they could not
 * create a club that the server would have created. Separately, only the
 * create path locked the player, so two joins at 9 could both land.
 *
 * 20260922153234_one_club_membership_cap_one_count_one_lock.sql makes the cap
 * one authority: fn_club_membership_cap(), fn_club_membership_count(),
 * fn_club_membership_lock() and fn_club_creation_open(), and patches the four
 * enforcing functions onto them by exact substitution against byte-exact
 * production preimages. scripts/ci/test-club-membership-cap.py proves it in
 * PostgreSQL; this file keeps the source honest:
 *
 *   1. the cap is 10 and is stated once;
 *   2. every substitution matches its preimage exactly once, and the md5 the
 *      migration pins for each patched function is the md5 of that result;
 *   3. no src file restates a club membership cap;
 *   4. no buy grid offers 'club_creation', a purchase nothing reads;
 *   5. the client's reading of the server's cap refusal works for ANY cap.
 *
 * Registry: docs/laws.d/one-club-membership-cap.md
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const MIGRATION = read(
  'supabase/migrations/20260922153234_one_club_membership_cap_one_count_one_lock.sql'
);
const RECORD = read('supabase/migrations/20260908125235_a_player_may_belong_to_ten_clubs.sql');
const PRODUCTION_STATEMENT = read(
  'scripts/ci/fixtures/club-membership-cap/production-20260908125235-statement.sql'
);
const preimage = (fn: string) => read(`scripts/ci/fixtures/club-membership-cap/preimage/${fn}.sql`);

/** The dollar-quoted text between $<tag>$ ... $<tag>$ in the migration. */
const quoted = (tag: string): string => {
  const m = MIGRATION.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  expect(m, `$${tag}$ block`).not.toBeNull();
  return m![1];
};

/** Each patched function, the substitutions applied to it, and its signature. */
const PATCHES = [
  { fn: 'fn_enforce_four_club_limit', sig: 'public.fn_enforce_four_club_limit()', tags: ['trg'] },
  {
    fn: 'fn_join_club_membership_impl',
    sig: 'public.fn_join_club_membership_impl(uuid)',
    tags: ['join_impl'],
  },
  { fn: 'fn_join_club', sig: 'public.fn_join_club(uuid)', tags: ['join_lock', 'join_count'] },
  {
    fn: 'fn_create_club_atomic_membership_impl',
    sig: 'public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)',
    tags: ['create_flag', 'create_lock', 'create_count'],
  },
] as const;

/** Blank out // and block comments so prose about the old cap is not code. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const srcFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(ROOT, dir, name);
    const rel = relative(ROOT, path);
    if (statSync(path).isDirectory()) return srcFiles(rel);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });

describe('the cap is one number, stated once', () => {
  it('fn_club_membership_cap() returns 10, and the live proof says so', () => {
    expect(MIGRATION).toMatch(
      /CREATE FUNCTION public\.fn_club_membership_cap\(\)\n RETURNS integer\n LANGUAGE sql\n IMMUTABLE PARALLEL SAFE\n SET search_path TO 'pg_catalog'\nAS \$\$ SELECT 10 \$\$;/
    );
    expect(MIGRATION).toContain(
      "-- @live-proof: (SELECT btrim(prosrc) = 'SELECT 10' FROM pg_proc WHERE oid = to_regprocedure('public.fn_club_membership_cap()'))"
    );
  });

  it('is one transaction with bounded locks', () => {
    const body = MIGRATION.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(body).toMatch(
      /BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';/
    );
  });

  it('the helpers are invoker-rights, fixed search_path, and service_role only', () => {
    for (const sig of [
      'fn_club_membership_cap()',
      'fn_club_membership_count(uuid, uuid)',
      'fn_club_membership_lock(uuid)',
      'fn_club_creation_open(uuid)',
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    const helpers = MIGRATION.split('CREATE FUNCTION public.fn_club_').slice(1);
    expect(helpers).toHaveLength(4);
    for (const h of helpers) {
      expect(h.slice(0, h.indexOf('AS $$'))).not.toMatch(/SECURITY DEFINER/);
      expect(h.slice(0, h.indexOf('AS $$'))).toContain("SET search_path TO 'pg_catalog'");
    }
  });

  it('the count leaves departed rows out and the lock keeps the create path key', () => {
    expect(MIGRATION).toContain(
      "AND COALESCE(cm.membership_lifecycle_status::text, 'active') = 'active'"
    );
    expect(MIGRATION).toContain("AND cm.status::text IN ('active', 'approved')");
    expect(MIGRATION).toContain(
      'SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 77431))'
    );
  });
});

describe('the five functions are patched onto the helpers, exactly', () => {
  it.each(PATCHES)('$fn: every substitution matches its preimage once', ({ fn, tags }) => {
    let text = preimage(fn);
    for (const tag of tags) {
      const from = quoted(`${tag}_old`);
      const to = quoted(`${tag}_new`);
      expect(text.split(from).length - 1, `${tag}_old occurrences in ${fn}`).toBe(1);
      text = text.replace(from, to);
    }
    // The md5 the migration pins before EXECUTE, after install, and as its
    // live proof is the md5 of exactly this text.
    const post = md5(text);
    expect(MIGRATION.split(`'${post}'`).length - 1, `${fn} post md5 ${post}`).toBe(4);
    // One authority: no number, no count, no second lock key, no rollout rule.
    const body = text.slice(text.indexOf('AS $function$'));
    expect(body).toContain('public.fn_club_membership_cap()');
    expect(body).toContain('public.fn_club_membership_count(');
    expect(body).not.toMatch(/up to 10 clubs|>= 10\b|count\(\*\)|77431|club_entry_feature_flags/);
  });

  it.each(PATCHES)('$fn: the preimage pin names its live md5', ({ fn, sig }) => {
    const live = md5(preimage(fn));
    expect(MIGRATION).toContain(`('${sig}',\n       '${live}',`);
  });

  it('every enforcing path takes the player lock, and fn_join_club takes it first', () => {
    expect(quoted('trg_new')).toMatch(
      /^ {2}PERFORM public\.fn_club_membership_lock\(NEW\.user_id\);/
    );
    expect(quoted('join_impl_new')).toMatch(
      /^ {4}PERFORM public\.fn_club_membership_lock\(v_uid\);/
    );
    expect(quoted('create_lock_new')).toBe('  PERFORM public.fn_club_membership_lock(v_uid);\n');
    expect(quoted('join_lock_new')).toMatch(
      /PERFORM public\.fn_club_membership_lock\(v_uid\);\n {6}PERFORM pg_advisory_xact_lock\(\n$/
    );
  });

  it('the horse exemption and the early returns stay above the trigger count', () => {
    const post = preimage('fn_enforce_four_club_limit').replace(
      quoted('trg_old'),
      quoted('trg_new')
    );
    const lock = post.indexOf('PERFORM public.fn_club_membership_lock(NEW.user_id)');
    expect(post.indexOf("IF NEW.status NOT IN ('active', 'approved') THEN")).toBeLessThan(lock);
    expect(
      post.indexOf("IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'approved') THEN")
    ).toBeLessThan(lock);
    expect(post.indexOf('COALESCE(is_horse, false)')).toBeLessThan(lock);
  });

  it('the preflight is rewritten on the same helpers and states its reason', () => {
    const start = MIGRATION.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_get_club_creation_eligibility()'
    );
    const end = MIGRATION.indexOf('$function$;', start) + '$function$'.length;
    const def = MIGRATION.slice(start, end) + '\n';
    expect(def).toContain('v_cap integer := public.fn_club_membership_cap();');
    expect(def).toContain('v_count := public.fn_club_membership_count(v_uid);');
    expect(def).toContain('v_open := public.fn_club_creation_open(v_uid);');
    expect(def).toContain("'can_create', v_open AND v_count < v_cap");
    expect(def).toContain("WHEN NOT v_open THEN 'creation_unavailable'");
    expect(def).toContain("WHEN v_count >= v_cap THEN 'membership_cap'");
    expect(def).not.toMatch(/\b4\b|\b10\b/);
    expect(MIGRATION.split(`'${md5(def)}'`).length - 1).toBe(2);
  });

  it('the production record is the verbatim statement and warns it is installed', () => {
    const marker = '-- ===== verbatim statement as applied (everything below this line) =====\n';
    const statement = RECORD.slice(RECORD.indexOf(marker) + marker.length).replace(/\n$/, '');
    expect(statement).toBe(PRODUCTION_STATEMENT);
    expect(md5(statement)).toBe('15802fa718fe8442e9c8941838519f7a');
    expect(RECORD).toMatch(/DO NOT RE-APPLY/);
  });
});

describe('the client restates no cap', () => {
  const PATTERNS: [string, RegExp][] = [
    ['a MAX_CLUBS constant', /\bMAX_CLUBS\b/],
    ['a server cap message with a number in it', /only be a member of up to [0-9]+ clubs/i],
    [
      'an N-club allowance or limit in copy',
      /\b(four|ten|[0-9]+)[- ]club (allowance|limit|cap)\b/i,
    ],
    ['a literal maxClubs', /\bmaxClubs\s*[:=]\s*[0-9]/],
    [
      'a browser count of club_members compared with a literal',
      /from\('club_members'\)[\s\S]{0,400}?\bcount\s*(>=|>|<=|<)\s*[0-9]/,
    ],
  ];

  it('no src file hardcodes a club membership cap', () => {
    const offenders: string[] = [];
    for (const file of srcFiles('src')) {
      const code = codeOnly(read(file));
      for (const [what, re] of PATTERNS) if (re.test(code)) offenders.push(`${file}: ${what}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the patterns catch what they are for (negative control)', () => {
    const before = [
      'const MAX_CLUBS = 4;',
      "throw new Error('You can only be a member of up to 4 clubs. Leave a club to join a new one.');",
      "toast.error('Your four-club allowance is full.');",
      "const { count } = await supabase.from('club_members').select('user_id').eq('user_id', id); if (count >= 4) {}",
    ];
    for (const line of before)
      expect(
        PATTERNS.some(([, re]) => re.test(line)),
        line
      ).toBe(true);
  });
});

describe('no buy grid offers club creation', () => {
  it("every FEATURE_PRICING grid in src excludes 'club_creation'", () => {
    const grids = srcFiles('src').filter((f) =>
      read(f).includes('Object.entries(FEATURE_PRICING)')
    );
    expect(grids).toContain('src/pages/VIPPage.tsx');
    for (const file of grids) {
      const code = codeOnly(read(file));
      for (const at of [...code.matchAll(/Object\.entries\(FEATURE_PRICING\)/g)].map(
        (m) => m.index!
      )) {
        const chain = code.slice(at, code.indexOf('.map(', at));
        expect(chain, file).toMatch(/feature !== 'club_creation'/);
      }
    }
  });
});

describe("the client reads the server's cap refusal for any cap", () => {
  const service = read('src/services/ClubsService.ts');
  const literal = service.match(/export const MEMBERSHIP_CAP_MESSAGE = \/(.+)\/([a-z]*);/);

  it('ClubsService declares the pattern and createClub uses it', () => {
    expect(literal).not.toBeNull();
    expect(service).toMatch(/const capReached = MEMBERSHIP_CAP_MESSAGE\.exec\(message\);/);
  });

  it('matches every cap message the migration raises, whatever the cap', () => {
    const re = new RegExp(literal![1], literal![2]);
    const formats = [
      ...new Set(
        [...MIGRATION.matchAll(/'(You can only be a member of up to % clubs\.[^']*)'/g)].map(
          (m) => m[1]
        )
      ),
    ];
    expect(formats.sort()).toEqual([
      'You can only be a member of up to % clubs. Leave a club to create a new one.',
      'You can only be a member of up to % clubs. Leave a club to join a new one.',
    ]);
    for (const format of formats) {
      for (const cap of [1, 4, 10, 25, 1000]) {
        const m = re.exec(format.replace('%', String(cap)));
        expect(m, `${format} at ${cap}`).not.toBeNull();
        expect(Number(m![1])).toBe(cap);
      }
    }
  });
});
