/**
 * ===========================================================================
 *  GUARD: A PERMISSIVE READABLE POLICY OF `true` IS NOT HOW A TABLE BECOMES
 *  PUBLIC
 * ===========================================================================
 *
 * WHAT HAPPENED, measured on production 2026-10-06 from the catalogue
 * (pg_policy, has_table_privilege, has_column_privilege) and never by reading
 * as anon.
 *
 * `public.player_stats` carried "Player stats are public" - FOR SELECT, roles
 * PUBLIC, permissive, USING (true) - plus a table-level SELECT grant to anon.
 * A correct sibling existed, player_stats_self (authenticated,
 * auth.uid() = user_id), and it made no difference: PERMISSIVE POLICIES ARE
 * OR'D, so the open one decided everything and the narrow one could only
 * widen it. Every player's total_winnings, total_losses, total_rake,
 * hands_played, vpip and pfr were readable by any anonymous visitor holding
 * the published anon key, while the Diamond Arena was open to the public.
 *
 * It also defeated the applied law
 * a_browser_cannot_read_which_seat_or_member_is_a_horse BY INFERENCE, with no
 * horse column read anywhere: 2,804 of 2,814 rows averaged 4,643 hands_played
 * against 168 for the 10 human rows, and table_seats hands anon a column-level
 * read of user_id, seat_number, table_id and stack. Classify on volume, join
 * the seat map.
 *
 * `commander_tournament_entries` (captain_entries_select) and
 * `commander_waitlist` (captain_waitlist_select, through its
 * `player_id IS NULL` branch, which is TRUE for a caller with no account) were
 * the same shape over player names, phone numbers and payouts.
 *
 * WHY A GUARD AND NOT JUST THREE FIXES. The three were found by looking. The
 * same sweep found 167 tables in `public` carrying a permissive readable
 * policy of `true` reachable by anon, 50 of them with a money or
 * personal-data column. This is a default, not three mistakes, and the next
 * one will arrive the same way.
 *
 * THE RULE. A migration may not create a permissive SELECT (or ALL) policy
 * whose USING expression is `true` and whose roles reach a browser - PUBLIC,
 * anon or authenticated - and may not grant SELECT to anon or PUBLIC on a
 * table this repository knows holds money or personal data.
 *
 * A table that is genuinely meant to be world-readable ends the statement
 * with
 *     -- public-ok: <why>
 * the same escape hatch tests/a-revoke-from-anon-must-name-public.law.test.ts
 * uses. Naming the reason is the whole point: `USING (true)` on a reference
 * table of blind structures is fine, and on a table of payouts it is a
 * breach, and the difference has to be written down by whoever knows it.
 *
 * WHAT THIS GUARD CANNOT SEE, stated plainly so nobody trusts it too far.
 * `captain_entries_select` and `captain_waitlist_select` appear in NO
 * migration in this repository - they were created straight against
 * production. A guard that reads migrations cannot see a policy that never
 * passed through one. Closing that gap needs a live sweep against a baseline,
 * the way scripts/ci/audit-live-definer-exposure.mjs already does for
 * SECURITY DEFINER functions; the inventory this guard was written beside is
 * in docs/security/anon-readable-open-select-policies.md.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

/** This guard lands with the player_stats fix; anything newer is bound by it. */
const THIS_VERSION = '20261006135147';
const PLAYER_STATS_FIX = '20261006135147_the_player_arena_record_is_not_published_to_a_browser.sql';

/**
 * Tables this repository knows hold money or personal data. Derived from the
 * sweep above; the point of the list is that it GROWS, and a name added here
 * is a name the rule below starts protecting.
 */
const SENSITIVE_TABLES = [
  'player_stats',
  'table_seats',
  'commander_tournament_entries',
  'commander_waitlist',
  'commander_tournament_points',
  'club_game_seats',
  'bbj_winners',
  'tournament_players',
  'tournament_registrations',
  'poy_leaderboard',
  'toke_entries',
  'profiles',
  'wallets',
];

/** Blank out `--` comments so prose about a policy is not read as one. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

interface Statement {
  text: string;
  exempt: boolean;
}

/**
 * Split SQL into top-level statements, respecting dollar-quoting and string
 * literals so a `;` inside a DO $pre$ ... $pre$ block does not end one.
 *
 * THIS IS NOT FUSSINESS. The first draft split on /[A-Za-z][\s\S]*?;/ and was
 * mutation-tested: weakening this repository's own fix to
 * `REVOKE SELECT ... FROM anon;` - dropping PUBLIC, the exact bug
 * tests/a-revoke-from-anon-must-name-public.law.test.ts exists for - left the
 * guard GREEN. A `;` inside the migration's DO blocks produced one enormous
 * chunk that happened to contain both the weakened REVOKE and an unrelated
 * `FROM PUBLIC, anon` from a function revoke further down, so the assertion
 * measured the wrong statement and passed. A test that cannot fail is not a
 * check.
 */
