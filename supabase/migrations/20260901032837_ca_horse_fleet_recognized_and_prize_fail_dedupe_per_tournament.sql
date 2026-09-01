-- Two fixes from the 03:20 incident storm (root cause: the horse harness
-- recreated its fleet at 01:10-02:10 with RANDOM UUIDs and
-- @horses.smarter.poker emails - 420 accounts the zero-UUID cert pattern no
-- longer matches, holding no club membership, seated into a union freeroll).
--
-- 1. fn_ca_is_cert_account learns the fleet's durable signature: the auth
--    email domain (@horses.smarter.poker, and the .invalid test domains).
--    This survives every future fleet recreation regardless of UUID shape.
--    The burst generation is also registered in ca_cert_accounts for fast
--    joins.
-- 2. One tournament with N unresolvable prize credits paged N separate
--    critical incidents (dedupe key hashed the per-place message). Under the
--    one-push-per-drift ruling, prize-credit failures now dedupe per
--    tournament: first failure raises and pushes once, subsequent places
--    fold into the same incident as occurrences.

CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    p_user_id::text LIKE '00000000-0000-0000-0000-%'
    OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                WHERE c.user_id = p_user_id AND c.active)
    OR EXISTS (SELECT 1 FROM auth.users u
                WHERE u.id = p_user_id
                  AND (u.email LIKE '%@horses.smarter.poker'
                       OR u.email LIKE '%.invalid'))
  );
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_is_cert_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_cert_account(uuid) TO authenticated, service_role;

INSERT INTO public.ca_cert_accounts (user_id, reason, active)
SELECT u.id,
       'Horse fleet generation of 2026-09-01 01:10-02:10 UTC (harness recreated with random UUIDs; recognized by @horses.smarter.poker / .invalid auth email)',
       true
FROM auth.users u
WHERE (u.email LIKE '%@horses.smarter.poker' OR u.email LIKE '%.invalid')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;
  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    /* Play-chip conservation (tournament AND spin/sng): in-game stacks are
       play chips - no wallet moved. Contained as info: tracked on the
       dashboard, counted by burn-in gate check #12, never paged. Everything
       else stays critical. Ruled 2026-08-31 (alert audit round 3). */
    p_severity       => CASE WHEN NEW.source ~* 'conservation' THEN 'info' ELSE 'critical' END,
    /* One root cause = one incident = one push. Per-place prize-credit
       failures for the same tournament share a dedupe key (the place-number
       message hash paged 7 criticals for one tournament on 2026-09-01);
       everything else keeps the message-hash key. */
    p_dedupe_key     => CASE
        WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
          THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
        ELSE 'fa:' || NEW.source || ':' || md5(left(NEW.message, 200)) END,
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => NULLIF(NEW.context->>'table_id','')::uuid,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;

-- Self-contained ACL (repo mirror requirement): both are operator/trigger
-- surface, service_role only (fn_ca_is_cert_account reads auth.users now, so
-- the invoker-era authenticated grant is closed; the five server-side
-- callers all run as definer or service).
REVOKE ALL ON FUNCTION public.fn_ca_is_cert_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_cert_account(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO service_role;
