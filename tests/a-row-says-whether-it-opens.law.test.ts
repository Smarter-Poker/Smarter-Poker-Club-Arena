import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A ROW SAYS WHETHER IT OPENS (binding)
 *
 * The club breakdown shows an owner that an agent's network produced 30,634,
 * and Phase 6 made that row open into the downline that produced it. Two
 * things had to be true for that to be anything other than a button that
 * apologises.
 *
 * FIRST, the gate was wrong. fn_agent_downline_rake admitted the agent
 * themselves, an agent ABOVE them, or a union overseer - so the OWNER OF THE
 * CLUB was shown a number and refused its composition. Measured on production
 * before the change: owner REFUSED, the agent's own upline CAN DRILL. Club
 * admins are now admitted, and only when a club is named, since with no club
 * there is nothing to be an admin of.
 *
 * PEER AGENTS ARE STILL REFUSED. Overseeing a club is not the same as one
 * agent reading a rival's player list, and ca_can_view_club_finances - which
 * this page already runs under - would have granted exactly that, because it
 * counts every super agent. Measured after: owner CAN DRILL, the agent's own
 * upline CAN DRILL, a peer super agent REFUSED, three peer agents REFUSED, an
 * outsider REFUSED.
 *
 * SECOND, and this is what the law is really for: can_drill and the gate are
 * two expressions of one policy, written in two functions, and nothing but
 * this test makes them agree. Widen one and the row lies - it either offers a
 * door that refuses the operator, or hides one that would have opened.
 * Measured across three viewers and eighteen rows: eighteen agreements, no row
 * claiming to open that was refused, none claiming to be shut that opened, and
 * the flag discriminating rather than answering true to everything - owner six
 * of six, one super agent two of six, another four of six.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const PANEL = resolve(__dirname, '../src/components/club/RakeSnapshotPanel.tsx');

function latestDefining(fnName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found = '';
  for (const f of files) {
    const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    if (sql.includes(`FUNCTION public.${fnName}(`)) found = sql;
  }
  return found;
}

