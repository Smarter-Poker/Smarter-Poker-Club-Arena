/**
 * LAW - the diamond alarms measure the register, players apart from the certification harness,
 * and the journal classifies every row it accepts (Diamond Accounting Standard DR3, DR6, DR11,
 * DR12; review of 2026-09-07, docs/audits/2026-09-02-diamond-economy/review1..3).
 *
 * Every pin here is a defect that actually shipped between 2026-09-03 and 2026-09-07:
 *  - a 10-minute balance window was measured against a 60-minute journal the certification
 *    cleanup deletes hourly, and filed 38 false trial-balance breaks;
 *  - award_diamonds_v2 was rebuilt from an older copy and wrote anonymous journal rows;
 *  - fixture churn filed 96 percent of 18,000 incidents at warning;
 *  - a player with a journal row could not delete their account (P0403 on the cascade);
 *  - the union diamond grant was a 100,000-per-call mint with no debit.
 * Negative controls mutate a copy of the source and expect the pin to fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(dir);
const pick = (suffix: string) => {
  const f = files.find((n) => n.endsWith(suffix));
  expect(f, `${suffix} exists`).toBeTruthy();
  return fs.readFileSync(path.join(dir, f as string), 'utf8');
};
const fix1 = pick('_diamond_review_the_alarms_measure_the_right_things.sql');
const fix2 = pick('_diamond_review_fixtures_are_measured_apart.sql');
const drop = pick('_diamond_review_the_refund_handler_has_one_name.sql');

function body(source: string, name: string): string {
  const start = source.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  // The dollar tag varies ($fn$ or $function$): read it off the AS clause.
  const tagMatch = /AS\s+(\$[A-Za-z_]*\$)/.exec(source.slice(start));
  expect(tagMatch, `${name} has a dollar-quoted body`).toBeTruthy();
  const tag = (tagMatch as RegExpExecArray)[1];
  const open = source.indexOf(tag, start + (tagMatch as RegExpExecArray).index);
  const close = source.indexOf(`${tag};`, open + tag.length);
  expect(close, `${name} body closes`).toBeGreaterThan(open);
  return source.slice(open + tag.length, close);
}

describe('fixture accounts are not players, and horses are players', () => {
  // The predicate was redefined on 2026-09-08 (20260908024742). Read the LATEST migration that
  // defines it, never the first: a pin that reads a superseded file stops guarding anything.
  const fixtureSource = files
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .filter((n) =>
      fs
        .readFileSync(path.join(dir, n), 'utf8')
        .includes('FUNCTION public.fn_ca_is_fixture_account(')
    )
    .pop() as string;
  const fixture = body(
    fs.readFileSync(path.join(dir, fixtureSource), 'utf8'),
    'fn_ca_is_fixture_account'
  );
  it('matches the sentinel uuid, the active cert register and .invalid emails', () => {
    expect(fixture).toContain(`LIKE '00000000-0000-0000-0000-%'`);
    expect(fixture).toContain('ca_cert_accounts');
    expect(fixture).toContain(`LIKE '%.invalid'`);
  });
  it('NEVER matches a horse (CLAUDE.md 10.5), and says so by asking the profile', () => {
    // This pin used to read `expect(fixture).not.toContain('is_horse')`, on the assumption that
    // any mention of the flag would be an exclusion. It was the wrong shape and it hid a live
    // defect for a day: an earlier sweep tagged 468 of the 1,000 horses into ca_cert_accounts,
    // so the predicate matched them, and the earn ledger, the budgets and incident severity
    // silently skipped nearly half the fleet. The predicate now EXCLUDES horses explicitly, and
    // the pin asserts the guarantee the ruling actually made.
    expect(fixture).not.toContain('horses.smarter.poker');
    expect(fixture.replace(/\s+/g, ' ')).toContain(
      'NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))'
    );
    // negative control: a body that only tags by the certification register matches horses again
    const bad = fixture.replace(
      /AND NOT EXISTS \(SELECT 1 FROM public\.profiles p WHERE p\.id = p_user_id AND COALESCE\(p\.is_horse, false\)\)/,
      ''
    );
    expect(bad.replace(/\s+/g, ' ')).not.toContain('COALESCE(p.is_horse, false))');
  });
});

describe('the snapshot and the trial balance measure the register on stored figures', () => {
  const snap = body(fix2, 'fn_ca_diamond_snapshot');
  const tb = body(fix2, 'fn_ca_diamond_trial_balance');
  it('the snapshot stores the register and the fixture split beside the meter', () => {
    expect(fix1).toContain('ADD COLUMN IF NOT EXISTS register_supply');
    expect(fix2).toContain('ADD COLUMN IF NOT EXISTS fixture_diamonds');
    expect(fix2).toContain('ADD COLUMN IF NOT EXISTS register_fixture');
    expect(snap).toContain('register_supply, house_balance, fixture_diamonds, register_fixture');
  });
  it('unexplained is players moved minus player register moved, fixtures apart', () => {
    expect(snap).toContain('((v_total - v_fix) - (v_prev_basis - prev.fixture_diamonds))');
    expect(snap).toContain(
      '((v_reg - v_reg_fix) - (prev.register_supply - COALESCE(prev.register_fixture, 0)))'
    );
    expect(snap).toContain(`holder_type = 'player'`);
    // negative control: the old identity added the diamond_wallets mirror
    expect(snap).not.toContain('v_total := v_prof + v_wal');
  });
  it('the harness moving fixture balances is its own info class, never the deploy gate', () => {
    expect(snap).toContain(`'DR6:fixture_harness_unregistered_movement', 'info'`);
    expect(snap).toContain(`'diamond-unexplained:'`);
  });
  it('the trial balance names register, fixture_accounts, suspense and total', () => {
    for (const row of [
      'player_diamonds',
      'fixture_accounts',
      'diamond_house',
      'register',
      'suspense',
      'total',
    ]) {
      expect(tb).toContain(`'${row}'::text`);
    }
    expect(tb).toContain(
      'v_mint  := (v_reg_players - v_reg_fix) - (s0.register_supply - COALESCE(s0.register_fixture, 0));'
    );
    // the journal is read over the SAME window as the balance, live plus archive
    expect(tb).toContain('FROM public.ca_diamond_journal_archive a WHERE a.created_at >= w0');
  });
  it('the watch breaks only on player_diamonds, diamond_house and register', () => {
    const watch = body(fix2, 'fn_ca_diamond_trial_balance_watch');
    expect(watch).toContain(`r.account IN ('player_diamonds', 'diamond_house', 'register')`);
    expect(watch).toContain(`'DR11:trial_balance_break'`);
    expect(watch).toContain(`interval '7 days'`);
  });
});

describe('DR6 and DR2 know who journals and who is a fixture', () => {
  const audit = body(fix1, 'fn_ca_audit_diamond_change');
  it('sanctions the writers that journal after the balance write', () => {
    for (const w of [
      'handle_new_user',
      'fn_ca_diamond_born_with_balance',
      'award_diamonds_v2',
      'fn_purchase_time_banks_v2',
    ]) {
      expect(audit).toContain(`'${w}'`);
    }
    expect(audit).toContain(`LIKE 'claim_daily_challenge%'`);
  });
  it('files fixture churn at info and players at warning', () => {
    expect(audit).toContain(
      `CASE WHEN v_fixture THEN 'DR6:fixture_harness_unjournaled' ELSE 'DR6:balance_changed_without_journal' END`
    );
    expect(audit).toContain(`CASE WHEN v_fixture THEN 'info' ELSE 'warning' END`);
    const born = body(fix1, 'fn_ca_diamond_born_with_balance');
    expect(born).toContain(`CASE WHEN v_fixture THEN 'info' ELSE 'warning' END`);
    expect(born).not.toContain('RAISE EXCEPTION');
  });
});

describe('the journal classifies every row and survives an account leaving', () => {
  const classifier = body(fix1, 'fn_ca_diamond_journal_classifier');
  const guard = body(fix1, 'fn_ca_journal_append_only');
  it('fills class and counterparty when a writer leaves them NULL and names the writer', () => {
    expect(classifier).toContain('IF NEW.issuance_class IS NULL THEN');
    expect(classifier).toContain('IF NEW.counterparty IS NULL THEN');
    expect(classifier).toContain(`'DR12:journal_row_unclassified_by_writer'`);
    expect(fix1).toContain('CREATE TRIGGER aa_ca_diamond_journal_classifier');
    expect(fix1).toContain('BEFORE INSERT ON public.diamond_transactions');
  });
  it('lets the cascade of a deleted profile through, archived, and refuses a direct delete', () => {
    expect(guard).toContain('pg_trigger_depth() > 1');
    expect(guard).toContain(`'profile-deletion-cascade'`);
    expect(guard).toContain(`USING ERRCODE = 'P0403'`);
  });
  it('files one DR5 incident per maintenance batch, with deleted_profile_id NULL', () => {
    expect(guard).toContain(`detail->>'reason' = v_reason`);
    expect(guard).toContain(`'rows', COALESCE((detail->>'rows')::int, 1) + 1`);
    expect(guard).toContain(`           NULL, v_reason)`);
  });
});

describe('award_diamonds_v2 stamps its rows and the kill switch is wired', () => {
  it('the apply-time patch asserts exact-once markers and adds both columns', () => {
    expect(fix1).toContain(
      `RAISE EXCEPTION 'award_diamonds_v2: INSERT column marker not found exactly once'`
    );
    expect(fix1).toContain(`''promo_budget:catalog_v2'',\\n        ''promotional''`);
    expect(fix1).toContain(`''reason'', ''diamond_issuance_frozen''`);
  });
  it('the kill switch reads scope diamond_issuance in fn_ca_mint and add_diamonds_to_balance', () => {
    expect(fix1).toContain(`f.scope = ''diamond_issuance'' AND f.cleared_at IS NULL`);
    const add = body(fix1, 'add_diamonds_to_balance');
    expect(add).toContain(`f.scope = 'diamond_issuance' AND f.cleared_at IS NULL`);
    expect(add).toContain(`'diamond_issuance_frozen'`);
  });
  it('the assertions refuse to commit without the stamp', () => {
    expect(fix1).toContain(
      `IF v NOT LIKE '%promo_budget:catalog_v2%' OR v NOT LIKE '%diamond_issuance_frozen%' THEN`
    );
  });
});

describe('rulings: the union diamond grant is closed, the promo vault refuses, the refund path has one name', () => {
  it('the union kind list is chips or promo', () => {
    expect(fix1).toContain(`if p_kind not in (''chips'',''promo'') then`);
    expect(fix1).toContain('Diamonds are issued only by the Mint');
  });
  it('the promo vault refuses in Title Case and debits nothing', () => {
    const vault = body(fix1, 'ca_promo_vault_buy');
    expect(vault).toContain('Promo Vault Purchases In Diamonds Are Not Available Yet.');
    expect(vault).not.toContain('UPDATE public.club_diamond_wallets');
  });
  it('fn_diamond_purchase_refund is the handler and the old name is dropped in the branch', () => {
    expect(fix1).toContain('FUNCTION public.fn_diamond_purchase_refund(');
    expect(fix1).not.toContain(
      'CREATE OR REPLACE FUNCTION public.reconcile_diamond_purchase_refund'
    );
    expect(drop).toContain(
      'DROP FUNCTION IF EXISTS public.reconcile_diamond_purchase_refund(uuid, integer, integer);'
    );
    const dispute = body(fix1, 'fn_diamond_purchase_dispute');
    expect(dispute).toContain('public.fn_diamond_purchase_refund(');
    expect(dispute).toContain('p_evidence_due_by');
    expect(dispute).toContain(`CASE WHEN v_withdrawn IS NULL THEN 'info' ELSE 'critical' END`);
  });
  it('the earn ledger skips fixtures and knows the VIP cap', () => {
    const ledger = body(fix1, 'fn_ca_diamond_earn_ledger');
    expect(ledger).toContain('IF public.fn_ca_is_fixture_account(NEW.user_id) THEN');
    expect(ledger).toContain('max_per_user_per_day_vip');
    expect(ledger).toContain(`THEN 'unclassified'`);
    expect(ledger).not.toContain('RAISE EXCEPTION');
  });
});
