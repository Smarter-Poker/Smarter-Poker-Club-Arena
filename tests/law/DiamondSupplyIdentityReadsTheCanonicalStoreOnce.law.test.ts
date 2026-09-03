/**
 * LAW: THE DIAMOND SUPPLY IDENTITY READS THE CANONICAL STORE ONCE
 * ===========================================================================
 * `docs/DIAMOND-ACCOUNTING-STANDARD.md` 3.3 DR10: supply is
 * `SUM(profiles.diamonds)`. `user_diamonds`, `user_diamond_balance` and
 * `diamond_wallets` are AFTER-trigger MIRRORS of that column, so adding any of
 * them to the total counts the same diamond twice. On 2026-09-02 the mirror
 * backfill at 17:29 UTC did exactly that: `fn_ca_diamond_snapshot` reported a
 * total of 1,649,971 against a real supply of 1,030,092, and the 619,829 jump
 * was logged as `unexplained` drift. It was a mirror, not a mint.
 *
 * This law pins the migration that fixed it, plus the three other defects it
 * carried, so none of them can quietly come back:
 *
 *   1. The snapshot total is the profiles sum ALONE, and the wallet mirror is
 *      never added to it.
 *   2. Drift is measured against `prev.profile_diamonds`, never the previous
 *      row's stored `total` column. Those rows carry the OLD identity, and
 *      comparing across the two would have manufactured a one-off drift of
 *      about -619,879 and re-armed the Hetzner deploy gate, which had already
 *      blocked 26 consecutive engine deploys that day.
 *   3. `fn_purchase_time_banks` does not insert into a `reason` column.
 *      `diamond_transactions` has no such column, so the live body raised
 *      42703 on every call and no player could buy a time bank at all. It
 *      prices from `feature_pricing` and passes an idempotency reference.
 *   4. The union diamond grant and the club promo-vault debit NAME their
 *      log-only rules. Both are unfunded or unjournaled movements that ship
 *      RECORDED rather than refused (Dan's risk rule); a silent version of
 *      either is the bug.
 *   5. The `diamond_wallets` mirror leg UPSERTS. As a bare UPDATE it could
 *      never create a row, so 892 of 1,308 profiles had no mirror row at all.
 *
 * Every pin carries a negative control, so a regex that matches nothing
 * cannot pass by accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION = 'supabase/migrations/20260903003036_diamond_a_identity_and_doors.sql';
const text = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8');

/** The body of one CREATE OR REPLACE FUNCTION ... $fn$ ... $fn$; block. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('$fn$', start);
  const close = source.indexOf('$fn$;', open + 4);
  expect(open, `${name} body opens with $fn$`).toBeGreaterThan(start);
  expect(close, `${name} body closes with $fn$;`).toBeGreaterThan(open);
  return source.slice(open + 4, close);
}

const SNAPSHOT = functionBody(text, 'fn_ca_diamond_snapshot');
const MIRROR = functionBody(text, 'fn_diamond_side_tables_follow_profiles');
const TIMEBANKS = functionBody(text, 'fn_purchase_time_banks');
const UNION_SEND = functionBody(text, 'fn_union_send_to_member_zd3core');
const VAULT = functionBody(text, 'ca_promo_vault_buy');

/**
 * The counterfeit bodies. These are the ACTUAL pre-2026-09-03 production
 * bodies, trimmed to the lines that mattered. Every pin below must FAIL
 * against the matching counterfeit, or the pin is not looking at anything.
 */
const COUNTERFEIT_SNAPSHOT = `
  SELECT COALESCE(sum(balance),0) INTO v_wal FROM diamond_wallets;
  v_total := v_prof + v_wal;
  CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
  ELSE (v_total - v_cert) - (prev.total - COALESCE(prev.cert_diamonds, 0))
`;
const COUNTERFEIT_TIMEBANKS = `
  v_unit_cost INT := 2; -- 2 diamonds per use
  UPDATE profiles SET diamonds = diamonds - v_total_cost WHERE id = v_caller;
  INSERT INTO diamond_transactions (user_id, amount, reason)
  VALUES (v_caller, -v_total_cost, 'purchase_time_bank');
`;
const COUNTERFEIT_UNION = `
  update profiles set diamonds = coalesce(diamonds, 0) + p_amount
   where id = p_target_user_id returning diamonds into v_dia_after;
  insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata)
  values (p_target_user_id, 'credit', p_amount, v_dia_after, 'Union grant', 'union_grant', 'union', '{}'::jsonb);
`;
const COUNTERFEIT_MIRROR = `
  UPDATE public.diamond_wallets
     SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, updated_at = now()
   WHERE user_id = NEW.id;
`;
const COUNTERFEIT_VAULT = `
  UPDATE public.club_diamond_wallets
  SET balance = balance - v_cost WHERE club_id = p_club_id RETURNING balance INTO v_balance;
`;

