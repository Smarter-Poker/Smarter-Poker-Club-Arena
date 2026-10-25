/**
 * THE DIAMOND HOUSE IS READ AT ONE INSTANT AT BOTH ENDS (2026-10-25).
 *
 * Pinned on migration 20261025031932. Two DR11:trial_balance_break incidents on
 * the diamond_house row were clocks, not money:
 *
 *   920238  2026-10-24 23:20 UTC  critical  -16400  (a 16400 overlay return,
 *           created_at 23:20:00.073, committed while the watch's 78 s first
 *           statement ran: the house balance missed it, the later windowed SUM
 *           of the Mint counted it)
 *   912029  2026-10-20 01:20 UTC  warning   +655    (a 655 tournament fee,
 *           created_at 01:09:55.98, committed after the 01:10:00.62 snapshot read
 *           house_balance: the balance counted it, the window starting at the
 *           snapshot's taken_at did not)
 *
 * fn_ca_diamond_trial_balance read the house balance in its one statement and
 * then summed the house Mint rows and the house ledger in LATER statements,
 * windowed by created_at / at, which is the writing transaction's START time.
 *
 * The cause is pinned here, not the symptom:
 *   1. the snapshot stores the house Mint net and the house ledger total from
 *      the SAME statement that reads house_balance;
 *   2. the trial balance reads the same two figures in its existing single
 *      statement and measures the house row as end minus stored start, with
 *      the windowed SUM kept only for a window snapshot that predates the
 *      columns;
 *   3. nothing else moves: no watch, threshold, auto-resolve, schedule,
 *      backfill, incident edit, index or grant.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261025031932_the_diamond_house_is_read_at_one_instant_at_both_ends.sql'
  ),
  'utf8'
);

/** Everything the migration executes: the file without its `--` comment lines. */
const executed = sql
  .split('\n')
  .filter((line) => !/^--/.test(line))
  .join('\n');

/** The dollar-quoted members of every `$tag$...$tag$` for a tag, in order. */
function quoted(tag: 'o' | 'n'): string[] {
  const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, 'g');
  return [...executed.matchAll(re)].map((m) => m[1]);
}

const anchors = quoted('o');
const replacements = quoted('n');
// The first four pairs patch the snapshot, the last four the trial balance.
const SNAPSHOT_PAIRS = 4;
const snapNew = replacements.slice(0, SNAPSHOT_PAIRS).join('\n');
const tbOld = anchors.slice(SNAPSHOT_PAIRS).join('\n');
const tbNew = replacements.slice(SNAPSHOT_PAIRS).join('\n');

const HOUSE_MINT_NET =
  "(SELECT COALESCE(SUM(CASE WHEN h.action = 'mint' THEN h.amount ELSE -h.amount END), 0)\n            FROM public.ca_mint_ledger h WHERE h.asset = 'diamonds' AND h.holder_type = 'house')";
const HOUSE_LEDGER_TOTAL =
  '(SELECT COALESCE(SUM(hl.delta), 0) FROM public.ca_diamond_house_ledger hl)';
const WINDOWED_MINT = "ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now()";
const WINDOWED_LEDGER = 'FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now()';

