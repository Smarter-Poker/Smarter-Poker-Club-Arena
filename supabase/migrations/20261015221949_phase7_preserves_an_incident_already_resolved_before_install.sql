-- Successor of 20261015182553: preserve already-resolved incidents under row lock.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_launch_health()'::regprocedure))='8a0ef4270d9396ef148276482c1346c1' AND md5(pg_get_functiondef('public.fn_ca_operator_floor_hold_watchdog()'::regprocedure))='548f8211e96c5856776d7d5725ba9c20' AND to_regprocedure('public.fn_ca_launch_health_tournament_held(uuid,uuid)') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.financial_alerts WHERE id IN ('38fd1e96-4a87-4561-a7bc-31cd1a1c2772','67c3926b-770e-40f4-bffb-c386ba1f56fe','1af6c215-3001-4bc0-b96f-99377501c076','95ae599f-f683-46fd-b60d-8b00be0309d7') AND resolved IS NOT TRUE))
-- 20261015182553_a_parked_floor_is_not_an_overdue_start_and_the_verified_aler.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (tournament hardening, phase 7 of 8):
--
-- 1. A DELIBERATE OWNER PARK IS NOT AN OVERDUE START. From 16:53 to 18:10
--    UTC on 2026-10-15 Dan's operation 3d9c1ba1 ("Owner Horse Wallet Reset")
--    parked the floor of all seven clubs. A scoped park holds every
--    tournament in its scope by design (fn_ca_launch_tournament_held,
--    fn_ca_operator_floor_entry_guard), so the Friday Night Feature Satellite
--    and two 17:00 MTTs sat in REGISTERING until the 18:10:56 resume and then
--    started (18:20). fn_ca_launch_health read those three as start_overdue
--    and turned the whole launch red for a stop the owner made on purpose,
--    the same way it already reads the hourly maintenance freeze as green.
--    Every event before 16:51 started on time (0 s late) that day. A start
--    the operator floor is holding (or released less than 15 minutes ago)
--    is now listed under 'held_by_operator' and does not colour the area;
--    a start that is late for any other reason is still red.
--    New helper fn_ca_launch_health_tournament_held(club, union): STABLE,
--    no locks (fn_ca_launch_tournament_held is VOLATILE and takes the
--    admission lane's advisory locks, which a pure health read must not).
--
-- 2. A CLOSE WHOSE TABLE IS GONE REFUSES NOTHING. The park's close_cash
--    operation fb484cc1 closed 134 cash tables; 125 received their resume
--    receipt at 18:10:56. The other 9 had been deleted after they closed,
--    so fn_ca_launch_cash_close_resumed (which joins public.tables) can
--    never be true for them, and fn_ca_operator_floor_hold_watchdog's step
--    (d) refused to close its own alert 1af6c215 for ever. A close row whose
--    table no longer exists cannot refuse a seat (fn_ca_operator_floor_entry_guard
--    reads the seat's own table), so step (d) now only waits for closes whose
--    table still exists. Root fix in the watchdog; nothing is written to the
--    close rows.
--
-- 3. THE OPEN ALERTS WHOSE CAUSE IS VERIFIED CLOSE, each behind an assertion
--    that the cause is gone (the established triage style, 20261015124934):
--    A. Guard definition drift 7e831a2c / 38fd1e96: fn_ca_raise_drift_incident
--       e6dac566 -> b5025fd1 is migration 20261015024752 (PR #6978, merged
--       cb029c76, installed), whose live-proof is that exact hash.
--    B. Ledger refusal 56b271f4 / 67c3926b: the guard REFUSED and rolled back
--       20261015053941 (a 1.00 race in fn_seed_horses_to_floor between its
--       treasury debit read and its per-horse ledger legs while the pilot
--       horses were playing). Superseded by 20261015093554 (PR #6930), which
--       locks the club row and every horse wallet before the first read. No
--       refusal since, and the treasury equals its chip_ledger net (asserted
--       under the club row lock).
--    C. Spin fairness 3e617549 / f5714015 / ba5d559f: the draw is fair. Over
--       42 days of unlocked at-draw receipts: chi-square under 18.475 (p 0.01,
--       7 df) over at least 250,000 draws, one tier ladder equal to
--       spin_tier_spec, zero off-ladder draws (measured 13.05 over 271,422).
--       The 04:44 alert is a sliding-window tail: 25x and 50x ran high from
--       Oct 9 to 13 after running low around Oct 2. The draw function
--       (fn_spin_draw_multiplier, CSPRNG inverse-CDF over the manifest) is
--       exact. The detector is unchanged here.
--    D. Floor hold 1af6c215 / 95ae599f / 62cc056f: the hold is gone, Dan's
--       own resume b930a4a2 ended it at 18:10:56, and every close whose table
--       exists holds its resume receipt.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'phase7_triage_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'phase7_triage_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'phase7_triage_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'phase7_triage_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015221949') THEN RAISE EXCEPTION 'phase7_triage_history_replay';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015182553') THEN RAISE EXCEPTION 'phase7_predecessor_already_installed';END IF;
 IF md5(pg_get_functiondef('public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure))<>'1017987e76a8327b7d379d795a317401' THEN RAISE EXCEPTION 'phase7_incident_authority_changed';END IF;
 IF to_regprocedure('public.fn_ca_launch_health_tournament_held(uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'phase7_triage_already_present';END IF;
END $guard$;

-- The broad fairness read finishes before the treasury row is locked.
DO $c$
DECLARE v_fair boolean;
BEGIN
  WITH d AS (
    SELECT (r.receipt->>'multiplier')::int AS m,
           (SELECT jsonb_agg(jsonb_build_array((x->>'multiplier')::int, (x->>'freq')::bigint, (x->>'reserveThresholdX')::numeric)
                             ORDER BY (x->>'multiplier')::int)
              FROM jsonb_array_elements(r.rule_manifest->'tiers') x) AS ladder
      FROM public.spin_draw_receipts r
     WHERE r.created_at > now() - interval '42 days'
       AND r.receipt->>'rule_provenance' = 'at_draw'
       AND r.receipt->'locked' = '[]'::jsonb),
  spec AS (SELECT jsonb_agg(jsonb_build_array(multiplier, freq, reserve_threshold_x) ORDER BY multiplier) AS ladder,
                  sum(freq)::numeric AS f FROM public.spin_tier_spec),
  n AS (SELECT count(*)::numeric AS n FROM d),
  chi AS (SELECT sum((coalesce(c.c, 0) - n.n * s.freq / spec.f) ^ 2 / (n.n * s.freq / spec.f)) AS chi
            FROM public.spin_tier_spec s CROSS JOIN n CROSS JOIN spec
            LEFT JOIN (SELECT m, count(*) AS c FROM d GROUP BY m) c ON c.m = s.multiplier),
  man AS (SELECT count(DISTINCT d.ladder) AS manifests,
                 bool_and(d.ladder IS NOT NULL AND d.ladder = spec.ladder) AS all_equal_spec
            FROM d CROSS JOIN spec),
  off AS (SELECT count(*) AS off_ladder FROM d WHERE m IS NULL OR m NOT IN (SELECT multiplier FROM public.spin_tier_spec))
  SELECT (chi.chi < 18.475 AND n.n >= 250000 AND man.manifests = 1 AND man.all_equal_spec AND off.off_ladder = 0)
    INTO v_fair FROM chi, n, man, off;
  IF v_fair IS NOT TRUE THEN
    RAISE EXCEPTION 'C: the 42 day Spin draw distribution is not proven fair';
  END IF;
END
$c$;

-- 1. A deliberate owner park is not an overdue start.
CREATE FUNCTION public.fn_ca_launch_health_tournament_held(p_club uuid, p_union uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 -- A PARKED FLOOR IS NOT AN OVERDUE START (20261015182553). True while an
 -- operator park covers this tournament's club or union (an unscoped park
 -- covers every club), or while a floor resume covering it is less than 15
 -- minutes old, so the event gets the same 15 minute grace from its release
 -- that it gets from its start time. A pure read: no advisory lock.
 SELECT EXISTS (SELECT 1 FROM public.ca_operator_floor_hold h
                 WHERE h.mode = 'park'
                   AND (NOT EXISTS (SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id = h.operation_id)
                        OR EXISTS (SELECT 1 FROM public.ca_launch_operator_scopes m
                                    WHERE m.operation_id = h.operation_id
                                      AND (p_club = ANY(m.club_ids) OR p_union = ANY(m.club_ids)))))
     OR EXISTS (SELECT 1 FROM public.ca_engine_operator_commands c
                 WHERE c.domain = 'floor' AND c.action = 'resume'
                   AND c.created_at > now() - interval '15 minutes'
                   AND (NOT EXISTS (SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id = c.id)
                        OR EXISTS (SELECT 1 FROM public.ca_launch_operator_scopes m
                                    WHERE m.operation_id = c.id
                                      AND (p_club = ANY(m.club_ids) OR p_union = ANY(m.club_ids)))));
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_health_tournament_held(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_health_tournament_held(uuid,uuid) TO service_role;

DO $launch_health$
DECLARE
 sig constant regprocedure:='public.fn_ca_launch_health()'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$t.start_time < now() - interval '15 minutes'), '[]'::jsonb))$anchor$;
 n text:=$anchor$t.start_time < now() - interval '15 minutes'
               -- A PARKED FLOOR IS NOT AN OVERDUE START (20261015182553).
               AND NOT public.fn_ca_launch_health_tournament_held(t.club_id, t.union_id)), '[]'::jsonb),
           'held_by_operator', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'start_time', t.start_time))
              FROM public.tournaments t
             WHERE t.status = 'REGISTERING' AND t.tournament_type IN ('MTT', 'SATELLITE') AND t.start_time < now() - interval '15 minutes'
               AND public.fn_ca_launch_health_tournament_held(t.club_id, t.union_id)), '[]'::jsonb))$anchor$;
 before text;
