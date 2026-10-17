-- 20261017223358_a_weekly_statement_fits_its_close_attempt
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 22:33:58 UTC.
--
-- A WEEKLY STATEMENT FITS ITS CLOSE ATTEMPT (2026-10-17)
--
-- The 2026-10-05 Midway union close (fade0000) has paid rounds 1, 2 and 3
-- (round 3 at 20:13:39 UTC: 588,824.90 to 777 payees, no shortfall). It cannot
-- finish. Every job 272 attempt since has hit its 240 s statement timeout
-- inside fn_club_weekly_accounting_summary, at the first club statement, and
-- was rolled back whole. Measured read-only on production 2026-10-17:
--
--   * Each club statement proves the club's tournament week with
--     fn_accounting_tournament_week_quality. For a Midway club that is the
--     whole union's tournament week (183,869 events, 288,957 tournament rake
--     records, 522,518 fee sources): more than 175 s per club, cancelled at
--     every limit tried. Its plan read whole history, not the week: the
--     club_sourced and club_refunded sets (1.6M and 529k rows, every event the
--     club or union ever had), the whole tournament_rake_settlements index
--     (686k rows) for a merge join, every fee source (1.42M) for fee_scope,
--     and four EXISTS tests the planner turned into hashed subplans over every
--     tournament rake record ever (one of them computing
--     fn_accounting_tournament_fee_fingerprint for 1.15M records). The
--     fingerprint itself costs ~210 us a record (it converts the whole row to
--     jsonb once per field, 17 times): 62 s for the week's 290k records.
--   * The statement's source fingerprint hashed each earning source's whole
--     contract (2.5 kB of text, 1.2M sources a club) and sorted 1.2M rows on
--     a text key under the database collation: 90 s a club.
--   * Two clubs, both in the one attempt that also settles the week and issues
--     every statement: well over the 240 s tick, every time.
--
-- WHAT CHANGES (no rate, amount, payee, routing, receipt, refusal, rounding,
-- idempotency key or ACL; no sealed source; four functions, exact
-- preimage -> postimage each, derived read-only on production with replace()):
--
-- 1. fn_accounting_tournament_week_quality reads the week, not history. The
--    same tests on the same rows, found by key: the settlements join and the
--    fee_scope sources by the week's candidates; club_sourced and
--    club_refunded as per-event EXISTS on their indexes (identical membership:
--    the club's or coordinating union's fee source, or the club's refund
--    entitlement, for that event); OFFSET 0 on the four unknown-scope EXISTS
--    so they stay per-event index probes (OFFSET 0 is a no-op); and the rake
--    record fingerprint computed inline as the identical expression
--    md5(jsonb_build_object(<the 17 fields>)::text), which is exactly the
--    jsonb object fn_accounting_tournament_fee_fingerprint aggregates
--    (checked below on install). That function itself is unchanged: its body
--    is pinned by fn_ca_guard_mtt_admission_contract.
--    Proved equivalent on production before this was written: identical
--    result for every window compared (Midway clubs, a full week and single
--    days; a standalone club), and an identical md5 over every output row and
--    column of the event query (22,602 and 1,663 rows) against the original
--    with only the no-op OFFSET 0 added. Measured: a full Midway week 78-87 s
--    against more than 175 s; a single day 6 s against 51 s.
-- 2. fn_club_weekly_accounting_summary fingerprints each source by its
--    identity (type, id, rake record, earned_at, rake credit), ordered by id
--    with a C-collated type: 11.5 s a club against 90 s. Every earning source
--    table refuses UPDATE, DELETE and TRUNCATE (accounting_cash_source_immutable,
--    accounting_tournament_fee_sources_immutable,
--    accounting_tournament_recognized_sources_immutable), so a source's
--    contract cannot change after the id names it. The report key becomes
--    source_fingerprint_v3, so the two formats are never compared; no function
--    reads it back (checked against pg_proc when v2 was introduced, and again
--    here). Issued statements keep their v2 value.
--    In a chunked union close it reads the club's tournament proof from a
--    close certificate when one is ready (below); otherwise it proves the
--    week exactly as before.
-- 3. fn_union_settlement_cascade, in a chunked close only, after every round
--    is committed and conservation is asserted and before anything is settled
--    or issued: proves one club's tournament week per attempt and keeps the
--    READY proof as close certificate 'club_statement_quality:<club>' (the
--    sealed fn_accounting_close_certify / fn_accounting_close_certificate,
--    called unchanged). A proof that is not ready refuses the statement with
--    the statement's own error. A proof that could not be kept changes
--    nothing: the attempt carries on exactly as before. The attempt that finds
--    every club proved settles and issues as before, now in seconds a club.
-- 4. fn_accounting_close_report_seed (20261017195000) stops treating those
--    statement certificates as a re-proof of the P&L report: they do not touch
--    anything the report reads, and without this each one would send the next
--    attempt back to proving the report.
--
-- GUARDS: refuses in the break window and while frozen; each function must be
-- its exact preimage or already its exact postimage; every anchor exactly
-- once; owner, SECURITY DEFINER, configuration and ACL proven unchanged; exact
-- readback; the inline fingerprint is checked equal to the function on the
-- rake records of the 500 most recently recognised tournaments; the original
-- inventory proof sources must still match.
--