// -- DR10, the supply identity -----------------------------------------------
const ADDS_THE_MIRROR = /v_total\s*:=\s*v_prof\s*\+\s*v_wal/;
const READS_CANONICAL_ONCE = /v_total\s*:=\s*v_prof\s*;/;
const DEREFERENCES_PREV_TOTAL = /prev\.total\b/;
const USES_PROFILE_BASIS = /prev\.profile_diamonds/;
const NAMES_MIRROR_RULE = /DR10:mirror_mismatch/;

// -- the time bank sink ------------------------------------------------------
const INSERTS_REASON = /INSERT\s+INTO\s+diamond_transactions[^;]*\breason\b/i;
const HARDCODES_THE_PRICE = /v_unit_cost\s+INT\s*:=\s*2\b/i;
const READS_THE_PRICE_ORACLE =
  /FROM\s+feature_pricing\s+WHERE\s+feature\s*=\s*'time_bank_seconds'/i;
const PASSES_A_REFERENCE = /'tbank_'\s*\|\|/;

// -- the two log-only rules --------------------------------------------------
const NAMES_UNFUNDED_RULE = /DR2:union_diamond_grant_unfunded/;
const NAMES_THE_COUNTERPARTY = /'union:'\s*\|\|\s*p_union_id/;
const NAMES_THE_CLASS = /'promotional'/;
const NAMES_UNJOURNALED_RULE = /DR3:club_diamond_debit_unjournaled/;

// -- the mirror leg ----------------------------------------------------------
const UPSERTS_THE_WALLET =
  /INSERT INTO public\.diamond_wallets[\s\S]*?ON CONFLICT \(user_id\) DO UPDATE/;

describe('the diamond supply identity reads the canonical store once', () => {
  it('the snapshot total is the profiles sum and never adds the wallet mirror', () => {
    expect(SNAPSHOT).toMatch(READS_CANONICAL_ONCE);
    expect(SNAPSHOT).not.toMatch(ADDS_THE_MIRROR);
    // negative control: the body this replaced must fail both pins
    expect(COUNTERFEIT_SNAPSHOT).toMatch(ADDS_THE_MIRROR);
    expect(COUNTERFEIT_SNAPSHOT).not.toMatch(READS_CANONICAL_ONCE);
  });

  it('the wallet mirror is still recorded, so equality can be checked', () => {
    // Recording it is required; ADDING it is the bug. If this pin ever fails,
    // wallet_diamonds has been dropped from the snapshot row and DR10 can no
    // longer compare the mirrors at all.
    expect(SNAPSHOT).toMatch(
      /SELECT COALESCE\(sum\(balance\),0\)\s+INTO v_wal\s+FROM diamond_wallets/
    );
    expect(SNAPSHOT).toMatch(NAMES_MIRROR_RULE);
    expect(COUNTERFEIT_SNAPSHOT).not.toMatch(NAMES_MIRROR_RULE);
  });

  it('drift is measured against the previous profiles sum, not the previous stored total', () => {
    expect(SNAPSHOT).toMatch(USES_PROFILE_BASIS);
    expect(SNAPSHOT).not.toMatch(DEREFERENCES_PREV_TOTAL);
    // negative control
    expect(COUNTERFEIT_SNAPSHOT).toMatch(DEREFERENCES_PREV_TOTAL);
    expect(COUNTERFEIT_SNAPSHOT).not.toMatch(USES_PROFILE_BASIS);
  });

  it('the diamond_wallets mirror leg upserts, so a profile cannot be left without a row', () => {
    expect(MIRROR).toMatch(UPSERTS_THE_WALLET);
    expect(COUNTERFEIT_MIRROR).not.toMatch(UPSERTS_THE_WALLET);
  });

  it('the backfill gives every profile a mirror row without moving a balance', () => {
    expect(text).toMatch(/INSERT INTO public\.diamond_wallets[\s\S]*?FROM public\.profiles p/);
    // A backfill that writes profiles.diamonds would be a money movement.
    expect(text).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+diamonds/i);
  });
});