BEGIN
 IF md5(def)<>'9940e7b65a9f55eef212928bf7ae3ad5' THEN RAISE EXCEPTION 'launch_health_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'launch_health_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'8a0ef4270d9396ef148276482c1346c1' THEN RAISE EXCEPTION 'launch_health_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'launch_health_security_refused';END IF;
END $launch_health$;

-- 2. A close whose table is gone refuses nothing.
DO $watchdog$
DECLARE
 sig constant regprocedure:='public.fn_ca_operator_floor_hold_watchdog()'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                      WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE);$anchor$;
 n text:=$anchor$     AND NOT EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
                      WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE
                        -- A CLOSE WHOSE TABLE IS GONE REFUSES NOTHING (20261015182553).
                        AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = c.table_id));$anchor$;
 before text;
BEGIN
 IF md5(def)<>'9f8b378e6a8cf3a340fe9c007e680e8a' THEN RAISE EXCEPTION 'watchdog_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'watchdog_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'548f8211e96c5856776d7d5725ba9c20' THEN RAISE EXCEPTION 'watchdog_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'watchdog_security_refused';END IF;
END $watchdog$;

-- 3A. Guard definition drift: the change is a merged, installed migration.
DO $a$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)'::regprocedure)) <> 'b5025fd1a0f856767f3a91166722ed7f' THEN
    RAISE EXCEPTION 'A: fn_ca_raise_drift_incident is not the 20261015024752 postimage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261015024752') THEN
    RAISE EXCEPTION 'A: 20261015024752 is not installed';
  END IF;
  IF (SELECT md5(def_text) FROM public.ca_guard_def_history WHERE id = 55885) <> 'b5025fd1a0f856767f3a91166722ed7f' THEN
    RAISE EXCEPTION 'A: the recorded new definition is not the installed one';
  END IF;
