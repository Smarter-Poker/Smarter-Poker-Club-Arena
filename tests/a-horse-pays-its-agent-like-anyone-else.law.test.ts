import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HORSE PAYS ITS AGENT LIKE ANYONE ELSE (binding)
 *
 * Dan, 2026-08-27, BINDING: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
 * ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"
 * Dan, 2026-09-03, asked directly whether horse rake should count toward an
 * agent's commission: "YES IT SHOULD COUNT AS AGENTS COMMISSION."
 *
 * It already does, because nothing in the chain filters them - and that is
 * precisely why this law exists. The behaviour is correct by ABSENCE, and an
 * absence is the easiest thing in the world for somebody to add back. One
 * `AND NOT cm.is_bot`, added because it looked tidy, would be invisible in
 * review and catastrophic in production.
 *
 * HOW CATASTROPHIC, measured on the Deep Stack Society club: 584 of its
 * members are horses, 582 of them are assigned to an agent, and over thirty
 * days they produced 828,852.06 of the club's 828,861.03 in rake. Excluding
 * them would not trim an agent's commission. It would erase 99.999 percent of
 * it, silently, and the totals would still reconcile with each other.
 *
 * WHY A SECOND GATE, when check-horses-are-players already exists. Because
 * that gate walks `src` and `server/src` for .ts and .tsx, and every function
 * named below is SQL. The binding law is enforced in the client and the engine
 * and NOT in the database - which is where the rake, the commission and the
 * settlement actually live. This closes that hole for the money chain
 * specifically; the wider hole is worth closing too.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

/**
 * The chain that turns a hand into an agent's commission. Each entry is the
 * function and the reason it is on this list.
 */
const MONEY_CHAIN: Array<[string, string]> = [
  ['fn_rake_shares_for_record', 'splits one hand of rake across the players in it'],
  ['fn_ca_rake_by_agent', 'totals a club by agent, and carries the commission columns'],
  ['fn_agent_downline_rake', 'walks the downline every commission figure is built from'],
  ['fn_club_commission_accrued', 'the club bill the agent columns must reconcile against'],
];

/** Anything that would let a horse be treated as not-a-player. */
const HORSE_PREDICATE = /\bis_bot\b|\bis_horse\b/;

function latestDefining(fnName: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let file = '';
  let sql = '';
  for (const f of files) {
    const text = readFileSync(resolve(MIGRATIONS, f), 'utf8');
    if (text.includes(`FUNCTION public.${fnName}(`)) {
      file = f;
      sql = text;
    }
  }
  return { file, sql };
}

/** Just that function, and without its comments - prose may discuss horses. */
function body(fnName: string): string {
  const { sql } = latestDefining(fnName);
  const start = sql.indexOf(`FUNCTION public.${fnName}(`);
  if (start < 0) return '';
  const end = sql.indexOf('$function$;', start);
  return sql
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

describe('a horse pays its agent like anyone else', () => {
  it.each(MONEY_CHAIN)('%s is defined by a migration in this repo', (fn) => {
    const { file } = latestDefining(fn);
    expect(file, `nothing in supabase/migrations defines ${fn}`).not.toBe('');
  });

  it.each(MONEY_CHAIN)('%s does not know a horse from a player (%s)', (fn) => {
    const sql = body(fn);
    expect(sql, `${fn} has no readable body`).not.toBe('');
    const hit = HORSE_PREDICATE.exec(sql);
    expect(
      hit,
      hit
        ? `${fn} tests ${hit[0]}. If a horse is being paid differently on purpose, ` +
          'that is a change to a binding law and belongs in a conversation, not a WHERE clause.'
        : ''
    ).toBeNull();
  });

  it('the commission column is the ledger, not a filtered recomputation', () => {
    // Reading agent_commissions rather than recomputing from rake is what
    // keeps this honest: there is no player loop here to quietly add a
    // predicate to, and the cascade is already expanded per recipient.
    const sql = body('fn_ca_rake_by_agent');
    expect(sql).toMatch(/FROM public\.agent_commissions ac/);
    expect(sql).toMatch(/SUM\(ac\.amount\)/);
  });

  it('says out loud that the existing horse gate cannot see SQL', () => {
    // If check-horses-are-players ever grows to scan migrations, this law
    // becomes a belt beside a brace and the comment above should be corrected
    // rather than left claiming a hole that has been filled.
    const gate = readFileSync(
      resolve(__dirname, '../scripts/ci/check-horses-are-players.mjs'),
      'utf8'
    );
    const exts = /const EXTS = new Set\(\[([^\]]*)\]\)/.exec(gate);
    expect(exts, 'the gate no longer declares which extensions it walks').not.toBeNull();
    expect(
      exts ? exts[1] : '',
      'the gate now scans .sql, so this law is no longer the only thing guarding the money chain'
    ).not.toMatch(/\.sql/);
  });
});
