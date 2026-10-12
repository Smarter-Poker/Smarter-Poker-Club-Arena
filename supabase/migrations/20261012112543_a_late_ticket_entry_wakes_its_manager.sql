-- @live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = 'bf8a5f20ef63427093a662c62edc5d65'
--
-- A LATE TICKET ENTRY WAKES ITS MANAGER WITH A REASON THE DOOR KNOWS (2026-10-12).
--
-- The 2026-10-11 17:45 to 18:53 UTC pool exhaustion began at the late ticket
-- door. 20261011185301 stopped PostgREST re-running its refusal and
-- 20261012031813 removed the refusal (the RUNNING roster count). That let a
-- late ticket entry reach the last step of the door for the first time, and
-- the last step refuses too: the door wakes the tournament manager with
-- 'late_ticket_registration', a reason fn_emit_tournament_manager_wake does
-- not admit ('rebuy','reentry','addon','late_registration','deal_vote',
-- 'bounty_settled', also the tournament_manager_wakes reason check), so it
-- raises 'invalid tournament manager wake reason' and the whole admission
-- rolls back. Production 2026-10-12 05:08 to 05:28 UTC: 10 of 10 late ticket
-- entries to Sunday Funday Six-Card Closer (7e9996f6) ended there, and 7
-- tickets issued at 05:02 inside its late window were never used. Since the
-- reason was written (20260909165629) no late ticket entry has ever
-- succeeded; the count refusal hid this one.
--
-- The engine acts on 'late_registration' wakes (TournamentManagerEliminations);
-- every other late door emits exactly that. The change is that one literal.
-- Locks, ledger legs, seat, ticket, entitlement and every check are unchanged.
-- Unknown preimage refuses; an applied postimage is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $install$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure;
  v_pre constant text := '5f8d1cd44ebfa063291401da00597e8a';
  v_anchor constant text := $a$    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_ticket_registration');
$a$;
  v_new constant text := $b$    -- The wake reasons are a closed list (fn_emit_tournament_manager_wake
    -- and tournament_manager_wakes_reason_check); the engine acts on
    -- 'late_registration'. A reason outside it rolled back every late
    -- ticket entry (20261012).
    PERFORM public.fn_emit_tournament_manager_wake(
      p_tournament_id,'late_registration');
$b$;
  d text; n text; v_post text;
  owner_before oid; security_before boolean; config_before text[]; acl_before aclitem[];
BEGIN
  d := pg_get_functiondef(v_sig);
  IF position(v_new in d) > 0 AND position(v_anchor in d) = 0 THEN
    RAISE NOTICE 'LATE_TICKET_WAKE already applied';
    RETURN;
  END IF;
  IF md5(d) <> v_pre THEN
    RAISE EXCEPTION 'LATE_TICKET_WAKE_PREIMAGE_CHANGED: %', md5(d);
  END IF;
  IF (length(d) - length(replace(d, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_TICKET_WAKE_ANCHOR_NOT_UNIQUE';
  END IF;
  SELECT proowner, prosecdef, proconfig, proacl
    INTO owner_before, security_before, config_before, acl_before
    FROM pg_proc WHERE oid = v_sig;
  n := replace(d, v_anchor, v_new);
  EXECUTE n;
  v_post := md5(pg_get_functiondef(v_sig));
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_sig
          AND proowner = owner_before AND prosecdef = security_before
          AND proconfig IS NOT DISTINCT FROM config_before
          AND proacl IS NOT DISTINCT FROM acl_before)
     OR v_post <> md5(n)
     OR replace(pg_get_functiondef(v_sig), v_new, v_anchor) <> d THEN
    RAISE EXCEPTION 'LATE_TICKET_WAKE_RESULT_CHANGED: %', v_post;
  END IF;
END $install$;
DO $prove$
DECLARE d text; r record;
BEGIN
  d := pg_get_functiondef(
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure);
  -- Every literal reason any public function hands the wake door is one the
  -- door admits.
  FOR r IN
    SELECT p.proname, m[1] AS reason
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace,
           regexp_matches(p.prosrc,
             'fn_emit_tournament_manager_wake\(\s*[a-z_.]+\s*,\s*''([a-z_]+)''', 'g') m
     WHERE ns.nspname IN ('public','smarter_private')
       AND m[1] NOT IN ('rebuy','reentry','addon','late_registration','deal_vote','bounty_settled')
  LOOP
    RAISE EXCEPTION 'LATE_TICKET_WAKE_RESULT_CHANGED: % still wakes with %', r.proname, r.reason;
  END LOOP;
  IF position('''late_ticket_registration''' in d) > 0 THEN
    RAISE EXCEPTION 'LATE_TICKET_WAKE_RESULT_CHANGED: ticket door still names the unknown reason';
  END IF;
END $prove$;
COMMIT;