END
$a$;
SELECT public.fn_ca_incident_action('7e831a2c-911c-455d-b4f3-644eec1ce8e5', 'resolve',
  'Verified 2026-10-15: fn_ca_raise_drift_incident changed from e6dac566 to b5025fd1 by migration 20261015024752 (a finding with no amount is not a chip drift), PR #6978 merged as cb029c76 and installed; its live-proof is that exact hash and history row 55885 holds it. migration 20261015221949',
  NULL,
  'An intended guard change installed by reviewed migration 20261015024752; the watch records every redefinition.',
  'migration 20261015024752 (PR #6978)')
 FROM (SELECT id FROM public.ca_drift_incidents
        WHERE id='7e831a2c-911c-455d-b4f3-644eec1ce8e5' AND status <> 'resolved' FOR UPDATE) unresolved;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'Verified 2026-10-15: the guard redefinition is migration 20261015024752 (PR #6978, merged cb029c76, installed; live hash b5025fd1 asserted). migration 20261015221949'
 WHERE id = '38fd1e96-4a87-4561-a7bc-31cd1a1c2772' AND resolved IS NOT TRUE;

-- 3B. Ledger refusal: refused and rolled back, root fixed, treasury balanced.
DO $b$
BEGIN
  PERFORM 1 FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' FOR UPDATE;
  IF position('FOR UPDATE OF cm' in pg_get_functiondef('public.fn_seed_horses_to_floor(uuid,numeric)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'B: fn_seed_horses_to_floor does not lock the wallets it reads';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261015093554')
     OR EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261015053941') THEN
    RAISE EXCEPTION 'B: the refused migration is installed or its replacement is not';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_refusals WHERE id > 7
              AND account_key = 'club_treasury:e14bc9f7-736d-425f-8f2c-e78305ebac1d') THEN
    RAISE EXCEPTION 'B: the treasury has been refused again';
  END IF;
  IF (SELECT chip_treasury FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d')
     IS DISTINCT FROM
     (SELECT coalesce(sum(CASE WHEN to_type = 'club_treasury' AND to_entity_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' THEN amount END), 0)
           - coalesce(sum(CASE WHEN from_type = 'club_treasury' AND from_entity_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' THEN amount END), 0)
        FROM public.chip_ledger
       WHERE (to_type = 'club_treasury' AND to_entity_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d')
          OR (from_type = 'club_treasury' AND from_entity_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d')) THEN
    RAISE EXCEPTION 'B: the treasury does not equal its ledger net';
  END IF;
END
$b$;
SELECT public.fn_ca_incident_action('56b271f4-7e9d-4849-a763-8f1e3f614f9d', 'resolve',
  'Verified 2026-10-15: refusal 7 rolled back the whole apply of 20261015053941, so nothing moved. Its 1.00 gap was a race in fn_seed_horses_to_floor: the treasury debit came from one read of the horse wallets and the per-horse ledger legs from a later one while the pilot horses were playing Spins. 20261015093554 (PR #6930, installed) supersedes it and locks the club row and every horse wallet before the first read; no refusal since, and the treasury equals its chip_ledger net (asserted under the club row lock). migration 20261015221949',
  NULL,
  'fn_seed_horses_to_floor read horse wallet balances twice without a lock, so its treasury debit and its ledger legs could disagree.',
  'migration 20261015093554 (PR #6930)')
 FROM (SELECT id FROM public.ca_drift_incidents
        WHERE id='56b271f4-7e9d-4849-a763-8f1e3f614f9d' AND status <> 'resolved' FOR UPDATE) unresolved;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'Verified 2026-10-15: the refused write never committed; root fixed by 20261015093554 (wallets locked before the first read); treasury equals its ledger net (asserted). migration 20261015221949'
 WHERE id = '67c3926b-770e-40f4-bffb-c386ba1f56fe' AND resolved IS NOT TRUE;

-- 3C. Spin fairness: the 42 day distribution is on the published ladder.

SELECT public.fn_ca_incident_action('ba5d559f-1b81-4737-8ba1-e94cd4773b7b', 'resolve',
  'Verified 2026-10-15: the Spin draw is fair. Over 42 days of unlocked at-draw receipts the distribution matches spin_tier_spec (chi-square 13.05 on 7 df over 271,422 draws, under the p 0.01 line of 18.475; asserted), every receipt carries the one published ladder and none is off it. The 04:44 reading is a tail of an hourly sliding 7 day window: 25x and 50x ran high from Oct 9 to 13 after running low around Oct 2. fn_spin_draw_multiplier draws by CSPRNG inverse-CDF over the manifest exactly. migration 20261015221949',
  NULL,
  'A statistical tail of an hourly sliding 7 day window, not a draw defect; proven fair over 42 days of receipts.',
  'migration 20261015221949')
 FROM (SELECT id FROM public.ca_drift_incidents
        WHERE id='ba5d559f-1b81-4737-8ba1-e94cd4773b7b' AND status <> 'resolved' FOR UPDATE) unresolved;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'Verified 2026-10-15: the 42 day Spin distribution is on the published ladder (chi-square 13.05 on 7 df over 271,422 unlocked at-draw receipts, one manifest equal to spin_tier_spec, zero off-ladder; asserted). The 7 day reading is a sliding-window tail. No money moved. migration 20261015221949'
 WHERE id IN ('3e617549-ced5-4f0a-abc8-f083a32ef60d', 'f5714015-aab9-41d7-a219-7be28110005f') AND resolved IS NOT TRUE;

-- 3D. Floor hold: released by the owner, every live close resumed.
DO $d$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_operator_floor_hold) THEN
    RAISE EXCEPTION 'D: a floor hold is still in place';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_engine_operator_commands
                  WHERE id = 'b930a4a2-a45e-42ec-af12-23f7c9e50879' AND domain = 'floor' AND action = 'resume') THEN
    RAISE EXCEPTION 'D: the owner resume is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_operator_table_closes c
              WHERE public.fn_ca_launch_cash_close_resumed(c.table_id, c.operation_id) IS NOT TRUE
                AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = c.table_id)) THEN
    RAISE EXCEPTION 'D: a close whose table exists has no resume receipt';
  END IF;
END
$d$;
SELECT public.fn_ca_incident_action('62cc056f-eade-4196-a292-a6deea69732f', 'resolve',
  'Verified 2026-10-15: Dan''s own park 3d9c1ba1 (Owner Horse Wallet Reset) held the floor from 16:53 and was renewed once at 17:41 when a maintenance freeze interrupted the reset; his resume b930a4a2 ended it at 18:10:56 and every close whose table still exists holds its resume receipt (asserted). The alert stayed open only because 9 closed tables were deleted after closing, which the watchdog''s close step now ignores (root fix in this migration). migration 20261015221949',
  NULL,
  'A deliberate owner park longer than the 10 minute page threshold; its alert could not close because the watchdog waited on closes of deleted tables.',
  'migration 20261015221949')
 FROM (SELECT id FROM public.ca_drift_incidents
        WHERE id='62cc056f-eade-4196-a292-a6deea69732f' AND status <> 'resolved' FOR UPDATE) unresolved;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'Verified 2026-10-15: the owner park 3d9c1ba1 ended with Dan''s resume b930a4a2 at 18:10:56; no hold remains and every live close is resumed (asserted). Watchdog close step fixed to ignore deleted tables. migration 20261015221949'
 WHERE id IN ('1af6c215-3001-4bc0-b96f-99377501c076', '95ae599f-f683-46fd-b60d-8b00be0309d7') AND resolved IS NOT TRUE;

DO $closed$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE id IN ('38fd1e96-4a87-4561-a7bc-31cd1a1c2772', '67c3926b-770e-40f4-bffb-c386ba1f56fe',
                           '3e617549-ced5-4f0a-abc8-f083a32ef60d', 'f5714015-aab9-41d7-a219-7be28110005f',
                           '1af6c215-3001-4bc0-b96f-99377501c076', '95ae599f-f683-46fd-b60d-8b00be0309d7')
                AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'an alert this file closes is still open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents
              WHERE id IN ('7e831a2c-911c-455d-b4f3-644eec1ce8e5', '56b271f4-7e9d-4849-a763-8f1e3f614f9d',
                           'ba5d559f-1b81-4737-8ba1-e94cd4773b7b', '62cc056f-eade-4196-a292-a6deea69732f')
                AND (status <> 'resolved' OR root_cause IS NULL)) THEN
    RAISE EXCEPTION 'an incident this file closes is still open or has no root cause';
  END IF;
END
$closed$;

COMMIT;
