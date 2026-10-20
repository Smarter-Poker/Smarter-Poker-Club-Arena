/**
 * ===========================================================================
 *  LAW - A CASHIER LIST NAMES A MEMBER BY THE ARENA NAME
 * ===========================================================================
 *
 * Cashier launch audit C6-04, 2026-10-09. The claim-back list
 * (fn_agent_wallet_reversible) named a recipient by display_name FIRST, the
 * World Hub name, which production printed over the poker alias for 940 of
 * the 1,011 profiles that belong to a club. The Trade record
 * (fn_club_trade_ledger) named each side coalesce(alias, display_name,
 * username): the display name ahead of the username. Migration 20261010005048
 * names every profile with public.fn_arena_name, the rule
 * tests/theArenaIsAlwaysTheAlias.law.test.ts holds the client to and the chip
 * statement already uses. Qualified by
 * scripts/ci/test-cashier-arena-names-db-postgres.py on production's live
 * bodies and helpers.
 *
 * Registry: docs/laws.d/a-cashier-list-names-a-member-by-the-arena-name.md
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const FILE = '20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql';
const squash = (s: string): string => s.replace(/\s+/g, ' ');
const arena = (p: string): string =>
  `public.fn_arena_name(${p}.alias, ${p}.username, ${p}.display_name, ${p}.first_name, ${p}.last_name, ${p}.full_name)`;

/** The newest definition of a function in the corpus: the one production runs. */
function newest(name: string): { file: string; body: string } {
  const defines = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
  const file = migrationNames()
    .filter((n) => defines.test(migrationText(n)))
    .at(-1)!;
  const text = migrationText(file);
  const start = text.search(defines);
  const tag = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(text.slice(start))!;
  const bodyStart = start + tag.index + tag[0].length;
  return { file, body: text.slice(start, text.indexOf(tag[1], bodyStart)) };
}

describe('a cashier list names a member by the arena name', () => {
  const trade = newest('fn_club_trade_ledger');
  const reversible = newest('fn_agent_wallet_reversible');

  it('is defined last by the migration that fixed it, or by one that keeps the fix', () => {
    expect(trade.file >= FILE).toBe(true);
    expect(reversible.file >= FILE).toBe(true);
  });

  it('names both sides of every Trade record row with fn_arena_name, and leaves a side with no profile unnamed', () => {
    const body = squash(trade.body);
    // One per role branch: staff, the agent's downline, the member's own rows.
    // The sender side is also unnamed for a Club Bank send (20261012040542:
    // the Club Bank is its sender), so it is matched up to the THEN.
    expect(body.split(`CASE WHEN pt.id IS NOT NULL THEN ${arena('pt')} END`)).toHaveLength(4);
    expect(
      body.match(
        /CASE WHEN pf\.id IS NOT NULL (AND [^;]*? )?THEN public\.fn_arena_name\(pf\.alias, pf\.username, pf\.display_name, pf\.first_name, pf\.last_name, pf\.full_name\) END/g
      )
    ).toHaveLength(3);
    expect(trade.body).not.toMatch(/coalesce\(\s*p[ft]\.alias\s*,\s*p[ft]\.display_name/i);
  });

  it('names a claim-back recipient with fn_arena_name, and a missing profile Member', () => {
    expect(squash(reversible.body)).toContain(
      `CASE WHEN pr.id IS NULL THEN 'Member' ELSE ${arena('pr')} END::text`
    );
    expect(reversible.body).not.toMatch(/nullif\(\s*btrim\(\s*pr\.display_name/i);
  });

  it('keeps who sees what', () => {
    expect(trade.body).toContain("IF v_role IN ('owner', 'co_owner', 'admin') THEN");
    expect(trade.body).toContain('FROM public.fn_club_active_cashier_edges(p_club_id) edge');
    expect(trade.body).toContain('AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)');
    expect(reversible.body).toContain('and t.from_user_id = auth.uid()');
  });
});