function splitStatements(sql: string): Array<{ text: string; end: number }> {
  const out: Array<{ text: string; end: number }> = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    // A dollar-quoted body: $tag$ ... $tag$, tag possibly empty.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? sql.length : close + tag.length;
      continue;
    }
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (ch === ';') {
      out.push({ text: sql.slice(start, i + 1), end: i + 1 });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  if (sql.slice(start).trim()) out.push({ text: sql.slice(start), end: sql.length });
  return out;
}

/**
 * Every top-level statement whose text matches `head`. The `-- public-ok:`
 * hatch is looked for in the ORIGINAL source on the line the statement ends
 * on. Comments are blanked before matching so prose about a policy is not
 * read as one, and offsets are preserved by blanking rather than deleting.
 */
function statements(sql: string, head: RegExp): Statement[] {
  const stripped = code(sql);
  const out: Statement[] = [];
  for (const stmt of splitStatements(stripped)) {
    const text = stmt.text.trim();
    if (!head.test(text)) continue;
    const lineEnd = sql.indexOf('\n', stmt.end);
    const tail = sql.slice(stmt.end, lineEnd < 0 ? sql.length : lineEnd);
    out.push({ text, exempt: /--\s*public-ok:/i.test(tail) });
  }
  return out;
}

/** `USING (true)` with any spacing, and nothing else inside the parentheses. */
function usingIsTrue(stmt: string): boolean {
  return /\bUSING\s*\(\s*true\s*\)/i.test(stmt);
}

/**
 * Which roles a CREATE POLICY reaches. No `TO` clause at all means PUBLIC,
 * which is the trap: `CREATE POLICY ... FOR SELECT USING (true)` with no TO
 * clause is anonymous, and reads as though it said nothing about roles.
 */
