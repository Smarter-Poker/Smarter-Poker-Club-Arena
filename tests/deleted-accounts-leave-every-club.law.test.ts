import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan, 2026-10-16: "remove any and all deleted player from appearing inside of
// any searches or cashier pages or anywhere for that matter. for all clubs and
// unions. once they are deleted, they should be removed for good, not linger
// as a deleted stat. if they still have chips, those chips get recorded in the
// ledger and sent back to the main bank."
//
// The 2026-10-06 retirement set profiles.status = 'deleted' on 62 accounts and
// never ended a membership, so they stayed members (and agents) of three clubs
// and showed up as "Deleted-xxxx" in the union directory, rosters and
// leaderboards for ten days. The fix lives at the deletion itself.

const dir = 'supabase/migrations';
const found = readdirSync(dir).filter((name) =>
  name.endsWith('_a_deleted_account_leaves_every_club_and_every_list.sql')
);
if (found.length !== 1) throw new Error('Expected One Deleted-Account Lifecycle Migration');
const sql = readFileSync(`${dir}/${found[0]}`, 'utf8');

const fnBody = (() => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_deleted_account_leaves_every_club');
  const end = sql.indexOf('$function$;', start);
  if (start < 0 || end < 0) throw new Error('Lifecycle function not found');
  return sql.slice(start, end);
})();