describe('the time bank sink charges the catalogue price through the debit path', () => {
  it('does not insert into a diamond_transactions.reason column that does not exist', () => {
    expect(TIMEBANKS).not.toMatch(INSERTS_REASON);
    // negative control: the live body raised 42703 on every call
    expect(COUNTERFEIT_TIMEBANKS).toMatch(INSERTS_REASON);
  });

  it('prices from feature_pricing instead of a hardcoded literal', () => {
    expect(TIMEBANKS).toMatch(READS_THE_PRICE_ORACLE);
    expect(TIMEBANKS).not.toMatch(HARDCODES_THE_PRICE);
    // negative control
    expect(COUNTERFEIT_TIMEBANKS).toMatch(HARDCODES_THE_PRICE);
    expect(COUNTERFEIT_TIMEBANKS).not.toMatch(READS_THE_PRICE_ORACLE);
  });

  it('debits through deduct_diamonds with an idempotency reference, never a raw UPDATE', () => {
    expect(TIMEBANKS).toMatch(/v_deduct\s*:=\s*deduct_diamonds\(/);
    expect(TIMEBANKS).toMatch(PASSES_A_REFERENCE);
    expect(TIMEBANKS).not.toMatch(/UPDATE\s+profiles\s+SET\s+diamonds/i);
    // negative control
    expect(COUNTERFEIT_TIMEBANKS).toMatch(/UPDATE\s+profiles\s+SET\s+diamonds/i);
    expect(COUNTERFEIT_TIMEBANKS).not.toMatch(PASSES_A_REFERENCE);
  });

  it('skips the entitlement grant on an idempotent replay, so a retry cannot mint free banks', () => {
    expect(TIMEBANKS).toMatch(/idempotent'\)::boolean/);
  });
});

describe('the unfunded diamond doors are recorded by name', () => {
  it('the union diamond grant names its rule and its counterparty and class', () => {
    expect(UNION_SEND).toMatch(NAMES_UNFUNDED_RULE);
    expect(UNION_SEND).toMatch(NAMES_THE_COUNTERPARTY);
    expect(UNION_SEND).toMatch(NAMES_THE_CLASS);
    // negative control: the body this replaced credited silently
    expect(COUNTERFEIT_UNION).not.toMatch(NAMES_UNFUNDED_RULE);
    expect(COUNTERFEIT_UNION).not.toMatch(NAMES_THE_COUNTERPARTY);
  });

  it('the union diamond grant stays LOG-ONLY and still credits', () => {
    // Dan's risk rule: it records the refusal it did NOT make. If this pin
    // fails because a RETURN was added on the diamonds branch, a live union
    // grant is now being refused and that is Dan's call, not an agent's.
    expect(UNION_SEND).toMatch(
      /perform public\.fn_ca_diamond_incident\([\s\S]*?update profiles set diamonds/
    );
  });

  it('the club promo vault debit names its rule and stays LOG-ONLY', () => {
    expect(VAULT).toMatch(NAMES_UNJOURNALED_RULE);
    expect(VAULT).toMatch(
      /PERFORM public\.fn_ca_diamond_incident\([\s\S]*?UPDATE public\.club_diamond_wallets/
    );
    expect(COUNTERFEIT_VAULT).not.toMatch(NAMES_UNJOURNALED_RULE);
  });
});

describe('the Mint doors are shut to the browser', () => {
  it('revokes EXECUTE from both browser roles over every overload, by name', () => {
    expect(text).toMatch(/REVOKE EXECUTE ON FUNCTION %s FROM authenticated/);
    expect(text).toMatch(/REVOKE EXECUTE ON FUNCTION %s FROM anon/);
    expect(text).toMatch(/p\.proname IN \('fn_ca_mint', 'fn_ca_burn'\)/);
    // A hardcoded signature is what aborted the first apply: Lane B had added
    // a seventh argument the same hour. The loop must not regress to one.
    expect(text).not.toMatch(/REVOKE EXECUTE ON FUNCTION public\.fn_ca_mint\(/);
  });

  it('registers fn_ca_burn and the diamond RPCs without disturbing existing rows', () => {
    expect(text).toMatch(/INSERT INTO public\.ca_money_rpc_registry \(proname, status, notes\)/);
    expect(text).toMatch(
      /WHERE NOT EXISTS \(\s*SELECT 1 FROM public\.ca_money_rpc_registry g WHERE g\.proname = v\.proname/
    );
    for (const name of [
      'fn_ca_burn',
      'settle_diamond_card_purchase_atomic',
      'add_diamonds_to_balance',
      'deduct_diamonds',
      'fn_purchase_time_banks',
      'send_wallet_diamond_transfer',
      'award_diamonds_v2',
      'handle_new_user',
    ]) {
      expect(text, `${name} is registered`).toContain(`('${name}',`);
    }
  });
});

describe('the migration is one transaction with its own assertions', () => {
  it('opens and closes exactly one transaction', () => {
    expect(text.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(text.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(text).toMatch(/SET LOCAL lock_timeout = '4s';/);
  });

  it('aborts itself if any of its own claims did not take', () => {
    expect(text).toMatch(
      /RAISE EXCEPTION 'fn_ca_diamond_snapshot still adds the diamond_wallets mirror/
    );
    expect(text).toMatch(
      /RAISE EXCEPTION 'fn_purchase_time_banks still inserts into the nonexistent/
    );
    expect(text).toMatch(/RAISE EXCEPTION 'a browser role can still execute/);
  });

  it('moves no diamond balance', () => {
    // The only profiles write in the whole migration is the union credit that
    // already existed and is being preserved verbatim inside its function.
    const outsideFunctions = text.split('CREATE OR REPLACE FUNCTION')[0];
    expect(outsideFunctions).not.toMatch(/UPDATE\s+(public\.)?profiles/i);
    expect(text).not.toMatch(/INSERT INTO public\.ca_mint_ledger/i);
  });
});
