/**
 * THE JACKPOT IS ONE ALLOCATOR WITH AN OPENING BALANCE (chip standard Phase 4,
 * 2026-09-04). Pinned on the two migrations mirrored byte-exact from
 * production: 20260904210917 (4.3) and 20260904211714 (4.2).
 *
 * LAW 1 - ONE ALLOCATOR. A BBJ drop is split by fn_bbj_allocate reading
 *   ca_bbj_policy (50/25/25 below the pivot, 25/25/50 at or above it, promo
 *   the remainder); bbj_record_contribution and fn_bbj_repair_unbanked both
 *   use it and the caller's portions are ignored. The union pool's post-pivot
 *   over-allocation was moved main -> promo, asserted from the rows.
 * LAW 2 - A BANK MOVE IS DECLARED AND RECORDED. Reseed and the union's
 *   backup transfer go through fn_bbj_move_between_banks (bbj_pool ->
 *   bbj_pool legs, ca_bbj_bucket_moves row, op-keyed, refused if the source
 *   bank cannot cover it). An empty reserve at reseed files a bbj_error.
 * LAW 3 - EVERY JACKPOT DOOR DECLARES ITSELF. The payout is bbj_payout
 *   bbj_pool -> table_stack; a departed recipient's share is a keyed
 *   table_stack -> player_wallet credit to the TABLE's club wallet; funding
 *   and the backup transfer name their counterparty; pool_amount is no longer
 *   journalled; the retired stubs are closed; no BBJ money door is reachable
 *   from a browser.
 * LAW 4 - THE JACKPOT HAS AN OPENING BALANCE. ca_bbj_pool_snapshots carries a
 *   labelled baseline per pool and fn_bbj_reconcile measures each bank against
 *   the journal since the previous snapshot, in one statement; the hourly
 *   rake/BBJ audit runs it (no new cron) and files a bbj_error on a two-
 *   snapshot disagreement; fn_bbj_conservation_check keeps the lifetime gap
 *   readable and reports health on the epoch.
 * LAW 5 - DEEP STACK SOCIETY IS AN ESTATE. Its incidents file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const find = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`no migration matches ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};
const a = find(/^\d{14}_phase_4_3_one_bbj_allocator_and_every_jackpot_door_declares_itself\.sql$/);
const b = find(/^\d{14}_phase_4_2_the_jackpot_has_an_opening_balance_it_can_prove\.sql$/);

describe('LAW 1: one allocator', () => {
  it('the policy is a row and the allocator reads it', () => {
    expect(a).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_bbj_policy/);
    expect(a).toMatch(/VALUES \(1, 100000, 0\.50, 0\.25, 0\.25, 0\.25,/);
    expect(a).toMatch(/IF COALESCE\(p_main_balance, 0\) >= v_pol\.pivot_threshold THEN/);
    expect(a).toMatch(/promo_portion\s+:= round\(v_amt - main_portion - backup_portion, 2\);/);
  });
  it('the drop and the repair both use it; the caller portions are ignored', () => {
    const drop = a.slice(
      a.indexOf('CREATE OR REPLACE FUNCTION public.bbj_record_contribution('),
      a.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked(')
    );
    expect(drop).toMatch(/FROM public\.fn_bbj_allocate\(COALESCE\(p_amount, 0\), v_main_now\) a;/);
    expect(drop).not.toMatch(/round\(v_next_cum \* 0\.50, 2\)/);
    const repair = a.slice(
      a.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked('),
      a.indexOf('-- ── 5.')
    );
    expect(repair).toMatch(/FROM public\.fn_bbj_allocate\(r\.amt, v_current_main\) a;/);
    expect(repair).not.toMatch(/v_ratio_main := 0\.25/);
  });
  it('the post-pivot over-allocation was read from the rows and moved main -> promo', () => {
    expect(a).toMatch(/IF v_cross <> '2026-09-03 07:13:51\.966829\+00'::timestamptz THEN/);
    expect(a).toMatch(/round\(sum\(main_portion\) - sum\(amount\) \* 0\.25, 2\)/);
    expect(a).toMatch(/'pivot-correction:' \|\| c_pool::text \|\| ':2026-09-03'/);
    expect(a).toMatch(
      /IF round\(v_main_before - v_main_after, 2\) <> v_over OR round\(v_promo_after - v_promo_before, 2\) <> v_over THEN/
    );
  });
});

describe('LAW 1b: the allocator carries its rounding residue', () => {
  const c = find(/^\d{14}_phase_4_3_the_allocator_carries_its_rounding_residue\.sql$/);
  it('a per-pool fractional-cent residue makes the long-run split exact, and a replay consumes none of it', () => {
    expect(c).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_bbj_alloc_state/);
    expect(c).toMatch(/v_exact_m := v_amt \* v_rm \+ v_state\.main_residue;/);
    expect(c).toMatch(/main_residue\s+= round\(v_exact_m - main_portion, 6\)/);
    expect(c).toMatch(
      /FROM public\.fn_bbj_allocate\(COALESCE\(p_amount, 0\), v_main_now, p_pool_id\) a;/
    );
    expect(c).toMatch(/FROM public\.fn_bbj_allocate\(r\.amt, v_current_main, v_pool_id\) a;/);
    expect(c).toMatch(/A replayed hand must not consume the residue/);
    expect(c).toMatch(/RAISE EXCEPTION 'residue carry is not exact/);
  });
});

describe('LAW 2: a bank move is declared and recorded', () => {
  it('fn_bbj_move_between_banks declares bbj_pool -> bbj_pool, records the move, refuses what the bank cannot cover', () => {
    expect(a).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_bbj_bucket_moves/);
    expect(a).toMatch(
      /PERFORM public\.fn_ca_declare_ledger\('adjustment', 'bbj_pool', p_pool_id, NULL, NULL, NULL\);/
    );
    expect(a).toMatch(/'reason', 'source_bank_cannot_cover_it'/);
    expect(a).toMatch(
      /INSERT INTO public\.ca_bbj_bucket_moves \(pool_id, from_bank, to_bank, amount, reason, op_id, performed_by\)/
    );
  });
  it('the reseed is a recorded move and an empty reserve is an incident', () => {
    const reseed = a.slice(
      a.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_reseed_main_from_backup('),
      a.indexOf('-- ── 4.')
    );
    expect(reseed).toMatch(/'bbj-reserve-empty:' \|\| p_pool_id::text/);
    expect(reseed).toMatch(/fn_bbj_move_between_banks\(p_pool_id, 'backup', 'main', v_backup,/);
    expect(reseed).not.toMatch(/SET main_balance\s+= COALESCE\(backup_balance, 0\)/);
  });
});

describe('LAW 3: every jackpot door declares itself', () => {
  it('the payout is declared bbj_pool -> table_stack and keyed', () => {
    expect(a).toMatch(
      /fn_ca_declare_ledger\('bbj_payout', 'table_stack', p_table_id, NULL,\s+'bbj_payout:' \|\| v_payout_id::text, NULL\)/
    );
  });
  it('a departed recipient is paid to the table club wallet, keyed, declared from the felt', () => {
    const cr = a.slice(
      a.indexOf('CREATE OR REPLACE FUNCTION public.bbj_credit_one_recipient('),
      a.indexOf('CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(')
    );
    expect(cr).toMatch(/v_key := 'bbj:' \|\| p_payout_id::text \|\| ':' \|\| p_user_id::text;/);
    expect(cr).toMatch(
      /SELECT t\.club_id INTO v_club FROM public\.tables t WHERE t\.id = p_table_id;/
    );
    expect(cr).toMatch(
      /fn_ca_declare_ledger\('bbj_payout', 'table_stack', p_table_id, NULL, v_key, NULL\)/
    );
    expect(cr).not.toMatch(/credit_player_wallet\(/);
    expect(cr).toMatch(
      /REVOKE ALL ON FUNCTION public\.bbj_credit_one_recipient\(uuid, uuid, uuid, numeric, boolean\) FROM PUBLIC, anon, authenticated;/
    );
  });
  it('funding and the backup transfer declare, pool_amount is no longer journalled, the stubs are closed', () => {
    expect(a).toMatch(/fn_ca_declare_ledger\('transfer', 'union_wallet', p_union_id, NULL,/);
    expect(a).toMatch(
      /fn_ca_declare_ledger\('promo', 'union_wallet', p_union_id, NULL,\s+'bbj_backup_to_promo:' \|\| p_op_id::text, ARRAY\['union_wallets'\]\)/
    );
    expect(a).toMatch(
      /fn_ca_autoledger\('main_balance=bbj_pool', 'backup_balance=bbj_pool', 'promo_balance=bbj_pool'\)/
    );
    expect(a).not.toMatch(/pool_amount\s+= COALESCE\(pool_amount, 0\) \+ p_amount/);
    for (const n of [
      'add_bbj_contribution',
      'award_bbj',
      'bbj_atomic_payout',
      'bbj_promo_payout',
      'fn_bbj_payout',
      'fn_union_bbj_pool_payout',
    ]) {
      expect(a).toContain(`'${n}'`);
    }
    expect(a).toMatch(
      /RAISE EXCEPTION '% BBJ money door\(s\) still reachable from a browser', v_n;/
    );
  });
});

describe('LAW 4: the jackpot has an opening balance', () => {
  it('a labelled baseline per pool, with the lifetime gap written in and not erased', () => {
    expect(b).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_bbj_pool_snapshots/);
    expect(b).toMatch(/OPENING BALANCE, not a movement/);
    expect(b).toMatch(/IF abs\(v_gap - 73367\.70\) > 100 THEN/);
    expect(b).toMatch(
      /the lifetime figure should still read unhealthy \(it is history, not erased\)/
    );
  });
  it('the meter reads the banks and the legs in one statement, per bank, since the previous snapshot', () => {
    expect(b).toMatch(/FROM banks LEFT JOIN legs ON true/);
    expect(b).toMatch(/l\.created_at > v_prev\.taken_at AND l\.created_at <= v_now/);
    expect(b).toMatch(/round\(\(v_main - v_prev\.main\) - jm, 2\)/);
  });
  it('the hourly audit carries the meter, and a two-snapshot disagreement is an incident', () => {
    expect(b).toMatch(/v_meter := public\.fn_bbj_reconcile_all\(\);/);
    expect(b).toMatch(/IF abs\(v_two\) > 0\.01 OR s\.write_failures > 0 THEN/);
    expect(b).toMatch(/'bbj-meter:' \|\| p\.id::text/);
    expect(b).toMatch(
      /'healthy', v_epoch_at IS NOT NULL AND abs\(v_epoch_unexp\) <= COALESCE\(v_base\.tolerance, 1\.00\)\);/
    );
  });
});

describe('LAW 4b: a pool the meter has never seen opens its own balance', () => {
  const d = find(/^\d{14}_phase_4_2_a_pool_the_meter_has_never_seen_opens_its_own_balance\.sql$/);
  it('the opening balance is reconstructed from the banks and the journal, and every active pool is metered', () => {
    expect(d).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_bbj_open_pool_baseline\(p_pool_id uuid\)/
    );
    expect(d).toMatch(/v_at := GREATEST\(v_created, COALESCE\(v_epoch, v_created\)\);/);
    expect(d).toMatch(/round\(v_m - jm, 2\), round\(v_b - jb, 2\), round\(v_p - jp, 2\)/);
    expect(d).toMatch(/PERFORM public\.fn_bbj_open_pool_baseline\(p\.id\);/);
    expect(d).not.toMatch(
      /AND EXISTS \(SELECT 1 FROM public\.ca_bbj_pool_snapshots x WHERE x\.pool_id = b\.id\)/
    );
  });
});

describe('LAW 5: Deep Stack Society is an estate', () => {
  it('the incident scope admits Deep Stack', () => {
    expect(a).toMatch(
      /OR p_club_id IN \('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid\)/
    );
  });
});
