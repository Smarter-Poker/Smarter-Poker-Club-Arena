-- 20261017121603_the_union_sweep_warnings_close_on_their_evidence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 12:16:03 UTC.
--
-- THE UNION SWEEP WARNINGS CLOSE ON THEIR EVIDENCE (2026-10-17)
--
-- Two warnings from job 123 (union-integrity-sweep, fn_union_integrity_sweep_all)
-- were still open after the condition they describe had a fix in place.
--
-- 1. fn_union_rake_basis_refresh out_of_time (3d48fb85, 2026-10-16 02:35).
--    The sweep raises this when the open-week rake basis snapshot runs out of
--    the sweep's time and keeps its previous refresh, and keeps ONE open per
--    union. Nothing closed it when a refresh landed again, so the next
--    out-of-time hour after a recovery would raise nothing at all. Read on
--    2026-10-17 12:10 UTC: the windowed refresh (20261003224956) is catching
--    up. 55 two-hour windows of the 2026-10-12 week are saved, the latest
--    ending 2026-10-16 21:00, with 45 computed in the last 12 hours. Job 123
--    has run in 121-176 s every hour since 2026-10-17 00:35, so no hour has
--    timed out. The snapshot itself still reads computed_at 2026-10-15 17:35.
--    The sweep now resolves that union's out_of_time warning in the same
--    subtransaction as a refresh that landed (success, not skipped). That
--    closes this row when the catch-up finishes, and lets every later out-of-time
--    hour be raised again. Pinned-preimage substitution: live md5 729a5617...,
--    anchor exactly once, postimage md5 12861fc6... derived read-only on
--    production with replace(); owner, SECURITY DEFINER, configuration and
--    ACL proven unchanged.
--
-- 2. fn_union_integrity_sweep (cc0387d7, 2026-10-15 18:35), 739
--    direct_chip_transfer signals. Its cause was fixed at the root by
--    20261016013849 (a club bank send is not a player transfer). Read again
--    here: every chip_transaction from the owner 47965354 in that alert's
--    window (2026-10-14 18:35 to 2026-10-15 18:35) is a club_bank_send
--    (1,903) or club_bank_claim (4), both excluded by the live sweep. Not one
--    remaining signal of that window survives. This closes that one row, and
--    asserts the evidence or aborts.
--
-- GUARDS: refuses in the break window; the substitution refuses an unknown
-- preimage; the close matches exactly one row or aborts.
-- @live-proof: md5(pg_get_functiondef('public.fn_union_integrity_sweep_all(integer)'::regprocedure)) = '12861fc647dd2b033ecc875f7b5fa3f7'
-- @live-proof: (SELECT resolved FROM public.financial_alerts WHERE id = 'cc0387d7-e38f-4200-b0ab-d5cae4ab10d9')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'UNION_SWEEP_WARNINGS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_sig constant text := 'public.fn_union_integrity_sweep_all(integer)';
  c_old constant text := $old$      ELSIF COALESCE((v_rb->>'success')::boolean, false) THEN
        v_rb_refreshed := v_rb_refreshed + 1;
      END IF;$old$;
  c_new constant text := $new$      ELSIF COALESCE((v_rb->>'success')::boolean, false) THEN
        v_rb_refreshed := v_rb_refreshed + 1;
        -- A REFRESH THAT LANDED ENDS ITS OUT-OF-TIME WARNING (2026-10-17). The
        -- warning below describes a snapshot that kept its previous refresh;
        -- this one did not, so the warning is over. Nothing else closed it.
        UPDATE financial_alerts a
           SET resolved = true, resolved_at = now(),
               resolution = 'Cleared by fn_union_integrity_sweep_all at ' || now()::text
                 || ': the open-week rake basis snapshot refreshed again (through '
                 || COALESCE(v_rb->>'through', 'unknown') || ').'
         WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
           AND a.context->>'kind' = 'out_of_time'
           AND a.context->>'union_id' = u.id::text;
      END IF;$new$;
  v_oid oid := to_regprocedure(c_sig);
  v_def text;
  v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'union sweep: owner/target mismatch';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '12861fc647dd2b033ecc875f7b5fa3f7' THEN
    RETURN;
  END IF;
  IF md5(v_def) <> '729a5617801d0038b1fa3c10f488c0bb' THEN
    RAISE EXCEPTION 'union sweep: unexpected live body %', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'union sweep: the refresh branch is not exactly once';
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(v_new) <> '12861fc647dd2b033ecc875f7b5fa3f7' THEN
    RAISE EXCEPTION 'union sweep: computed postimage is %', md5(v_new);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_new;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'union sweep: exact readback failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl
                   AND v_acl = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'union sweep: authority drift';
  END IF;
END
$install$;

DO $close$
DECLARE v_n int;
BEGIN
  -- The evidence: nothing the live sweep would still flag remains in that
  -- alert's window from the owner it named.
  IF EXISTS (
    SELECT 1 FROM public.chip_transactions ct
     WHERE ct.from_user_id = '47965354-0e56-43ef-931c-ddaab82af765'
       AND ct.to_user_id IS NOT NULL
       AND ct.created_at >= '2026-10-14 18:35:00+00' AND ct.created_at < '2026-10-15 18:35:01+00'
       AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout',
                                       'club_bank_claim','club_bank_send')) THEN
    RAISE EXCEPTION 'union sweep: a non-bank owner transfer remains in the alert window';
  END IF;
  IF (SELECT count(*) FROM public.chip_transactions ct
       WHERE ct.from_user_id = '47965354-0e56-43ef-931c-ddaab82af765'
         AND ct.transaction_type = 'club_bank_send'
         AND ct.created_at >= '2026-10-14 18:35:00+00' AND ct.created_at < '2026-10-15 18:35:01+00') <> 1903 THEN
    RAISE EXCEPTION 'union sweep: the club bank sends of the alert window are not the 1,903 read';
  END IF;
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: every one of the 739 direct_chip_transfer signals was an owner club_bank_send '
           || '(the 2026-10-15 horse wallet reset, 1,903 sends from four club banks), which the sweep no longer '
           || 'reads as a player transfer since 20261016013849. migration 20261017121603_the_union_sweep_warnings_close_on_their_evidence'
   WHERE a.id = 'cc0387d7-e38f-4200-b0ab-d5cae4ab10d9'
     AND a.source = 'fn_union_integrity_sweep'
     AND a.resolved IS NOT TRUE
     AND jsonb_array_length(a.context->'direct_chip_transfer') = 739
     AND jsonb_array_length(a.context->'agent_roster_winning') = 0
     AND jsonb_array_length(a.context->'co_seating') = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'union sweep: expected to close 1 integrity alert, matched %', v_n;
  END IF;
END
$close$;

COMMIT;
