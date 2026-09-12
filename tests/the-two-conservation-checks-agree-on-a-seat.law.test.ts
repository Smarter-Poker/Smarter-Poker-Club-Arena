/**
 * THE TWO CONSERVATION CHECKS AGREE ON WHAT A DELIVERED SEAT IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two functions answer the same question about the same rows:
 *
 *   fn_satellite_conservation_audit    - did this satellite disburse its pool?
 *   fn_tournament_conservation_delta   - does this tournament's money balance?
 *
 * Both have to decide, for a `tournament_payouts` row, "is this a SEAT that was
 * delivered, or is it cash?" A seat has no wallet credit to find, so each
 * function carries its own list of `tournament_payouts.source` values that mean
 * "a seat left here". THE LISTS ARE NOT SHARED, AND ON 2026-09-09 ONLY ONE OF
 * THEM WAS UPDATED.
 *
 * That day satellite seat delivery gained a second path - a ticket, payout
 * source 'satellite_ticket'. The audit was taught about it the same day
 * (20260909235715, 20260909235935) and refined the next (20260910064305). The
 * delta was not: both its seat terms still read `source = 'satellite_seat'`.
 *
 * The cost, measured before this law was written: 120 open financial_alerts,
 * 117 of them "Tournament retained money it never paid out", totalling exactly
 * 9,100.00 - which is, to the penny, the value of the 118 ticket-delivered
 * seats the delta could not see. No money was ever missing. Every chip was in
 * an issued ticket held by the player who won it. The alerts were false, and
 * 117 false alerts is how a real one goes unnoticed.
 *
 * Nothing checked that the two lists agree. This does.
 *
 * WHY IT READS EVERY MIGRATION THAT MENTIONS THE AUDIT, NOT JUST THE NEWEST
 * DEFINITION OF IT: 20260910064305 does not restate the function. It reads
 * `pg_get_functiondef`, string-replaces one branch and EXECUTEs the result, so
 * the newest `CREATE OR REPLACE` for that function is two migrations older than
 * the behaviour actually running. A test that read only the newest definition
 * would have a blind spot exactly where the last change was made.
 *
 * IF THIS TEST IS FAILING you have almost certainly taught one of the two
 * functions about a new seat-delivery source. Teach the other one in the same
 * commit. Do not delete a source from either list to make the sets match -
 * that is the 2026-09-09 bug with the sign flipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort(); // 14-digit version prefix: lexical order is chronological order

const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

/**
 * Every `tournament_payouts.source` literal named 'satellite_*' that this SQL
 * compares against, in either shape a migration can carry it:
 *
 *   AND sp.source = 'satellite_seat'
 *   AND p.source IN ('satellite_seat', 'satellite_ticket')
 *
 * `''` is folded to `'` first, because a migration that patches a function by
 * building SQL inside an E'...' string writes every quote doubled.
 */
function seatSources(sql: string): Set<string> {
  const flat = sql.replace(/''/g, "'");
  const out = new Set<string>();

  for (const m of flat.matchAll(/\bsource\s+IN\s*\(([^)]*)\)/gi)) {
    for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) {
      if (lit[1].startsWith('satellite_')) out.add(lit[1]);
    }
  }
  for (const m of flat.matchAll(/\bsource\s*=\s*'([a-z_]+)'/gi)) {
    if (m[1].startsWith('satellite_')) out.add(m[1]);
  }
  return out;
}

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

/**
 * The audit's list, taken from every migration that touches it - a restatement
 * or a programmatic patch. Union, never "the last one wins": a patch only ever
 * adds to what is running.
 */
const AUDIT_FN = 'fn_satellite_conservation_audit';

/**
 * A file counts as evidence about the audit only if it RESTATES or PATCHES it.
 * Merely naming the function - a COMMENT, a changelog reference, a sweep that
 * calls it - is not evidence about its seat list, and counting such a file
 * would let a migration become its own witness: the delta's own migration
 * names the audit in its COMMENT, so without this the delta's sources would be
 * read back as the audit's and the comparison below could never fail.
 */
function isAuditAuthority(sql: string): boolean {
  if (!sql.includes(AUDIT_FN)) return false;
  const restates = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${AUDIT_FN}\\s*\\(`,
    'i'
  ).test(sql);
  // 20260910064305 does not restate it: it reads pg_get_functiondef, replaces
  // one branch and EXECUTEs the result.
  const patches = sql.includes('pg_get_functiondef');
  return restates || patches;
}

const auditSources = new Set<string>();
const auditFiles: string[] = [];
for (const f of files) {
  const sql = read(f);
  if (!isAuditAuthority(sql)) continue;
  const found = seatSources(sql);
  if (found.size === 0) continue;
  auditFiles.push(f);
  for (const s of found) auditSources.add(s);
}

const deltaSources = seatSources(delta.body);

describe('the two conservation checks agree on what a delivered seat is', () => {
  it('both functions are still defined in the migrations, and both name seat sources', () => {
    expect(delta.file, 'no migration defines fn_tournament_conservation_delta').toBeTruthy();
    expect(auditFiles.length, `no migration names seat sources for ${AUDIT_FN}`).toBeGreaterThan(0);
    expect(deltaSources.size, 'the delta names no satellite payout source at all').toBeGreaterThan(
      0
    );
  });

  it('every source the satellite audit counts as a funded seat is counted by the delta too', () => {
    const missing = [...auditSources].filter((s) => !deltaSources.has(s)).sort();
    expect(
      missing,
      `fn_tournament_conservation_delta (${delta.file}) does not count ${missing.join(', ')}, ` +
        `which ${AUDIT_FN} treats as a delivered seat (named in ${auditFiles.join(', ')}). ` +
        `A seat the delta cannot see reads as money the tournament kept. ` +
        `Teach the delta the same source, in this commit.`
    ).toEqual([]);
  });

  it('and the delta counts nothing as a seat that the audit does not', () => {
    const extra = [...deltaSources].filter((s) => !auditSources.has(s)).sort();
    expect(
      extra,
      `fn_tournament_conservation_delta counts ${extra.join(', ')} as a delivered seat but ` +
        `${AUDIT_FN} does not. One of the two is wrong; they read the same rows.`
    ).toEqual([]);
  });

  /**
   * The other half of the 2026-09-09 lesson. 48 'satellite_ticket' payouts are
   * delivery_kind='cash' - a capped winner paid in chips writes the same payout
   * row as a held ticket, and every one of them already holds a matching wallet
   * 'prize' credit. Counting those as seats double-subtracts and invents false
   * alerts pointing the other way. The award row is what tells them apart.
   */
  it('the delta decides seat-or-cash from the award row, not from the source alone', () => {
    expect(
      delta.body,
      `fn_tournament_conservation_delta (${delta.file}) counts satellite payouts without ` +
        `consulting tournament_satellite_awards.delivery_kind. A cash delivery is not a seat.`
    ).toContain('delivery_kind');
  });
});