describe('the diamond house is read at one instant at both ends', () => {
  it('is one transaction that adds two nullable columns and edits only the two pinned texts', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '3s';$/m);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(executed).toMatch(
      /ALTER TABLE public\.ca_diamond_snapshots\n {2}ADD COLUMN IF NOT EXISTS house_register numeric,\n {2}ADD COLUMN IF NOT EXISTS house_ledger_total numeric;/
    );
    // Nullable and with no default: old rows stay NULL and nothing is rewritten.
    expect(executed).not.toMatch(/house_register numeric (NOT NULL|DEFAULT)/i);
    expect(executed).not.toMatch(/house_ledger_total numeric (NOT NULL|DEFAULT)/i);
    // The preimages are the live texts installed by 20261004231413.
    expect(sql).toMatch(
      /'public\.fn_ca_diamond_snapshot\(\)',\n {2}'2419d7a9c757d9a0135b8fec75edd2c8', '[0-9a-f]{32}',/
    );
    expect(sql).toMatch(
      /'public\.fn_ca_diamond_trial_balance\(timestamp with time zone\)',\n {2}'70f9022bd9944863dd7390f03e869c8b', '[0-9a-f]{32}',/
    );
    expect(executed).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
    expect(anchors).toHaveLength(8);
    expect(replacements).toHaveLength(8);
  });

  it('stores the house Mint net and ledger total from the statement that reads house_balance', () => {
    // Both figures sit inside the snapshot's single SELECT ... INTO, which also
    // reads ca_diamond_house.balance, and are written beside house_balance.
    expect(snapNew).toContain(
      `${HOUSE_MINT_NET},\n         ${HOUSE_LEDGER_TOTAL}\n    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix,\n         v_house_reg, v_house_ledger_total;`
    );
    expect(snapNew).toContain(
      'register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds,\n     house_register, house_ledger_total)'
    );
    expect(snapNew).toContain(
      'v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix,\n     v_house_reg, v_house_ledger_total);'
    );
    expect(executed).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot',"
    );
  });

  it('measures the house row on stored figures, reading the end in the single statement', () => {
    // The ledger total joins the existing single statement; the house Mint net
    // was already read there as v_reg_house.
    expect(tbNew).toContain(
      `${HOUSE_LEDGER_TOTAL}\n    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix,\n         v_house_ledger_total;`
    );
    expect(tbNew).toMatch(
      /IF s0\.id IS NOT NULL AND s0\.house_register IS NOT NULL THEN\n\s+v_mint := v_reg_house - s0\.house_register;\n\s+ELSE\n[\s\S]*?END IF;/
    );
    expect(tbNew).toMatch(
      /IF s0\.id IS NOT NULL AND s0\.house_ledger_total IS NOT NULL THEN\n\s+v_house_ledger := v_house_ledger_total - s0\.house_ledger_total;\n\s+ELSE\n[\s\S]*?END IF;/
    );
  });

  it('keeps the windowed sums only as the fallback for a snapshot without the columns', () => {
    // The old reads were unconditional; each now appears once, inside an ELSE.
    expect(tbOld).toContain(WINDOWED_MINT);
    expect(tbOld).toContain(WINDOWED_LEDGER);
    expect(tbNew.split(WINDOWED_MINT)).toHaveLength(2);
    expect(tbNew.split(WINDOWED_LEDGER)).toHaveLength(2);
    expect(tbNew).toMatch(
      /v_mint := v_reg_house - s0\.house_register;\n\s+ELSE\n\s+SELECT COALESCE\(SUM\(CASE WHEN ml\.action = 'mint'[^;]*ml\.created_at >= w0 AND ml\.created_at < now\(\);\n\s+END IF;/
    );
    expect(tbNew).toMatch(
      /v_house_ledger := v_house_ledger_total - s0\.house_ledger_total;\n\s+ELSE\n\s+SELECT COALESCE\(SUM\(delta\), 0\) INTO v_house_ledger FROM public\.ca_diamond_house_ledger WHERE at >= w0 AND at < now\(\);\n\s+END IF;/
    );
    // The note says which reading it was.
    expect(tbNew).toContain('(no window skew)');
    expect(tbNew).toContain('(boundary skew possible)');
  });

  it('leaves every other row, the watch and its auto-resolve exactly as they were', () => {
    // Only the house section and the two declarations are touched in the trial
    // balance: no anchor reaches another account's arithmetic.
    for (const a of anchors.slice(SNAPSHOT_PAIRS)) {
      expect(a).not.toMatch(/player_diamonds|fixture_accounts|arena_wallets|'register'|'total'/);
      expect(a).not.toMatch(/v_diff := v_delta|RETURN QUERY/);
    }
    expect(executed).not.toMatch(/fn_ca_diamond_trial_balance_watch/);
    expect(executed).not.toMatch(/UPDATE public\.ca_diamond_incidents|DELETE FROM/);
    expect(executed).not.toMatch(/INSERT INTO public\.ca_diamond_snapshots/);
    expect(executed).not.toMatch(/UPDATE public\.ca_diamond_snapshots/);
    expect(executed).not.toMatch(/cron\.(schedule|alter_job|unschedule)/);
    expect(executed).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(executed).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(executed).not.toMatch(/statement_timeout\s*(=|TO)\s*'?0/i);
  });
});