-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)) = 'a3835ceb0138f097a2130970e3eab34a'
-- @live-proof: md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)) = 'f65b242882b9fed2f93fb4acbc9c91b9'
-- @live-proof: md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)) = '88417415bde34f4d8ea462950aa7f20f'
-- @live-proof: md5(pg_get_functiondef('public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)'::regprocedure)) = '58a9a79da50f36fa5fbc4242e8cec8f7'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'WEEKLY_STATEMENT_FIT_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'WEEKLY_STATEMENT_FIT_REFUSED: the platform is frozen' USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- The inline rake record fingerprint is the function's own value.
DO $fingerprint$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.rake_records r
     WHERE r.is_tournament
       AND r.tournament_id IN (SELECT f.tournament_id FROM public.accounting_tournament_fee_recognitions f
                                ORDER BY f.recognized_at DESC LIMIT 500)
       AND public.fn_accounting_tournament_fee_fingerprint(r) IS DISTINCT FROM
           md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text)) THEN
    RAISE EXCEPTION 'weekly statement fit: the inline fee fingerprint differs from fn_accounting_tournament_fee_fingerprint';
  END IF;
END
$fingerprint$;

DO $quality$
DECLARE
  c_sig constant text := 'public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)';
  v_oid oid := to_regprocedure(c_sig);
  v_def text; n int;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'weekly statement fit: % owner/target mismatch', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = 'a3835ceb0138f097a2130970e3eab34a' THEN RETURN; END IF;
  IF md5(v_def) <> 'f7679646772ffde0a3c659fbe214fa0f' THEN
    RAISE EXCEPTION 'weekly statement fit: unexpected live body of % (%)', c_sig, md5(v_def);
  END IF;
  n := (length(v_def) - length(replace(v_def, $o0$  ), club_sourced AS (
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id=p_club_id
   UNION
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE scope_union IS NOT NULL AND s.coordinator_union_id=scope_union
  ), club_refunded AS (
   SELECT e.tournament_id FROM public.tournament_refund_entitlements e WHERE e.refund_wallet_club_id=p_club_id
  ), scoped AS ($o0$, ''))) / length($o0$  ), club_sourced AS (
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id=p_club_id
   UNION
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE scope_union IS NOT NULL AND s.coordinator_union_id=scope_union
  ), club_refunded AS (
   SELECT e.tournament_id FROM public.tournament_refund_entitlements e WHERE e.refund_wallet_club_id=p_club_id
  ), scoped AS ($o0$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 0 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o0$  ), club_sourced AS (
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id=p_club_id
   UNION
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE scope_union IS NOT NULL AND s.coordinator_union_id=scope_union
  ), club_refunded AS (
   SELECT e.tournament_id FROM public.tournament_refund_entitlements e WHERE e.refund_wallet_club_id=p_club_id
  ), scoped AS ($o0$, $n0$  ), scoped AS ($n0$);
  n := (length(v_def) - length(replace(v_def, $o1$     LEFT JOIN public.tournament_rake_settlements b USING(tournament_id)$o1$, ''))) / length($o1$     LEFT JOIN public.tournament_rake_settlements b USING(tournament_id)$o1$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 1 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o1$     LEFT JOIN public.tournament_rake_settlements b USING(tournament_id)$o1$, $n1$     LEFT JOIN LATERAL (SELECT * FROM public.tournament_rake_settlements b0 WHERE b0.tournament_id=c.tournament_id OFFSET 0) b ON true$n1$);
  n := (length(v_def) - length(replace(v_def, $o2$    JOIN candidates c ON c.tournament_id=s.tournament_id GROUP BY s.tournament_id$o2$, ''))) / length($o2$    JOIN candidates c ON c.tournament_id=s.tournament_id GROUP BY s.tournament_id$o2$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 2 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o2$    JOIN candidates c ON c.tournament_id=s.tournament_id GROUP BY s.tournament_id$o2$, $n2$    WHERE s.tournament_id=ANY((SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[]) GROUP BY s.tournament_id$n2$);
  n := (length(v_def) - length(replace(v_def, $o3$       OR EXISTS(SELECT 1 FROM club_sourced cs WHERE cs.tournament_id=s.tournament_id)$o3$, ''))) / length($o3$       OR EXISTS(SELECT 1 FROM club_sourced cs WHERE cs.tournament_id=s.tournament_id)$o3$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 3 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o3$       OR EXISTS(SELECT 1 FROM club_sourced cs WHERE cs.tournament_id=s.tournament_id)$o3$, $n3$       OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources cs WHERE cs.tournament_id=s.tournament_id
        AND (cs.club_id=p_club_id OR (scope_union IS NOT NULL AND cs.coordinator_union_id=scope_union)) OFFSET 0)$n3$);
  n := (length(v_def) - length(replace(v_def, $o4$       OR EXISTS(SELECT 1 FROM club_refunded cr WHERE cr.tournament_id=s.tournament_id)$o4$, ''))) / length($o4$       OR EXISTS(SELECT 1 FROM club_refunded cr WHERE cr.tournament_id=s.tournament_id)$o4$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 4 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o4$       OR EXISTS(SELECT 1 FROM club_refunded cr WHERE cr.tournament_id=s.tournament_id)$o4$, $n4$       OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements cr WHERE cr.tournament_id=s.tournament_id
        AND cr.refund_wallet_club_id=p_club_id OFFSET 0)$n4$);
  n := (length(v_def) - length(replace(v_def, $o5$OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0))$o5$, ''))) / length($o5$OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0))$o5$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 5 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o5$OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0))$o5$, $n5$OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0 OFFSET 0))$n5$);
  n := (length(v_def) - length(replace(v_def, $o6$(NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0)$o6$, ''))) / length($o6$(NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0)$o6$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 6 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o6$(NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0)$o6$, $n6$(NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0 OFFSET 0)$n6$);
  n := (length(v_def) - length(replace(v_def, $o7$OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)))$o7$, ''))) / length($o7$OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)))$o7$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 7 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o7$OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)))$o7$, $n7$OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)) OFFSET 0)$n7$);
  n := (length(v_def) - length(replace(v_def, $o8$OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text))))$o8$, ''))) / length($o8$OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text))))$o8$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 8 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o8$OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text))))$o8$, $n8$OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text) OFFSET 0)))$n8$);
  n := (length(v_def) - length(replace(v_def, $o9$public.fn_accounting_tournament_fee_fingerprint(r) AS fp$o9$, ''))) / length($o9$public.fn_accounting_tournament_fee_fingerprint(r) AS fp$o9$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 9 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o9$public.fn_accounting_tournament_fee_fingerprint(r) AS fp$o9$, $n9$md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text) AS fp$n9$);
  IF md5(v_def) <> 'a3835ceb0138f097a2130970e3eab34a' THEN
    RAISE EXCEPTION 'weekly statement fit: computed postimage of % is %', c_sig, md5(v_def);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_def;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'weekly statement fit: exact readback of % failed', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'weekly statement fit: authority drift on %', c_sig;
  END IF;
