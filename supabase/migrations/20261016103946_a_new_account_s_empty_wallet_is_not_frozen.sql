-- 20261016103946_a_new_account_s_empty_wallet_is_not_frozen.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A NEW ACCOUNT'S EMPTY WALLET IS NOT FROZEN (2026-10-16)
--
-- DailyDigest.signup_errors (operational_alert_events 255128 and 255170:
-- "2 signup errors" on Oct 14, "8 signup errors" on Oct 15). Read from
-- public.signup_errors: all 10 rows since 2026-10-14 05:00 UTC are
-- trigger handle_new_user_v2_create_wallet, SQLSTATE 55006, "PLATFORM_FROZEN:
-- ... INSERT on wallets was refused; it will succeed when play resumes",
-- and every one was written between :55 and :00 (01:56, 02:59, 11:55, 14:58,
-- 15:55, 17:57 on the 15th; 01:57, 03:00, 03:56, 04:59 on the 16th). It does
-- not succeed when play resumes: nothing retries the insert, and all 10
-- accounts still have no row in public.wallets (60 days of signup_errors:
-- 79 such rows, none with a wallet today). These 10 were synthetic probe
-- accounts (crest_cert_* and PostDeploy*), but a real player who signs up in
-- the break takes the same path and is left without a PLAYER wallet, which
-- fn_player_spendable_balance, atomic_wallet_transfer and
-- audit_auth_integrity all read.
--
-- THE CAUSE. Signup inserts (user_id, 'PLAYER', balance 0, locked_balance 0)
-- into public.wallets. The zz_freeze_guard trigger on wallets
-- (fn_refuse_while_frozen('balance')) refuses every INSERT while
-- fn_platform_frozen() is true. Its own rule already says a row carrying no
-- chips is identity, not money ("ONBOARDING NEVER FREEZES", to-do #2563 item
-- 1), but it states that only for club_members.
--
-- THE FIX. The same exemption for a wallets INSERT whose balance and
-- locked_balance are both zero. Any nonzero amount, every UPDATE of balance
-- and every DELETE is refused exactly as before. Nothing else in the function
-- changes.
--
-- Pinned-preimage substitution: the live pg_get_functiondef md5 is pinned
-- (3a866372...), the one anchor occurs exactly once, the postimage md5 was
-- derived read-only on production with replace() (e7051615...), and owner,
-- SECURITY DEFINER, search_path and grants are proven unchanged after the
-- replace.
--
-- Regression: scripts/ci/test-digest-findings-at-the-root.py on native
-- PostgreSQL (the live definition captured 2026-10-16 in
-- scripts/ci/fixtures/digest-findings-at-the-root/), run by
-- .github/workflows/digest-findings-at-the-root.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.fn_refuse_while_frozen()'::regprocedure)) = 'e70516150fcc4edb9ad1033263b6df25'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_empty_wallet_subst(p_sig text, p_before text, p_after text,
                                              p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_empty_wallet_subst(
  'public.fn_refuse_while_frozen()',
  '3a866372172806a8a69cc3d37413f0cc', 'e70516150fcc4edb9ad1033263b6df25',
  ARRAY[$wo1$  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;
$wo1$],
  ARRAY[$wn1$  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- A NEW ACCOUNT'S EMPTY WALLET IS IDENTITY TOO (2026-10-16). Signup's
  -- handle_new_user_v2_create_wallet inserts a PLAYER wallet with balance 0
  -- and locked_balance 0. Refused inside the break, that trigger logged
  -- PLATFORM_FROZEN to signup_errors and the account was left with no
  -- wallet at all, because nothing retries it (10 accounts on 2026-10-15
  -- and 16, every one created between :55 and :00). No chips move, so the
  -- freeze has nothing to protect. Any nonzero amount is still refused.
  IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'balance')::numeric, 0) = 0
     AND COALESCE((to_jsonb(NEW) ->> 'locked_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;
$wn1$]
);

COMMIT;
