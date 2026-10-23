/**
 * THE DAILY DIGEST COUNTS PHONE VERIFICATION HONESTLY (2026-10-23).
 *
 * LAW 1 - Codes sent are counted from the durable send log, never from
 *   sms_otp_codes: that table deletes a code on use and purges expired codes
 *   on every send, so it only ever held the codes nobody entered (Oct 22: the
 *   digest saw 1 while Twilio delivered 12).
 * LAW 2 - The phone_verification_low rate is measured against players who can
 *   still earn the welcome package by phone: US only (phone verification is
 *   US only) and not already paid by hand in the Mint register.
 * LAW 3 - A failed send is its own warning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_daily_digest_counts_phone_verification_honestly\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not in the tree');
const sql = readFileSync(resolve(MIG, file), 'utf8');

describe('the daily digest counts phone verification honestly', () => {
  it('LAW 1: codes sent come from the durable send log, which holds no phone and no code', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.sms_otp_send_log \(/);
    const table = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.sms_otp_send_log'),
      sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS public.sms_otp_send_log'))
    );
    expect(table).not.toMatch(/\bphone\b\s+text/);
    expect(table).not.toMatch(/\bcode\b\s+text/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /REVOKE ALL ON public\.sms_otp_send_log FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(
      /'otp_codes_sent', \(SELECT count\(\*\) FROM public\.sms_otp_send_log WHERE purpose = 'phone_verify' AND outcome = 'sent'/
    );
    const newExpr = sql.slice(sql.indexOf('v_new_m text'), sql.indexOf('v_old_decl text'));
    expect(newExpr).not.toMatch(/sms_otp_codes/);
  });

  it('LAW 2: the rate is verified over players who can still earn the package by phone', () => {
    expect(sql).toMatch(/'signups_phone_eligible'/);
    expect(sql).toMatch(/pp\.country IS NULL OR pp\.country IN \('United States', 'US'\)/);
    expect(sql).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.ca_mint_ledger ml WHERE ml\.op_id = 'signup:' \|\| hu\.id::text\)/
    );
    expect(sql).toMatch(
      /v_elig := COALESCE\(\(p_metrics#>>'\{growth,signups_phone_eligible\}'\)::numeric, v\);/
    );
    expect(sql).toMatch(
      /IF v_elig >= 2 AND v2 < v_elig \* public\.fn_sp_setting\('phone_verify_min_rate',0\.5\) THEN/
    );
    expect(sql).toMatch(/'signups_phone_skipped'/);
  });

  it('LAW 3: a failed send raises phone_otp_send_failed', () => {
    expect(sql).toMatch(/'otp_send_failures'/);
    expect(sql).toMatch(/'rule','phone_otp_send_failed','severity','warning'/);
  });

  it('is two guarded exact substitutions in one transaction', () => {
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
    expect(sql).toMatch(/RAISE EXCEPTION 'fn_sp_daily_metrics_compute no longer contains/);
    expect(sql).toMatch(/RAISE EXCEPTION 'fn_sp_digest_attention no longer contains/);
    expect(sql).toMatch(/@live-proof: /);
  });
});

describe('Club Arena re-offers the welcome package to an unverified player', () => {
  const menu = readFileSync(
    resolve(HERE, '../src/components/navigation/HamburgerMenu.tsx'),
    'utf8'
  );
  it('reads phone_verified with the profile and shows Verify Phone Number while unverified', () => {
    expect(menu).toMatch(/is_vip, tier, role, phone_verified`/);
    expect(menu).toMatch(/setPhoneUnverified\(data\.phone_verified === false && !data\.is_vip\);/);
    expect(menu).toMatch(/\{phoneUnverified && !IS_NATIVE_BUILD && \(/);
    expect(menu).toMatch(/tc\('Verify Phone Number'\)/);
    expect(menu).toMatch(/tc\('Claim 1 Month Free VIP And 500 Diamonds'\)/);
    expect(menu).toMatch(/window\.location\.assign\('\/hub\/verify-phone'\);/);
  });
});