END
$quality$;

DO $summary$
DECLARE
  c_sig constant text := 'public.fn_club_weekly_accounting_summary(uuid)';
  v_oid oid := to_regprocedure(c_sig);
  v_def text; n int;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'weekly statement fit: % owner/target mismatch', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = 'f65b242882b9fed2f93fb4acbc9c91b9' THEN RETURN; END IF;
  IF md5(v_def) <> 'd758a70fe31aa3fa828704a0ee1788cd' THEN
    RAISE EXCEPTION 'weekly statement fit: unexpected live body of % (%)', c_sig, md5(v_def);
  END IF;
  n := (length(v_def) - length(replace(v_def, $o0$  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text),'' ORDER BY s.source_type,s.source_id),'')),$o0$, ''))) / length($o0$  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text),'' ORDER BY s.source_type,s.source_id),'')),$o0$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 0 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o0$  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text),'' ORDER BY s.source_type,s.source_id),'')),$o0$, $n0$  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit)::text),'' ORDER BY s.source_id,s.source_type COLLATE "C"),'')),$n0$);
  n := (length(v_def) - length(replace(v_def, $o1$'source_count',source_count,'source_fingerprint_v2',source_fingerprint,$o1$, ''))) / length($o1$'source_count',source_count,'source_fingerprint_v2',source_fingerprint,$o1$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 1 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o1$'source_count',source_count,'source_fingerprint_v2',source_fingerprint,$o1$, $n1$'source_count',source_count,'source_fingerprint_v3',source_fingerprint,$n1$);
  n := (length(v_def) - length(replace(v_def, $o2$ quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);$o2$, ''))) / length($o2$ quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);$o2$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 2 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o2$ quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);$o2$, $n2$ -- A chunked union close proves each club's tournament week as its own step
 -- (20261017223358) and keeps the ready proof as a close certificate; read
 -- outside that close, or without one, the week is proved here as before.
 quality:=CASE WHEN period.union_id IS NOT NULL THEN public.fn_accounting_close_certificate(
  'club_statement_quality:'||period.club_id::text,period.union_id,period.start_at,period.end_at) END;
 IF quality->>'status' IS DISTINCT FROM 'ready' THEN
  quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);
 END IF;$n2$);
  IF md5(v_def) <> 'f65b242882b9fed2f93fb4acbc9c91b9' THEN
    RAISE EXCEPTION 'weekly statement fit: computed postimage of % is %', c_sig, md5(v_def);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_def;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'weekly statement fit: exact readback of % failed', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'weekly statement fit: authority drift on %', c_sig;
  END IF;