function body(fnName: string): string {
  const sql = latestDefining(fnName);
  const start = sql.indexOf(`FUNCTION public.${fnName}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return sql
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

/** Every migration, for changes that are applied as a patch rather than a
 *  re-declaration. */
function allMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

/** The predicates that decide who may read a downline. */
const CONDITIONS = ['fn_is_club_admin_uid', 'fn_is_union_overseer', 'fn_is_agent_ancestor'];

describe('a row says whether it opens', () => {
  it('a club admin may open an agent in their own club', () => {
    const all = allMigrations();
    expect(
      all,
      'without this the owner is shown a network total and refused its composition'
    ).toMatch(/p_club_id IS NOT NULL AND public\.fn_is_club_admin_uid\(p_club_id\)/);
  });

  it('the widening is club-scoped, so it cannot leak across clubs', () => {
    // fn_agent_downline_rake spans every club the agent belongs to when
    // p_club_id is null. Admitting an admin there would admit them to clubs
    // they do not administer, on the strength of one they do.
    const all = allMigrations();
    const clause =
      /AND NOT \(p_club_id IS NOT NULL AND public\.fn_is_club_admin_uid\(p_club_id\)\)/;
    expect(all).toMatch(clause);
  });

  it('a peer agent is still refused', () => {
    // The tempting shortcut is the gate this page already runs under. It
    // counts every super agent, so it would hand one agent another's players.
    // Read the ONE migration that widens the gate. Slicing the concatenation
    // of every migration from that heading runs on into later files, which
    // legitimately mention the finances gate for other reasons - and the law
    // then fails for a sentence written somewhere else.
    const file = readdirSync(MIGRATIONS).find((n) =>
      n.endsWith('_a_club_admin_may_open_an_agent_in_their_own_club.sql')
    );
    expect(file, 'the migration that widens the gate is gone').toBeTruthy();
    // Comments stripped. The header of that migration EXPLAINS why the
    // finances gate was not used, so reading the prose finds the name of the
    // thing the law forbids and fails on the explanation.
    const patch = readFileSync(resolve(MIGRATIONS, file as string), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(patch).toMatch(/fn_is_club_admin_uid/);
    expect(
      patch,
      'the finances gate counts every super agent, so it hands one agent another agent list'
    ).not.toMatch(/ca_can_view_club_finances/);
  });

  it('can_drill is built from the same conditions the gate enforces', () => {
    const sql = body('fn_ca_rake_by_agent');
    expect(sql, 'the row must say whether it opens').toMatch(/AS can_drill/);
    const flag = /\(v_cost OR v_over OR ca\.user_id = v_uid[\s\S]*?\) AS can_drill/.exec(sql);
    expect(flag, 'can_drill is not built from the caller at all').not.toBeNull();
    const expr = flag ? flag[0] : '';
    // Self-identity is spelled out; the other three are named functions.
    expect(expr).toMatch(/ca\.user_id = v_uid/);
    expect(expr).toMatch(/fn_is_agent_ancestor\(v_uid, ca\.user_id, p_club_id\)/);
    for (const fn of ['fn_is_club_admin_uid', 'fn_is_union_overseer']) {
      expect(sql, `${fn} decides the gate but not the flag`).toMatch(new RegExp(fn));
    }
  });

  it('every condition the gate uses is a condition the flag uses', () => {
    // The failure this catches is asymmetric drift: a fourth way in added to
    // the walker and not to the flag hides rows that would open; added to the
    // flag and not the walker offers rows that refuse.
    const gate = allMigrations();
    const flag = body('fn_ca_rake_by_agent');
    for (const fn of CONDITIONS) {
      expect(gate, `${fn} is not in the gate`).toMatch(new RegExp(fn));
      expect(flag, `${fn} is in the gate but not in can_drill`).toMatch(new RegExp(fn));
    }
  });

  it('the synthetic rows never claim to open', () => {
    // Unassigned and Unlisted Recipients are not agents. There is no downline
    // behind them, and both carry a null id, so a button would drill into
    // nothing.
    const sql = body('fn_ca_rake_by_agent');
    for (const label of ["'Unassigned'", "'Unlisted Recipients'"]) {
      const at = sql.indexOf(label);
      expect(at, `${label} row is gone`).toBeGreaterThan(-1);
      const row = sql.slice(at, sql.indexOf('FROM', at));
      expect(row, `${label} must not be drillable`).toMatch(/false, true/);
    }
  });

  it('the panel only offers a door the server says will open', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    // Rendering every agent as a button and handling the refusal afterwards
    // is the version of this that ships an error toast per click.
    expect(tsx).toMatch(/r\.can_drill && r\.agent_user_id \? \(/);
    expect(tsx).toMatch(/onClick=\{\(\) => openAgent\(/);
  });

  it('a drill from the club list is not bounced back out of it', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    // A club owner holds no downline of their own, so 'agent' is not among the
    // scopes they are offered - and the fallback that keeps an operator out of
    // scopes they do not hold would fire on the very next render.
    expect(tsx).toMatch(/if \(scope === 'agent' && crumbs\.length > 0\) return;/);
  });

  it('backing out of a drill returns where it started', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    expect(tsx).toMatch(/setDrillOrigin\(scope\)/);
    expect(tsx).toMatch(/const leaveDrill = useCallback/);
    // "My Downline" is both wrong and a dead end for an owner who has none.
    expect(tsx).toMatch(/Back To \$\{SCOPE_COPY\[drillOrigin\]\.label\}/);
  });

  it('a search does not follow the operator into the downline', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    // It was matching AGENT names in the club list. Carried in, it filters
    // PLAYER names, and quietly hides most of the book just asked for.
    const open = tsx.slice(tsx.indexOf('const openAgent'), tsx.indexOf('const leaveDrill'));
    expect(open).toMatch(/setSearch\(''\)/);
    expect(open).toMatch(/setQuery\(''\)/);
  });
});
