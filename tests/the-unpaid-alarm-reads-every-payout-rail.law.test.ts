/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UNPAID ALARM READS EVERY PAYOUT RAIL, AND NO TOURNAMENT FINISHES UNPAID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-09 18:30 CT, on the push "Money Check Failed: 2 completed
 * tournament(s) with a prize pool and no payout": "HOW ARE TOURNAMENTS EVER
 * FAILING TO PAY OUT ... WHAT NEEDS TO HAPPEN FOR THIS TO NEVER EVER HAPPEN
 * AGAIN ... OR EVEN BE AN OPTION TO HAPPEN".
 *
 * Nobody was unpaid. `TournamentCompletedUnpaid` reads
 * `fn_tournament_metrics().unpaid_completed`, which accepted a payout only as a
 * chip wallet prize row or a satellite award. Diamond Arena events pay in
 * Diamonds - a `poker_diamond_tournament_ledger` prize row carrying its
 * `diamond_transactions` journal - so from 2026-10-07, the day Diamond events
 * began finishing, every one with a prize pool read as "nobody was paid" and
 * paged the owner: 32 events, all paid in full (143,069 of 143,069 Diamonds).
 *
 * It is the second time this gauge has cried wolf for the same reason. On
 * 2026-09-12 it fired twelve times in fourteen days and all twelve were
 * satellites that had paid in seats (server/src/tournament/
 * aSatelliteSeatIsAPayout.law.test.ts). Each time a new way of paying arrived,
 * the gauge did not hear about it. An alarm that is wrong every time it fires
 * is the loss of the alarm: the day a tournament genuinely pays nobody, the
 * page looks exactly like the last thirty-two.
 *
 * So this pins two things.
 *
 * 1. THE ALARM'S CURRENT DEFINITION READS EVERY RAIL. Not a named migration -
 *    the newest one that defines the function, because that is the one
 *    production runs. A rewrite that drops a rail, or a new rail that is not
 *    added, fails here. A new payout rail is added to RAILS below AND to the
 *    function, in the same pull request.
 *
 * 2. THE UNPAID STATE CANNOT BE WRITTEN. MTTs, Spins and Sit & Gos reach
 *    COMPLETED only with their atomic terminal receipt
 *    (`non_satellite_completed_requires_terminal_receipt`). Satellites had no
 *    lock: `aaa_guard_atomic_satellite_completion` was installed DISABLED on
 *    2026-09-08 and checks a batch table the live engine never writes, so it
 *    would refuse every satellite if enabled. The live lock is
 *    `satellite_completed_requires_settlement_receipt`, checked at COMMIT, and
 *    it is declared in the money-trigger register like every other trigger on
 *    a money table. None of the three may be undone by a later migration.
 *
 * docs/changelog/2026-10-09-the-unpaid-alarm-reads-every-payout-rail.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const raw = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

/** Executable SQL only: `--` comment lines are stripped, so prose cannot satisfy a pin. */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The function body from its CREATE to the closing dollar quote. */
function bodyOf(sql: string, fn: string): string | null {
  const head = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  const m = head.exec(sql);
  if (!m) return null;
  const rest = sql.slice(m.index);
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest);
  if (!tag) return null;
  const open = rest.indexOf(tag[1], tag.index) + tag[1].length;
  const close = rest.indexOf(tag[1], open);
  return close < 0 ? null : rest.slice(0, close + tag[1].length);
}

/** The newest migration that defines `fn` - the definition production runs. */
function currentDefinition(fn: string): { file: string; body: string } {
  for (let i = FILES.length - 1; i >= 0; i -= 1) {
    const body = bodyOf(executable(raw(FILES[i])), fn);
    if (body) return { file: FILES[i], body };
  }
  throw new Error(`no migration defines public.${fn} - was it renamed?`);
}

/** Every rail that delivers prize-pool value. A new rail is added here and to the function. */
const RAILS: Array<{ rail: string; delivered: RegExp }> = [
  {
    rail: 'a chip prize on the wallet ledger',
    delivered:
      /FROM\s+wallet_transactions\s+w\s+WHERE\s+w\.related_entity_id\s*=\s*t\.id\s+AND\s+w\.category\s*=\s*'prize'/i,
  },
  {
    rail: 'a Diamond prize on the Diamond tournament ledger, with its journal',
    delivered:
      /FROM\s+poker_diamond_tournament_ledger\s+d\s+WHERE\s+d\.tournament_id\s*=\s*t\.id\s+AND\s+d\.kind\s*=\s*'prize'\s+AND\s+d\.wallet_journal_id\s+IS\s+NOT\s+NULL/i,
  },
  {
    rail: 'a satellite award (a seat or a ticket)',
    delivered: /FROM\s+tournament_satellite_awards\s+a\s+WHERE\s+a\.tournament_id\s*=\s*t\.id/i,
  },
];

