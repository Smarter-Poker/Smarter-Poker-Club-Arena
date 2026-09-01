-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827152935; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- TWO FLAGS FOR ONE FACT, AND THEY DISAGREE
-- ═══════════════════════════════════════════════════════════════════════════
-- "Is this account a horse" is stored twice:
--     profiles.is_horse         (authoritative -- the horse fleet sets it)
--     club_members.is_bot       (per-membership copy)
--
-- Measured 2026-08-27:
--     is_horse=false, is_bot=false     15 members       900,127.21 chips  <- real people
--     is_horse=TRUE,  is_bot=FALSE    985 members    74,565,324.43 chips  <- DISAGREE
--     is_horse=true,  is_bot=true     502 members    45,553,471.79 chips
--
-- 985 of 1,487 horses -- 66% of the fleet, holding 74.5 MILLION chips -- are
-- flagged is_bot = false. Anything that segments by club_members.is_bot counts
-- them as human beings.
--
-- This is not theoretical. It produced a wrong answer during the audit that
-- found it: a seated-player count keyed on is_bot reported "346 horses, 733
-- humans" when in truth only 15 human MEMBERSHIPS exist on the whole platform.
-- Any club stat, leaderboard, liquidity view or revenue report using this flag
-- carries the same error.
--
-- WHY THE FLAG IS NOT BEING CORRECTED HERE, deliberately. Three functions read
-- it, and one is `mass_fund_horses`. Flipping 985 rows to is_bot = true could
-- pull those accounts into a funding run and move a great deal of money as a
-- side effect of a data-quality fix. `fn_membership_starts_with_zero_chips`
-- also branches on it. Correcting the flag is the right end state and it needs
-- to be done deliberately, with mass_fund_horses read first -- not as a 3am
-- side effect of noticing.
--
-- So: make it VISIBLE and let the next person fix it on purpose.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_bot_flag_disagreement()
RETURNS TABLE (
  memberships     bigint,
  chips_held      numeric,
  horses_mislabelled_human bigint,
  humans_mislabelled_bot   bigint,
  note            text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FILTER (WHERE coalesce(p.is_horse,false) <> coalesce(cm.is_bot,false)),
         round(coalesce(sum(cm.chip_balance) FILTER (
           WHERE coalesce(p.is_horse,false) <> coalesce(cm.is_bot,false)), 0)::numeric, 2),
         count(*) FILTER (WHERE coalesce(p.is_horse,false) AND NOT coalesce(cm.is_bot,false)),
         count(*) FILTER (WHERE NOT coalesce(p.is_horse,false) AND coalesce(cm.is_bot,false)),
         'profiles.is_horse is authoritative. Any segmentation using club_members.is_bot '
         || 'miscounts by this many memberships.'
  FROM public.club_members cm
  JOIN public.profiles p ON p.id = cm.user_id;
$$;

COMMENT ON FUNCTION public.fn_bot_flag_disagreement() IS
  'How far club_members.is_bot has drifted from profiles.is_horse. Added 2026-08-27 after finding 985 horses (74.5M chips) flagged as human, which makes every is_bot-keyed report wrong. The flag is NOT auto-corrected: mass_fund_horses reads it and flipping rows could trigger a funding run.';

REVOKE ALL ON FUNCTION public.fn_bot_flag_disagreement() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_bot_flag_disagreement() TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.fn_chip_integrity_report()
RETURNS TABLE (check_name text, severity text, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sev text; v_finding text; v_days integer;
  v_drift_rows bigint; v_worst numeric;
  v_fail bigint; v_exits bigint;
  v_frozen numeric; v_last_write timestamptz;
  v_free bigint; v_lost numeric;
  v_flag bigint; v_flag_chips numeric;
BEGIN
  SELECT l.severity, l.finding, l.silent_for_days INTO v_sev, v_finding, v_days
    FROM public.fn_ledger_liveness() l;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok' WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26.', v_drift_rows, round(v_worst,2));
  RETURN NEXT;

  SELECT count(*) INTO v_fail FROM public.ca_ledger_write_failures;
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s).', v_fail);
  RETURN NEXT;

  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  SELECT count(*), COALESCE(sum(u.uncollected),0) INTO v_free, v_lost
    FROM public.fn_unpriced_tournaments('7 days') u;
  check_name := 'unpriced_tournaments';
  severity   := CASE WHEN v_free = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s COMPLETED tournament(s) in 7 days took a buy-in and earned no rake, ~%s uncollected.',
                       v_free, round(v_lost,2));
  RETURN NEXT;

  SELECT b.memberships, b.chips_held INTO v_flag, v_flag_chips
    FROM public.fn_bot_flag_disagreement() b;
  check_name := 'bot_flag_disagreement';
  severity   := CASE WHEN v_flag = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s membership(s) holding %s chips have club_members.is_bot disagreeing '
                       || 'with profiles.is_horse. Every is_bot-keyed report is wrong by this much.',
                       v_flag, round(v_flag_chips,2));
  RETURN NEXT;

  SELECT COALESCE(sum(balance),0), max(updated_at) INTO v_frozen, v_last_write FROM public.wallets;
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN v_last_write > now() - interval '2 days' THEN 'critical' ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips, last written %s. Dead pool; only a NEW write is news.',
                       round(v_frozen,2), COALESCE(v_last_write::text,'never'));
  RETURN NEXT;
END;
$$;

DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_chip_integrity_report();
  IF v_rows <> 7 THEN RAISE EXCEPTION 'expected 7 checks, got %', v_rows; END IF;
  RAISE NOTICE 'chip integrity report: 7 checks live';
END $$;