END
$summary$;

DO $cascade$
DECLARE
  c_sig constant text := 'public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)';
  v_oid oid := to_regprocedure(c_sig);
  v_def text; n int;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'weekly statement fit: % owner/target mismatch', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '88417415bde34f4d8ea462950aa7f20f' THEN RETURN; END IF;
  IF md5(v_def) <> 'c10eaa893fb7b59e073d5687b4437bdd' THEN
    RAISE EXCEPTION 'weekly statement fit: unexpected live body of % (%)', c_sig, md5(v_def);
  END IF;
  n := (length(v_def) - length(replace(v_def, $o0$  v_pending jsonb; v_posted record;$o0$, ''))) / length($o0$  v_pending jsonb; v_posted record;$o0$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 0 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o0$  v_pending jsonb; v_posted record;$o0$, $n0$  v_pending jsonb; v_posted record; v_quality jsonb;$n0$);
  n := (length(v_def) - length(replace(v_def, $o1$  -- The period is an accounting object, not a by-product of invoicing.
$o1$, ''))) / length($o1$  -- The period is an accounting object, not a by-product of invoicing.
$o1$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 1 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o1$  -- The period is an accounting object, not a by-product of invoicing.
$o1$, $n1$  -- A CLUB STATEMENT'S TOURNAMENT PROOF IS ITS OWN STEP (20261017223358).
  -- Every club statement below proves its club's tournament week, about a
  -- minute a club at Midway's scale, and all of them were proved in the one
  -- attempt that also settles and issues: two clubs did not fit job 272's
  -- 240 s tick, so the 2026-10-05 Midway close could not finish. In a chunked
  -- close each club's READY proof is kept as a close certificate, one club per
  -- attempt, before anything below is settled or issued; the statement reads
  -- it back. A proof that is not ready refuses the statement here, as the
  -- statement itself would. A proof that cannot be kept changes nothing.
  IF v_chunked THEN
    FOR v_credit_club IN SELECT uc.club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) uc
                          WHERE uc.club_id<>p_union_id ORDER BY uc.club_id LOOP
      CONTINUE WHEN public.fn_accounting_close_certificate('club_statement_quality:'||v_credit_club.club_id::text,
        p_union_id,v_from,v_to)->>'status'='ready';
      PERFORM public.fn_weekly_accounting_deadline_check();
      v_quality:=public.fn_accounting_tournament_week_quality(v_credit_club.club_id,v_from,v_to);
      IF v_quality->>'status' IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',
          DETAIL=jsonb_build_object('club_id',v_credit_club.club_id,'tournament_quality',v_quality)::text;
      END IF;
      PERFORM public.fn_accounting_close_certify('club_statement_quality:'||v_credit_club.club_id::text,
        p_union_id,v_from,v_to,v_quality);
      IF public.fn_accounting_close_certificate('club_statement_quality:'||v_credit_club.club_id::text,
        p_union_id,v_from,v_to)->>'status'='ready' THEN
        RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3,
          'stage', 'statement_evidence', 'club_id', v_credit_club.club_id,
          'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to);
      END IF;
      EXIT;
    END LOOP;
  END IF;

  -- The period is an accounting object, not a by-product of invoicing.