describe('the unpaid alarm reads every payout rail', () => {
  const metrics = () => currentDefinition('fn_tournament_metrics');

  it('is defined no earlier than the Diamond rail fix', () => {
    // Moving the definition backwards in time is how a rail quietly drops out.
    expect(metrics().file >= '20261010012101').toBe(true);
  });

  it.each(RAILS)('accepts $rail as payment', ({ delivered }) => {
    expect(metrics().body).toMatch(delivered);
  });

  it('asks each rail as a NOT EXISTS, so any one delivery clears the event', () => {
    const probes = metrics().body.match(/AND\s+NOT\s+EXISTS\s*\(/gi) ?? [];
    expect(probes.length).toBeGreaterThanOrEqual(RAILS.length);
  });

  it('does not accept a payout row as proof that anything was delivered', () => {
    // tournament_payouts is written by the payout code itself: it evidences
    // INTENT. The alarm exists to catch intent that delivered nothing.
    expect(metrics().body).not.toMatch(/tournament_payouts/);
  });

  it('does not count a bounty as a prize', () => {
    // A tournament that paid every bounty and not one place is unpaid.
    expect(metrics().body).not.toMatch(/'bounty'/);
  });
});

describe('no tournament can become COMPLETED unpaid', () => {
  const creation = (re: RegExp): string => {
    const file = FILES.find((f) => re.test(executable(raw(f))));
    if (!file) throw new Error(`no migration matches ${re}`);
    return file;
  };
  const SATELLITE_LOCK_FILE = () =>
    creation(/CREATE\s+CONSTRAINT\s+TRIGGER\s+satellite_completed_requires_settlement_receipt\b/i);
  const later = (file: string) => FILES.filter((f) => f > file).map((f) => [f, executable(raw(f))] as const);

  it('a satellite completes only with its settlement receipt, checked at COMMIT', () => {
    const sql = executable(raw(SATELLITE_LOCK_FILE()));
    expect(sql).toMatch(
      /CREATE\s+CONSTRAINT\s+TRIGGER\s+satellite_completed_requires_settlement_receipt\s+AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+status\s+ON\s+public\.tournaments\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i
    );
    const fn = bodyOf(sql, 'fn_satellite_completed_requires_settlement_receipt');
    expect(fn).not.toBeNull();
    expect(fn!).toMatch(
      /FROM\s+public\.tournament_satellite_settlements\s+s\s+WHERE\s+s\.tournament_id\s*=\s*NEW\.id\s+AND\s+s\.source_escrow_closed_at\s+IS\s+NOT\s+NULL/i
    );
    expect(fn!).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it('covers exactly what the non-satellite lock leaves out', () => {
    // Between the two locks every COMPLETED transition is judged. The
    // non-satellite lock skips variant, tournament_type, satellite_target_id
    // and satellite_target; this one must take all four.
    const fn = bodyOf(executable(raw(SATELLITE_LOCK_FILE())), 'fn_satellite_completed_requires_settlement_receipt')!;
    for (const column of ['variant', 'tournament_type', 'satellite_target_id', 'satellite_target']) {
      expect(fn).toMatch(new RegExp(`NEW\\.${column}\\b`));
    }
  });

  it('is declared in the money-trigger register', () => {
    const declared = FILES.some((f) =>
      /INSERT\s+INTO\s+public\.ca_declared_money_triggers[\s\S]*'tournaments'\s*,\s*'satellite_completed_requires_settlement_receipt'/i.test(
        executable(raw(f))
      )
    );
    expect(declared).toBe(true);
  });

  it('no later migration drops or disables either lock', () => {
    const undo =
      /(DROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?|DISABLE\s+TRIGGER\s+)(satellite_completed_requires_settlement_receipt|non_satellite_completed_requires_terminal_receipt)\b/i;
    const offenders = later(SATELLITE_LOCK_FILE())
      .filter(([, sql]) => undo.test(sql))
      .map(([f]) => f);
    expect(offenders, 'a lock that keeps an unpaid tournament from finishing was removed').toEqual([]);
  });

  it('no later migration enables the obsolete batch guard, which would refuse every satellite', () => {
    const enable = /ENABLE\s+(ALWAYS\s+|REPLICA\s+)?TRIGGER\s+aaa_guard_atomic_satellite_completion\b/i;
    const offenders = later(SATELLITE_LOCK_FILE())
      .filter(([, sql]) => enable.test(sql))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
