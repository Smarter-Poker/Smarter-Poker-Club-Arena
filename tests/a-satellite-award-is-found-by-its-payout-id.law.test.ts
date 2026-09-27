/**
 * A SATELLITE AWARD IS FOUND BY ITS PAYOUT_ID, NOT BY (TOURNAMENT_ID, PLACE).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_tournament_conservation_delta's seat_income and seat_paid_out CTEs find
 * a payout row's tournament_satellite_awards row like this:
 *
 *   LEFT JOIN tournament_satellite_awards a
 *          ON a.tournament_id = sp.tournament_id AND a.place = sp.position
 *
 * tournament_payouts.position is NULL on some genuine ticket-delivery rows -
 * a gap on that column, not a "no award exists" signal. When it is NULL the
 * join always misses, even though a real, unique award row exists (findable
 * by its own payout_id), and the code's own fallback -
 * `COALESCE(a.delivery_kind, 'seat')` - then treats a still-UNREDEEMED ticket
 * as "the legacy direct-seat path, which always arrived".
 *
 * Measured 2026-09-27: this raised 14 false "retained/paid money it never
 * collected" alerts (financial_alerts, fn_tournament_money_conservation)
 * against live, healthy, fully-balanced tournaments. "Six-Card Feature"
 * reported +160.00 retained; the true delta, joining on payout_id, is 0.00 -
 * the 160.00 was 8 unredeemed tickets (tournament_tickets.status='issued')
 * counted as arrived seats.
 *
 * tournament_satellite_awards.payout_id is UNIQUE, NOT NULL on every row
 * (measured: 0 of 2,084 live rows null), and FK-constrained to
 * tournament_payouts.id - it is the award's own pointer back to the exact
 * payout that created it and cannot miss on a null sibling column the way
 * (tournament_id, place) vs (tournament_id, position) can.
 *
 * IF THIS TEST IS FAILING you have reintroduced the (tournament_id, place)/
 * (tournament_id, position) join, or replaced payout_id with some other
 * derived key. Join on `a.payout_id = sp.id` in both CTEs; do not reach for
 * `position`/`place` again, even as a fallback - see the 2026-09-27 changelog
 * and migration 20260927212910 (which supersedes the unapplied 20260927091102) for the exact incident this guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit version prefix: lexical order is chronological order

const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

/** The body of the newest migration that restates this function. */
function newestDefinition(fn: string): { file: string; body: string } {
  let found = { file: '', body: '' };
  const open = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, 'i');
  for (const f of files) {
    const sql = read(f);
    const at = sql.search(open);
    if (at === -1) continue;
    const rest = sql.slice(at);
    const end = rest.indexOf('$function$;');
    found = { file: f, body: end === -1 ? rest : rest.slice(0, end) };
  }
  return found;
}

const delta = newestDefinition('fn_tournament_conservation_delta');

describe('fn_tournament_conservation_delta joins a satellite award by payout_id', () => {
  it('found a definition to check', () => {
    expect(delta.file, 'no migration defines fn_tournament_conservation_delta').not.toBe('');
  });

  it('joins tournament_satellite_awards on a.payout_id = sp.id', () => {
    // Every LEFT JOIN of tournament_satellite_awards inside this function
    // must key on payout_id, which is unique, NOT NULL, and FK-constrained
    // to tournament_payouts.id.
    const joins = [
      ...delta.body.matchAll(
        /LEFT\s+JOIN\s+public\.tournament_satellite_awards\s+a\s+ON\s+([^\n]+)/gi
      ),
    ].map((m) => m[1].trim());

    expect(
      joins.length,
      'expected at least one join to tournament_satellite_awards'
    ).toBeGreaterThan(0);

    for (const predicate of joins) {
      expect(predicate).toMatch(/a\.payout_id\s*=\s*sp\.id/i);
    }
  });

  it('never falls back to (tournament_id, place) vs (tournament_id, position)', () => {
    // This is the exact predicate that silently missed a real award row
    // whenever tournament_payouts.position was NULL.
    expect(delta.body).not.toMatch(
      /a\.tournament_id\s*=\s*sp\.tournament_id\s+AND\s+a\.place\s*=\s*sp\.position/i
    );
    expect(delta.body).not.toMatch(/a\.place\s*=\s*sp\.position/i);
  });
  it('keeps every term the function already had (the reviewed-void overlay return)', () => {
    // The first version of this fix was written against an older body and
    // would have dropped the 2026-09-27 15:09 reviewed-void overlay return.
    // A join fix restates the whole function; it must not lose a term.
    expect(delta.body).toMatch(/reviewed_void_overlay_return/);
    expect(delta.body).toMatch(/tournament_conservation_baseline/);
  });
});