$n1$);
  IF md5(v_def) <> '88417415bde34f4d8ea462950aa7f20f' THEN
    RAISE EXCEPTION 'weekly statement fit: computed postimage of % is %', c_sig, md5(v_def);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_def;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'weekly statement fit: exact readback of % failed', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'weekly statement fit: authority drift on %', c_sig;
  END IF;
END
$cascade$;

DO $seed$
DECLARE
  c_sig constant text := 'public.fn_accounting_close_report_seed(uuid,timestamptz,timestamptz)';
  v_oid oid := to_regprocedure(c_sig);
  v_def text; n int;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL THEN
    RAISE EXCEPTION 'weekly statement fit: % owner/target mismatch', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) = '58a9a79da50f36fa5fbc4242e8cec8f7' THEN RETURN; END IF;
  IF md5(v_def) <> '981a3fdf3bdba29ed736f8656a9e544b' THEN
    RAISE EXCEPTION 'weekly statement fit: unexpected live body of % (%)', c_sig, md5(v_def);
  END IF;
  n := (length(v_def) - length(replace(v_def, $o0$       AND c.certified_at>r.computed_at);$o0$, ''))) / length($o0$       AND c.certified_at>r.computed_at);$o0$);
  IF n <> 1 THEN RAISE EXCEPTION 'weekly statement fit: % anchor 0 occurs % times', c_sig, n; END IF;
  v_def := replace(v_def, $o0$       AND c.certified_at>r.computed_at);$o0$, $n0$       AND c.certified_at>r.computed_at AND c.kind NOT LIKE 'club\_statement\_quality:%');$n0$);
  IF md5(v_def) <> '58a9a79da50f36fa5fbc4242e8cec8f7' THEN
    RAISE EXCEPTION 'weekly statement fit: computed postimage of % is %', c_sig, md5(v_def);
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
    INTO v_owner, v_secdef, v_config, v_acl FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE v_def;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'weekly statement fit: exact readback of % failed', c_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                   AND p.proowner = v_owner AND p.prosecdef = v_secdef
                   AND p.proconfig IS NOT DISTINCT FROM v_config
                   AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
    RAISE EXCEPTION 'weekly statement fit: authority drift on %', c_sig;
  END IF;
END
$seed$;

DO $post$
BEGIN
  IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'weekly statement fit: the original inventory proof sources no longer match';
  END IF;
END
$post$;

COMMIT;
