import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A UNION LEAD NEEDS NO CLUB (binding)
 *
 * The rake snapshot could answer the union question from the day it was
 * built - but only from INSIDE a member club, because the panel derived the
 * union from whichever club the operator had opened. Two people were badly
 * served by that:
 *
 *   A union lead who owns no club had no door at all. Every route to the
 *   figures ran through a club page they could not open.
 *
 *   A union lead who owns two had to pick one and hope the total above it was
 *   the union's rather than that club's.
 *
 * So the panel now takes a union directly, and the page that hands it one sits
 * at /unions/:unionId/data with no ClubMemberGuard - deliberately, since the
 * whole point is a lead who is not a member of any club in it. The gate is
 * ca_can_oversee_union, in the database, which raises on its own.
 *
 * OPENING A CLUB FROM THAT LIST needed the entitlement fixed first.
 * ca_can_view_club_finances had four branches - a club role, club ownership,
 * platform admin, and a null caller - and no union branch at all, so an
 * overseer who held no role in the club failed every one. On this estate the
 * union lead happens to own both member clubs, so it worked by COINCIDENCE.
 * Measured after the fix: the union branch admits the lead, refuses a plain
 * member of the club, refuses someone in no union; and as the lead, both club
 * rows claim to open and both open.
 *
 * Commission is deliberately NOT opened. It stays behind fn_is_club_admin_uid,
 * so an overseer reads what a club produced and not what it costs.
 */

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const PANEL = resolve(ROOT, 'src/components/club/RakeSnapshotPanel.tsx');
const APP = resolve(ROOT, 'src/App.tsx');

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

describe('a union lead needs no club', () => {
  it('the panel can read a union without being given a club', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    // The guard used to be `if (!clubId) return;`, which is why a union page
    // could not exist: with no club the panel simply declined to read.
    expect(tsx, 'the panel still refuses to read without a club').toMatch(
      /if \(!clubId && !unionId\) return;/
    );
    expect(tsx).toMatch(/unionId\?: string \| null;/);
  });

  it('the panel passes the union down rather than deriving it from a club', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    // Deriving it meant the answer depended on which club you walked in
    // through, and a lead with two clubs got one of them.
    const calls = tsx.match(/ClubRakeSnapshotService\.get\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length, 'the panel no longer reads the snapshot').toBeGreaterThan(0);
    for (const c of calls) {
      expect(c, 'a read that never mentions the union').toMatch(/unionId:/);
    }
  });

  it('the union page exists, and nothing gates it on club membership', () => {
    const app = readFileSync(APP, 'utf8');
    const at = app.indexOf('path="unions/:unionId/data"');
    expect(at, 'there is no union data route').toBeGreaterThan(-1);
    const routeEnd = app.indexOf('/>', app.indexOf('element={', at));
    const element = app.slice(at, routeEnd);
    expect(
      element,
      'gating the union page on club membership locks out the lead it is for'
    ).not.toMatch(/ClubMemberGuard/);
    expect(element).toMatch(/AuthGuard/);
  });

  it('something actually links to it', () => {
    // /union-dashboard was reachable only by typing the URL for months, and
    // the union wallet and treasury lived behind it. A route nobody links to
    // is a route nobody finds.
    const src = readdirSync(resolve(ROOT, 'src/pages'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => readFileSync(resolve(ROOT, 'src/pages', f), 'utf8'))
      .join('\n');
    expect(src, 'the union data page has no way in').toMatch(/unions\/\$\{unionId\}\/data/);
  });

  it('a union overseer may open a club in their own union', () => {
    const sql = body('ca_can_read_club_production');
    expect(sql, 'the production helper is gone').not.toBe('');
    expect(sql, 'no union branch, so an overseer is refused their own clubs').toMatch(
      /fn_is_union_overseer/
    );
    // Scoped through union_clubs. Without that it would admit an overseer to
    // any club at all, which is a different and much larger claim.
    expect(sql).toMatch(/union_clubs uc[\s\S]*?uc\.club_id = p_club_id/);
  });

  it('and that claim does not leak into the other nine club RPCs', () => {
    // The first cut put the union branch straight into
    // ca_can_view_club_finances - which is not this feature's gate. It is the
    // gate for nine other RPCs as well: the game ledger, the player
    // breakdown, the insurance report, the CSV exports and the union invoice
    // reader. Widening it handed every overseer the whole club data page for
    // every member club, while the commit described a drill-down.
    //
    // Reading what a club PRODUCED is what a union bills against. Reading its
    // player list and its cost structure is not.
    const gate = body('ca_can_view_club_finances');
    expect(gate, 'the finances gate is gone').not.toBe('');
    expect(
      gate,
      'the union branch is back in the shared gate, and reaches nine RPCs it was never meant to'
    ).not.toMatch(/fn_is_union_overseer/);

    // And the two places that DO need it ask for it by its narrower name.
    expect(body('ca_rake_snapshot')).toMatch(/ca_can_read_club_production\(p_club_id\)/);
    expect(body('fn_ca_rake_by_club')).toMatch(/ca_can_read_club_production\(a\.club_id\)/);
  });

  it('the club row flag is the same check the club scope makes', () => {
    const sql = body('fn_ca_rake_by_club');
    expect(sql, 'the union list cannot say which rows open').toMatch(/AS can_drill/);
    // Not merely "some gate" - the SAME one ca_rake_snapshot's club branch
    // enforces, or the button and the refusal can disagree.
    expect(
      sql,
      'a flag computed from anything but that check can disagree with it'
    ).toMatch(/public\.ca_can_read_club_production\(a\.club_id\) AS can_drill/);
  });

  it('the panel offers a club row only when the server says it opens', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    expect(tsx).toMatch(/r\.can_drill && r\.club_id \? \(/);
    expect(tsx).toMatch(/onClick=\{\(\) => openClub\(/);
  });

  it('opening a club does not carry the club search into the agent list', () => {
    const tsx = readFileSync(PANEL, 'utf8');
    const open = tsx.slice(tsx.indexOf('const openClub'), tsx.indexOf('/** Back out of a drill'));
    expect(open).toMatch(/setSearch\(''\)/);
    expect(open).toMatch(/setQuery\(''\)/);
  });

  it('commission is not opened along with the club', () => {
    // An overseer reads what a club PRODUCED, not what it COSTS. The cost
    // columns stay behind the club-admin gate, which they do not pass.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(/v_cost boolean := public\.fn_is_club_admin_uid\(p_club_id\)/);
    expect(sql, 'commission must not be gated on the looser finances check').not.toMatch(
      /v_cost boolean := public\.ca_can_view_club_finances/
    );
  });
});