describe('a deleted account leaves every club and every list', () => {
  it('ends every membership in the transaction that deletes the account', () => {
    expect(sql).toContain('CREATE TRIGGER zzzzz_deleted_profile_leaves_every_club');
    expect(sql).toContain('AFTER UPDATE OF status ON public.profiles');
    expect(sql).toContain("WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')");
    // Fires after the October 10 bank return (same timing, name order).
    expect('zzzz_deleted_profile_bank_return' < 'zzzzz_deleted_profile_leaves_every_club').toBe(true);
    expect(fnBody).toContain("membership_lifecycle_status = 'departed'");
    expect(fnBody).toContain("set_config('app.club_membership_lifecycle_write', 'depart', true)");
    expect(fnBody).toContain("'Account Deleted'");
    expect(fnBody).toContain('INSERT INTO public.audit_trail');
  });

  it('suspends agent authority and moves the downline to the nearest live upline', () => {
    expect(fnBody).toContain("SET status = 'suspended'");
    expect(fnBody).toContain('SET agent_id = CASE WHEN r.via_agent THEN v_target');
    expect(fnBody).toContain('SET parent_agent_id = v_target');
    // A deleted account is never chosen as anyone's new upline.
    expect(fnBody.match(/dp\.status = 'deleted'/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('returns chips only through the ledgered main-bank return and strands nothing', () => {
    expect(fnBody).toContain("public.fn_ca_deleted_wallet_bank_return(v_club, p_user, 'wallets')");
    expect(fnBody).toContain("ACCOUNT_CUSTODY_UNSETTLED: club_balance");
    expect(fnBody).toContain("ACCOUNT_CUSTODY_UNSETTLED: agent_wallet");
    // No hand-written balance, no deletion of records, no sweep.
    expect(fnBody).not.toMatch(/SET\s+(chip_balance|agent_wallet_balance|promo_balance|chip_treasury)\s*=/i);
    expect(sql).not.toMatch(/DELETE FROM|cron\.schedule|UPDATE public\.table_seats/i);
  });

  it('decides deletion by authoritative profile status, never player type or name', () => {
    expect(sql).not.toMatch(/is_horse|is_bot|ILIKE\s+'deleted|LIKE\s+'deleted/i);
  });

  it('keeps deleted accounts out of the directory, roster and every leaderboard ranking', () => {
    expect(sql).toContain("public.fn_union_player_directory(uuid)");
    expect(sql).toContain("WHERE pr.status IS DISTINCT FROM ''deleted''");
    expect(sql).toContain("AND pr.status IS DISTINCT FROM ''deleted''");
    for (const ranking of [
      'fn_club_leaderboard_by_dates',
      'fn_club_leaderboard_period_v2',
      'fn_diamond_arena_leaderboard_period',
      'fn_global_leaderboard_by_dates',
      'fn_global_leaderboard_period',
      'fn_union_leaderboard_period_v2',
    ]) {
      expect(sql).toContain(`'public.${ranking}(`);
    }
    // The filter precedes the rank, so ranks are computed over live accounts.
    expect(sql).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM public.profiles dp WHERE dp.id = s.uid AND dp.status = ''deleted'')"
    );
    expect(sql).toContain('DELETED_LISTS_PREIMAGE_CHANGED');
    expect(sql).toContain('DELETED_LISTS_ANCHOR_MISSING');
  });

  it('settles the existing accounts against the measured board and records it', () => {
    expect(sql).toContain('DELETED_ACCOUNT_BOARD_CHANGED');
    expect(sql).toContain('DELETED_ACCOUNT_CONSERVATION_FAILED');
    expect(sql).toContain('DELETED_ACCOUNT_END_STATE_FAILED');
    expect(sql).toContain("'deleted_accounts_leave_every_club_20261016'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fn_ca_deleted_account_leaves_every_club\(uuid\) FROM PUBLIC, anon, authenticated/);
  });

  it('a deletion locks only the banks that receive chips, and never queues behind one', () => {
    const lock = readdirSync(dir).filter((name) =>
      name.endsWith('_a_deletion_locks_only_the_banks_it_pays.sql')
    );
    expect(lock).toHaveLength(1);
    const fix = readFileSync(`${dir}/${lock[0]}`, 'utf8');
    // Measured 2026-10-17: a zero-chip deletion was refused because every
    // house bank was locked up front. Only banks receiving chips are locked.
    expect(fix).toContain('PERFORM public.fn_ca_try_lock_bank(v_bank);');
    expect(fix).toMatch(/coalesce\(m\.chip_balance,0\) - coalesce\(m\.held_chips,0\) - coalesce\(m\.locked_chips,0\) > 0/);
    expect(fix).toMatch(/coalesce\(a\.agent_wallet_balance,0\) > 0/);
    // Wallets are owned before banks, and every lock stays NOWAIT (polled,
    // never queued), so the October 11 no-deadlock property holds.
    expect(fix.indexOf('FROM public.club_members m WHERE m.user_id = OLD.id')).toBeLessThan(
      fix.indexOf('PERFORM public.fn_ca_try_lock_bank(v_bank);')
    );
    expect(fix).toContain('FOR UPDATE NOWAIT');
    expect(fix).toContain('EXCEPTION WHEN lock_not_available');
    expect(fix).not.toMatch(/ORDER BY c\.id FOR UPDATE NOWAIT/);
    // Every custody refusal is kept.
    for (const reason of ['seated', 'tournament_entry', 'pending_cashout', 'escrow', 'held_chips']) {
      expect(fix).toContain(`ACCOUNT_CUSTODY_UNSETTLED: ${reason}`);
    }
    expect(fix).toContain('DELETION_BANK_LOCK_PREIMAGE_CHANGED');
    expect(fix).not.toMatch(/DELETE FROM|cron\.schedule|is_horse/i);
  });
  it('keeps deleted accounts out of the Club Data player rankings (2026-10-17)', () => {
    const files = readdirSync(dir).filter((name) =>
      name.endsWith('_a_deleted_account_leaves_the_club_data_player_rankings.sql')
    );
    expect(files).toHaveLength(1);
    const clubData = readFileSync(`${dir}/${files[0]}`, 'utf8');
    for (const fn of [
      'public.ca_club_player_breakdown(uuid,date,date,integer)',
      'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
      // The Players CSV export builds the same list.
      'public.ca_club_player_export_start(uuid,date,date,text,uuid)',
    ]) {
      expect(clubData).toContain(`'fn', '${fn}'`);
      expect(clubData).toContain(`pg_get_functiondef('${fn}'::regprocedure)) > 0`);
    }
    // One predicate shared by the rows, the totals and both counts.
    expect(clubData).toContain("WHERE dp.id = a.user_id AND dp.status = 'deleted'");
    // The replacement may change the body and nothing else.
    expect(clubData).toContain('attributes changed');
    expect(clubData).not.toMatch(/is_horse|DELETE FROM|cron\.schedule/i);
  });
});
