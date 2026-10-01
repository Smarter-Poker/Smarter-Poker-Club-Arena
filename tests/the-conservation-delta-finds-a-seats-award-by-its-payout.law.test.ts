/**
 * THE CONSERVATION DELTA FINDS A SEAT'S AWARD BY ITS PAYOUT, NOT BY ITS PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_tournament_conservation_delta decides, for every satellite payout row,
 * whether it was a seat, a held ticket or cash by reading the award that
 * delivered it (tournament_satellite_awards.delivery_kind and its ticket).
 * It used to find that award with (tournament_id, place = position).
 *
 * 592 satellite payout rows (426 'satellite_ticket', 166 'satellite_seat')
 * written from 2026-09-18 to 2026-10-01 by version-3 multi-qualifier satellites carry a
 * NULL position. For each of them the place join found no award and no ticket, so
 * an ISSUED, never-redeemed ticket read as the legacy direct seat and was
 * credited to its target as an entry. Every satellite-fed event that ended
 * afterwards read "retained money it never paid out" by exactly the value of
 * those tickets: 20 positive open financial_alerts on 2026-10-01, each delta
 * equal to the penny to its NULL-position ticket rows (20.00 ... 2,850.00).
 * 20260926092142 closed eleven of them by hand as noise and left the
 * detector unchanged, so it raised them again within a day (22 open on
 * 2026-10-01: these 20 and the two bubble events below).
 *
 * The same join in fn_pay_backed_payout_shortfalls and
 * fn_satellite_conservation_audit is covered by
 * a-satellite-award-is-found-by-its-payout.law.test.ts.
 *
 * The award's own key to its payout is payout_id (unique index
 * tournament_satellite_awards_payout_id_key), and every award row carries it.
 * A position is a ranking column that can be absent; it is not the link.
 *
 * The same migration counts house-funded bubble protection: two events of
 * 2026-09-06 funded a 180.00 bubble_protection payout with a chip_ledger
 * 'correction' leg into prize_liability, which the overlay term never read,
 * so both sat at -180.00 forever. A leg counts only when it pairs one to one
 * with a bubble_protection payout of the same amount (LEAST(legs, payouts)).
 *
 * IF THIS TEST IS FAILING you restated fn_tournament_conservation_delta and
 * went back to locating the award by place, or dropped the bubble term. Join
 * the award ON a.payout_id = sp.id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit version prefix: lexical order is chronological order

/** The executable body (comments stripped) of the newest restatement. */
function newestDefinition(fn: string): { file: string; body: string } {
  let found = { file: '', body: '' };
  const open = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i');
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const at = sql.search(open);
    if (at === -1) continue;
    const rest = sql.slice(at);
    const end = rest.indexOf('$function$;');
    found = { file: f, body: end === -1 ? rest : rest.slice(0, end) };
  }
  return {
    file: found.file,
    body: found.body
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n'),
  };
}

const delta = newestDefinition('fn_tournament_conservation_delta');

/** Every ON clause that joins tournament_satellite_awards, whitespace-folded. */
function awardJoins(body: string): string[] {
  const out: string[] = [];
  const re = /JOIN\s+public\.tournament_satellite_awards\s+(\w+)\s+ON\s+([\s\S]*?)(?=\bLEFT\s+JOIN\b|\bJOIN\b|\bWHERE\b)/gi;
  for (const m of body.matchAll(re)) out.push(`${m[1]}: ${m[2].replace(/\s+/g, ' ').trim()}`);
  return out;
}

describe('the conservation delta finds a satellite award by its payout', () => {
  it('the delta is defined and joins the award table at least twice (arriving and leaving)', () => {
    expect(delta.file, 'no migration defines fn_tournament_conservation_delta').toBeTruthy();
    expect(awardJoins(delta.body).length).toBeGreaterThanOrEqual(2);
  });

  it('every award join is by payout_id, the award row\'s own unique key to its payout', () => {
    for (const join of awardJoins(delta.body)) {
      expect(
        join,
        `fn_tournament_conservation_delta (${delta.file}) locates an award with "${join}". ` +
          `A satellite_ticket payout can carry a NULL position, and then an unredeemed ticket ` +
          `reads as an arrived seat. Join ON a.payout_id = sp.id.`
      ).toMatch(/\bpayout_id\s*=\s*sp\.id\b/);
    }
  });

  it('no award is located by place = position', () => {
    expect(delta.body).not.toMatch(/\.place\s*=\s*\w+\.position\b/i);
  });

  it('house-funded bubble protection is counted as funding, matched by its payout', () => {
    expect(delta.body).toMatch(/category\s*=\s*'correction'/);
    expect(delta.body).toMatch(/source\s*=\s*'bubble_protection'/);
    expect(delta.body).toMatch(/\+\s*m\.funded_bubble\b/);
  });

  it('a bubble_protection payout pairs with at most one correction leg (one to one, per amount)', () => {
    // An EXISTS match would let one 180.00 payout absorb two 180.00 legs and
    // count 360.00 of funding. Per amount the term takes LEAST(legs, payouts).
    expect(delta.body).toMatch(/LEAST\s*\(\s*c\.n\s*,\s*b\.n\s*\)/);
    expect(delta.body).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.tournament_payouts\s+bp\b/i);
  });
});
