-- Reuse exact weekly tournament/registration identities before their STABLE ownership witnesses.
-- Actual touched proof exhausted240s; prior169-220s observations are whole-CTE timings, not helper self-time.
-- Materialize distinct tournament IDs before ownership (planner previously filtered below DISTINCT).
-- Reuse satellite-owner evidence per eligible registration and join back to EVERY touched event;
-- preserve duplicate-event bad counts, NULL behavior, receipt/opening eligibility and all report output.
-- Coordinate the exact40-source matcher with this report atomically. The generation changes lawfully;
-- prior-generation certificates are NOT rewritten or extended and must be re-proved normally.
-- No money, certificate, partial, period, budget, memo, ACL or trigger data changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))='7b465b7055e80234bd8c40ed5899f4dd' AND md5(pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))='aaa32399c66e1e9d378a5634f8e79cb5' AND smarter_private.original_inventory_proof_sources_match() IS TRUE AND smarter_private.original_inventory_basis_generation() IS NOT NULL)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $touched_identities$
DECLARE def text;sig regprocedure;generation text;new_generation text;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL THEN RAISE EXCEPTION 'weekly_touched_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'weekly_touched_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'weekly_touched_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017034258')THEN RAISE EXCEPTION 'weekly_touched_history_replay';END IF;
 -- THE SECOND PIN (2026-10-17). fn_accounting_union_earned_plan_advance also
 -- pins this report's md5 (edecfc...): installing the report without moving
 -- that pin turns the two-hour flow-window path off, so the report re-proves
 -- every flow of the week in one statement, and the new generation voids every
 -- certificate of an open close. Refuse until the same transaction moves it.
 IF EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)')AND p.prosrc LIKE '%edecfc5273ee4c96b608baa0ea863578%')THEN RAISE EXCEPTION 'weekly_touched_earned_plan_advance_pin_not_moved';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR generation IS NULL THEN RAISE EXCEPTION 'weekly_touched_original_inventory_seal_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')AND md5(pg_get_functiondef(p.oid))='edecfc5273ee4c96b608baa0ea863578'AND md5(p.prosrc)='4e7c5597b6c5630ca1d8fd9e021a1f5f'AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.provolatile='v'AND p.proacl::text='{postgres=X/postgres}'AND p.proconfig=ARRAY['search_path=public, pg_temp'])THEN RAISE EXCEPTION 'weekly_touched_preimage_authority_refused_0';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.original_inventory_proof_sources_match()')AND md5(pg_get_functiondef(p.oid))='4a98179afccf2d31c127f50ed5ab9270'AND md5(p.prosrc)='334a987c679267bde32fc962f9865591'AND p.proowner='postgres'::regrole AND p.prosecdef=false AND p.provolatile='s'AND p.proacl::text='{postgres=X/postgres}'AND p.proconfig=ARRAY['search_path=pg_catalog'])THEN RAISE EXCEPTION 'weekly_touched_preimage_authority_refused_1';END IF;
 sig:='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure;def:=pg_get_functiondef(sig);
 IF(length(def)-length(replace(def,$touched_old$ WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);$touched_old$,'')))/length($touched_old$ WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);$touched_old$)<>1 THEN RAISE EXCEPTION 'weekly_touched_exact_query_replacement_refused';END IF;
 def:=replace(def,$touched_old$ WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);$touched_old$,$touched_new$ WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), distinct_tournaments AS MATERIALIZED (
  SELECT DISTINCT tournament_id FROM touched
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM distinct_tournaments d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ), unresolved_registrations AS MATERIALIZED (
  SELECT DISTINCT i.row_id FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
  WHERE NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
 ), satellite_owners AS MATERIALIZED (
  SELECT i.row_id,public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) owner
  FROM unresolved_registrations i
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 LEFT JOIN satellite_owners o ON o.row_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND o.owner IS NULL)
  OR COALESCE(e.has_other,false);$touched_new$);
 IF md5(def)<>'7b465b7055e80234bd8c40ed5899f4dd'THEN RAISE EXCEPTION 'weekly_touched_report_postimage_refused';END IF;
 EXECUTE def;
 sig:='smarter_private.original_inventory_proof_sources_match()'::regprocedure;def:=pg_get_functiondef(sig);
 IF(length(def)-length(replace(def,'edecfc5273ee4c96b608baa0ea863578','')))/32<>1 THEN RAISE EXCEPTION 'weekly_touched_exact_matcher_replacement_refused';END IF;
 def:=replace(def,'edecfc5273ee4c96b608baa0ea863578','7b465b7055e80234bd8c40ed5899f4dd');
 IF md5(def)<>'aaa32399c66e1e9d378a5634f8e79cb5'THEN RAISE EXCEPTION 'weekly_touched_matcher_postimage_refused';END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)')AND md5(pg_get_functiondef(p.oid))='7b465b7055e80234bd8c40ed5899f4dd'AND md5(p.prosrc)='232864c657aa5a99a55b07c7c174c27a'AND p.proowner='postgres'::regrole AND p.prosecdef=true AND p.provolatile='v'AND p.proacl::text='{postgres=X/postgres}'AND p.proconfig=ARRAY['search_path=public, pg_temp'])THEN RAISE EXCEPTION 'weekly_touched_installed_authority_refused_0';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.original_inventory_proof_sources_match()')AND md5(pg_get_functiondef(p.oid))='aaa32399c66e1e9d378a5634f8e79cb5'AND md5(p.prosrc)='fdc77993e4bfc5da6afd10bfd521a0ad'AND p.proowner='postgres'::regrole AND p.prosecdef=false AND p.provolatile='s'AND p.proacl::text='{postgres=X/postgres}'AND p.proconfig=ARRAY['search_path=pg_catalog'])THEN RAISE EXCEPTION 'weekly_touched_installed_authority_refused_1';END IF;
 new_generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR new_generation IS NULL OR new_generation IS NOT DISTINCT FROM generation THEN RAISE EXCEPTION 'weekly_touched_coordinated_inventory_generation_required';END IF;
END $touched_identities$;
COMMIT;