function reachesABrowser(stmt: string): boolean {
  const to = /\bTO\s+([A-Za-z0-9_",\s]+?)(?=\bUSING\b|\bWITH\s+CHECK\b|;)/i.exec(stmt);
  if (!to) return true; // no TO clause: PUBLIC
  return /\b(public|anon|authenticated)\b/i.test(to[1]);
}

/**
 * Does the GRANTEE LIST name this role? Scoped to the text after the last
 * ` FROM `/` TO `, because `\bPUBLIC\b` tested against a whole statement
 * matches the `public` in `public.player_stats` - which is how the first
 * draft of this guard stayed green while the fix's REVOKE was weakened to
 * name anon alone. Mutation-tested; see splitStatements above for the other
 * false green.
 */
function grantees(stmt: string, keyword: 'FROM' | 'TO'): string {
  const at = stmt.toUpperCase().lastIndexOf(` ${keyword} `);
  return at < 0 ? '' : stmt.slice(at + keyword.length + 2);
}

function namesRole(granteeList: string, role: string): boolean {
  return new RegExp(`(^|[\\s,("])${role}([\\s,;)"]|$)`, 'i').test(granteeList);
}

function isReadable(stmt: string): boolean {
  // No FOR clause means FOR ALL, which includes SELECT.
  const forClause = /\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i.exec(stmt);
  if (!forClause) return true;
  return /^(SELECT|ALL)$/i.test(forClause[1]);
}

function migrationsAfterThisOne(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => f.slice(0, f.indexOf('_')) > THIS_VERSION)
    .sort();
}

const read = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');

describe('the player_stats fix closes the grant as well as the policy', () => {
  const sql = read(PLAYER_STATS_FIX);

  it('drops the open policy rather than adding a narrow one beside it', () => {
    // The lesson of the sibling that made no difference: a narrower policy
    // next to a permissive `true` is not a fix, because they are OR'd.
    expect(sql).toMatch(/DROP\s+POLICY\s+"Player stats are public"\s+ON\s+public\.player_stats/i);
  });

  it('revokes from PUBLIC as well as anon', () => {
    // anon is a member of PUBLIC, so naming only anon reads correctly and can
    // change nothing where a PUBLIC grant exists.
    const revokes = statements(sql, /^\s*REVOKE\b[\s\S]*\bON\s+TABLE\s+public\.player_stats\b/i);
    expect(revokes.length, 'player_stats loses its grant, not just its policy').toBeGreaterThan(0);
    for (const r of revokes) {
      const from = grantees(r.text, 'FROM');
      expect(namesRole(from, 'PUBLIC'), `names PUBLIC: ${r.text.trim()}`).toBe(true);
      expect(namesRole(from, 'anon'), `names anon: ${r.text.trim()}`).toBe(true);
    }
  });

  it('proves the end state in the migration instead of hoping for it', () => {
    // A policy change nobody asserts is one that silently reverts.
    expect(sql).toContain("has_table_privilege('anon', 'public.player_stats', 'SELECT')");
    expect(sql).toContain("has_column_privilege('anon', 'public.player_stats'");
    expect(sql).toContain("has_table_privilege('authenticated', 'public.player_stats', 'SELECT')");
    expect(sql).toMatch(/player_stats_club_member_read/);
    expect(sql).toMatch(/player_stats_self/);
  });

  it('the replacement reader carries no money column', () => {
    expect(sql).toMatch(/ca_public_arena_record_v1/);
    expect(sql).toMatch(/total_winnings\|total_losses\|total_rake\|sum_big_blind/);
  });
});

describe('no migration after this one re-opens player_stats', () => {
  it('never grants it back to a browser that has no account', () => {
    const offenders: string[] = [];
    for (const file of migrationsAfterThisOne()) {
      for (const g of statements(read(file), /^\s*GRANT\b[\s\S]*\bplayer_stats\b/i)) {
        if (g.exempt) continue;
        if (!/\bSELECT\b|\bALL\b/i.test(g.text)) continue;
        const to = grantees(g.text, 'TO');
        if (!namesRole(to, 'anon') && !namesRole(to, 'PUBLIC')) continue;
        offenders.push(`${file}: ${g.text.trim().replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      "a migration grants anon or PUBLIC a read of player_stats again. Every player's " +
        'money is in that table, and its volume column classifies a horse without reading ' +
        'a horse column. The public leaderboard is served by fn_global_leaderboard_period ' +
        'and fn_club_leaderboard_period_v2, and the cross-club profile record by ' +
        'ca_public_arena_record_v1 - use those.'
    ).toEqual([]);
  });
});

/**
 * THE ONE THAT MATTERS LATER. Not these three names: the shape. The next
 * agent opening a table will write the statement that reads like a reasonable
 * default, and 167 tables already say it.
 */
describe('a permissive readable policy of true never reaches a browser', () => {
  it('holds for every migration after this guard', () => {
    const offenders: string[] = [];
    for (const file of migrationsAfterThisOne()) {
      for (const p of statements(read(file), /^\s*CREATE\s+POLICY\b/i)) {
        if (p.exempt) continue;
        if (/\bAS\s+RESTRICTIVE\b/i.test(p.text)) continue; // restrictive ANDs; it cannot widen
        if (!isReadable(p.text)) continue;
        if (!usingIsTrue(p.text)) continue;
        if (!reachesABrowser(p.text)) continue;
        offenders.push(`${file}: ${p.text.trim().replace(/\s+/g, ' ').slice(0, 200)}`); // window-ok: a failure-message truncation, not a source pin - every check above reads the whole CREATE POLICY statement
      }
    }
    expect(
      offenders,
      'a migration creates a PERMISSIVE readable policy of USING (true) that a browser ' +
        "role can use. Permissive policies are OR'd, so this one decides the table on its " +
        'own and any narrow policy beside it becomes decoration - that is exactly how ' +
        "player_stats published every player's money while player_stats_self sat next to " +
        'it doing nothing. A policy with no TO clause is PUBLIC, which includes anon. ' +
        'Scope it (TO authenticated with a real predicate, or TO service_role), serve the ' +
        'public shape through a SECURITY DEFINER reader, or end the statement with ' +
        '"-- public-ok: <why>" if the table is genuinely world-readable:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('and no migration after this guard grants anon a read of a known sensitive table', () => {
    const offenders: string[] = [];
    for (const file of migrationsAfterThisOne()) {
      for (const g of statements(read(file), /^\s*GRANT\b/i)) {
        if (g.exempt) continue;
        if (!/\bSELECT\b|\bALL\b/i.test(g.text)) continue;
        const to = grantees(g.text, 'TO');
        if (!namesRole(to, 'anon') && !namesRole(to, 'PUBLIC')) continue;
        const target = g.text.slice(0, g.text.length - to.length);
        const hit = SENSITIVE_TABLES.find((t) => new RegExp(`\\b${t}\\b`).test(target));
        if (!hit) continue;
        offenders.push(`${file}: ${hit} <- ${g.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`); // window-ok: a failure-message truncation, not a source pin - the grantee and target checks above read the whole GRANT statement
      }
    }
    expect(
      offenders,
      'a migration grants anon or PUBLIC a read of a table this repository knows holds ' +
        'money or personal data. Serve the public shape through a SECURITY DEFINER reader ' +
        'that returns what the screen needs, or end the statement with ' +
        '"-- public-ok: <why>":\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
