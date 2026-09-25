/**
 * ===========================================================================
 *  LAW: A TOURNAMENT CANNOT COMPLETE OWING ITS POOLS
 * ===========================================================================
 *
 * Two hourly pg_cron jobs paid tournament money after the fact:
 *
 *   ca-payout-sweep-hourly    fn_tournament_payout_sweep(7, true, 150000)
 *                             tops up unpaid places of COMPLETED events
 *   ca-bounty-backpay-hourly  fn_backpay_unfinalised_bounty_pools(true, 200)
 *                             pays bounty pools that were never finalised
 *
 * They existed because a tournament could reach COMPLETED with part of its
 * prize pool or bounty pool unpaid (docs/BAND-AIDS-REGISTER.md, tier 1, rows
 * 1 and 3). That is no longer possible, and this law is what keeps it so.
 *
 * 20260909014534 made COMPLETED a promise the database checks at commit:
 *
 *   - non_satellite_completed_requires_terminal_receipt is a DEFERRABLE
 *     INITIALLY DEFERRED constraint trigger on public.tournaments; a
 *     non-satellite event cannot commit COMPLETED without a row in
 *     tournament_terminal_settlements;
 *   - the only writer of that row is the atomic terminal authority, which
 *     refuses to write it unless the cash pool was paid to the cent
 *     (v_cash_total = prize_pool) and the bounty pool was paid to the cent
 *     (v_bounty_total = bounty_pool), in the same transaction.
 *
 * MEASURED 2026-09-22, read-only. The first receipt is 2026-09-09 22:01:30;
 * the last non-satellite completion without one is 21:52:28 that night; from
 * then on every non-satellite completion carries one (59,333 receipts). In
 * the 30-day window, 0 of 184,031 COMPLETED non-satellite events with a pool
 * have paid less than it. 0 of 154 bounty events completed since the cutover
 * hold an undistributed bounty pool. The hourly sweep's own payouts
 * (source 'reconcile', written at minute 52) last happened on 2026-09-06; the
 * bounty backpay's last payment was 2026-09-03 09:12.
 *
 * So the jobs have nothing left to catch, and retiring them leaves exactly one
 * barrier between a player and an unpaid pool: this trigger. It must never be
 * dropped or disabled quietly, and its function must never grow an exemption.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const ORIGIN = '20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql';
const TRIGGER = 'non_satellite_completed_requires_terminal_receipt';
const GUARD_FUNCTION = 'fn_non_satellite_completed_requires_terminal_receipt';
const REFUSAL = 'cannot become COMPLETED without its atomic terminal receipt';

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

/** Blank SQL comments, keep literals and dollar-quoted bodies, preserve length. */
const code = (sql: string): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    if (sql[i] === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.substring(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        const body = end < 0 ? n : end;
        // Comments inside a body are comments too.
        const inner = code(sql.substring(j + 1, body));
        for (let k = 0; k < inner.length; k++) out[j + 1 + k] = inner[k];
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

const squash = (s: string): string => s.replace(/\s+/g, ' ');

describe('a tournament cannot complete owing its pools', () => {
  const origin = code(read(ORIGIN));

  it('COMPLETED is checked at commit by a deferred constraint trigger', () => {
    expect(squash(origin)).toContain(
      `CREATE CONSTRAINT TRIGGER ${TRIGGER} AFTER INSERT OR UPDATE OF status ON public.tournaments ` +
        `DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${GUARD_FUNCTION}();`
    );
  });

  it('the trigger refuses a receiptless completion and exempts satellites only', () => {
    const guard = sliceBetween(origin, '$terminal_status_guard$', '$terminal_status_guard$;');
    expect(guard).toContain('FROM public.tournament_terminal_settlements h');
    expect(guard).toContain(REFUSAL);
    // Exactly two early returns: not COMPLETED, or a satellite.
    expect(guard.match(/RETURN NEW;/g)).toHaveLength(3);
    expect(guard).toContain("lower(COALESCE(NEW.variant::text,'')) = 'satellite'");
    expect(guard).toContain('NEW.satellite_target_id IS NOT NULL');
  });

  it('the only receipt writer refuses a pool it did not pay to the cent', () => {
    const authority = sliceBetween(origin, 'AS $complete_terminal$', '$complete_terminal$;');
    const cash = authority.indexOf('IF v_cash_total IS DISTINCT FROM v_t.prize_pool');
    const bounty = authority.indexOf('IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool');
    const receipt = authority.indexOf('INSERT INTO public.tournament_terminal_settlements');
    expect(cash).toBeGreaterThan(-1);
    expect(bounty).toBeGreaterThan(cash);
    expect(receipt).toBeGreaterThan(bounty);
  });

  it('THE ONE THAT MATTERS LATER: nothing after the origin drops, disables or loosens it', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql') || file <= ORIGIN) continue;
      const sql = code(read(file));
      const flat = squash(sql);

      const drops = new RegExp(`DROP TRIGGER (?:IF EXISTS )?${TRIGGER}\\b`, 'i').test(flat);
      const recreates = flat.includes(
        `CREATE CONSTRAINT TRIGGER ${TRIGGER} AFTER INSERT OR UPDATE OF status ON public.tournaments DEFERRABLE INITIALLY DEFERRED`
      );
      if (drops && !recreates)
        offenders.push(`${file}: drops ${TRIGGER} without recreating it deferred`);
      if (new RegExp(`DISABLE TRIGGER (?:${TRIGGER}|ALL|USER)\\b`, 'i').test(flat)) {
        offenders.push(`${file}: disables ${TRIGGER} (or every trigger on a table)`);
      }
      if (
        new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${GUARD_FUNCTION}\\s*\\(`, 'i').test(
          flat
        ) &&
        !flat.includes(REFUSAL)
      ) {
        offenders.push(`${file}: redefines ${GUARD_FUNCTION} without its refusal`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
