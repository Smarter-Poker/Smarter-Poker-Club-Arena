-- 20261016122922_the_weekly_close_proofs_outlive_the_close.sql
--
-- Reserved as 20261016122922 by scripts/new-migration.mjs; renamed to the
-- version the Supabase MCP recorded when it was applied (20261016123337).
--
-- THE WEEKLY CLOSE'S PROOFS OUTLIVE THE CLOSE (2026-10-16)
--
-- Dan, 2026-10-16: "GIVE THE RAKE BACK MORE TIME (UNLIMITED IF POSSIBLE)".
--
-- What happened. The union close for fade0000, week 2026-10-05..2026-10-12,
-- was still status 'running' on 2026-10-16 after 154 attempts. Job 272 proves
-- the close in pieces (earned-plan, flow and settlement windows, P&L
-- certificates), each kept in accounting_close_partials or
-- accounting_close_certificates and trusted for 12 hours. Proving the whole
-- union week takes longer than that inside job 272's 240 s ticks, so the first
-- pieces expired before the last were proved and the close started over:
--   * 2026-10-15 15:23 earned_plan certified, 15:26 pnl_clubs certified;
--   * 17:33..23:12 round 2 windows, 23:25..23:28 round 3 windows and plan;
--   * 2026-10-16 03:23 the earned plan was 12 hours old, every window was
--     re-proved (03:23..07:37) and flows (02:43..09:12), the certificates again
--     (09:22..12:22), and pnl_clubs (2026-10-15 15:26) had expired by then.
-- A week whose proof outlasts its own proofs never closes. Read from
-- production 2026-10-16 12:20 UTC.
--
-- Why not a larger tick. The 240 s statement budget is the replication bound
-- (20261012134146_the_weekly_close_never_holds_replication): one writing
-- transaction open for ~5.3 minutes takes Supabase Realtime down for every
-- player. That bound stays exactly as it is. What changes is how long a proved
-- piece is trusted, which costs no tick time at all.
--
-- What changes. One helper, public.fn_accounting_close_proof_lifetime(),
-- returns 72 hours, and the 14 freshness tests in the 10 close functions that
-- read a proved piece ("computed_at / certified_at > clock_timestamp() -
-- interval '12 hours'") read it instead. 72 hours is several times the longest
-- observed union close (about 12 hours end to end) and still bounded: a close
-- that sits for days re-proves its pieces before it pays.
--
-- What does not change.
--   * job 272's 240 s statement and 3 minute scope budget;
--   * a piece that found a problem is still kept for one hour only;
--   * the inventory generation key on every P&L certificate (a change to the
--     original inventory still invalidates them at once);
--   * fn_rakeback_recompute_split's own 12 hour rule, which decides when a
--     club week is recomputed rather than how long a proof is trusted;
--   * the 8 day cleanup of accounting_close_partials.
--
-- Each function is rewritten only from its pinned live preimage, with the
-- exact number of occurrences checked, inside one transaction.
--
-- @live-proof: (SELECT public.fn_accounting_close_proof_lifetime() = interval '72 hours')
-- @live-proof: (SELECT count(*) = 10 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f' AND proname IN ('fn_accounting_close_certificate','fn_accounting_close_windows_advance_due','fn_accounting_close_windows_pending','fn_accounting_union_earned_plan_advance','fn_accounting_union_earned_plan_combine','fn_settle_accounting_commission_advance','fn_settle_accounting_commission_combine','fn_settle_accounting_rakeback_advance','fn_settle_accounting_rakeback_pairs','fn_settle_accounting_rakeback_plan_get') AND strpos(pg_get_functiondef(oid), 'clock_timestamp()-public.fn_accounting_close_proof_lifetime()') > 0 AND strpos(pg_get_functiondef(oid), 'clock_timestamp()-interval ''12 hours''') = 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_accounting_close_proof_lifetime()
RETURNS interval
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $function$ SELECT interval '72 hours' $function$;

COMMENT ON FUNCTION public.fn_accounting_close_proof_lifetime() IS
  'How long a proved weekly-close piece (plan, flow or settlement window, P&L certificate) is trusted. 72 hours since 20261016122922; it was 12 hours, shorter than a union close takes inside job 272''s 240 s ticks.';

DO $patch$
DECLARE
  r record;
  d text;
  n integer;
  old_text constant text := 'clock_timestamp()-interval ''12 hours''';
  new_text constant text := 'clock_timestamp()-public.fn_accounting_close_proof_lifetime()';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_accounting_close_certificate(text,uuid,timestamp with time zone,timestamp with time zone)', '7b4a5f4572a45db069b6058899614021', 1),
    ('public.fn_accounting_close_windows_advance_due()', 'd28702021ebeed163cd8f6a722c5262d', 2),
    ('public.fn_accounting_close_windows_pending(uuid,uuid,timestamp with time zone,timestamp with time zone)', '536acae0c83352aa3cecf4bd95082f6d', 1),
    ('public.fn_accounting_union_earned_plan_advance(uuid,timestamp with time zone,timestamp with time zone)', 'f24bac9808f16258b30ee227427dabcc', 3),
    ('public.fn_accounting_union_earned_plan_combine(uuid,timestamp with time zone,timestamp with time zone)', '74599a61537c0143a193718ec58e19d9', 1),
    ('public.fn_settle_accounting_commission_advance(text,uuid,timestamp with time zone,timestamp with time zone)', 'e91c40770c8de772df2a25bbce016ef5', 1),
    ('public.fn_settle_accounting_commission_combine(text,uuid,timestamp with time zone,timestamp with time zone)', '94b8bef20ea6dca66b99b733dfaa4c2b', 1),
    ('public.fn_settle_accounting_rakeback_advance(text,uuid,timestamp with time zone,timestamp with time zone)', '2c3f36a8920d70b225c887c1287a567b', 2),
    ('public.fn_settle_accounting_rakeback_pairs(text,uuid,timestamp with time zone,timestamp with time zone)', '1cbdd833c1a14222ab741f17ef0b13bd', 1),
    ('public.fn_settle_accounting_rakeback_plan_get(text,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,boolean)', '3a01375afd32f1adea8821d81b925f96', 1)
  ) v(sig, preimage, occurrences) LOOP
    d := pg_get_functiondef(r.sig::regprocedure);
    IF md5(d) <> r.preimage THEN
      RAISE EXCEPTION 'Unexpected preimage: % is %, expected %', r.sig, md5(d), r.preimage;
    END IF;
    n := (length(d) - length(replace(d, old_text, ''))) / length(old_text);
    IF n <> r.occurrences THEN
      RAISE EXCEPTION 'Unexpected proof-lifetime count in %: % (expected %)', r.sig, n, r.occurrences;
    END IF;
    EXECUTE replace(d, old_text, new_text);
    IF strpos(pg_get_functiondef(r.sig::regprocedure), old_text) > 0 THEN
      RAISE EXCEPTION 'The 12 hour proof lifetime survived in %', r.sig;
    END IF;
  END LOOP;

  IF strpos(pg_get_functiondef('public.fn_rakeback_recompute_split'::regproc), 'interval ''12 hours''') = 0 THEN
    RAISE EXCEPTION 'fn_rakeback_recompute_split was not meant to change';
  END IF;
END
$patch$;

COMMIT;
