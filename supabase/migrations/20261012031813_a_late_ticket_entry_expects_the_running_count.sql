-- @live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = '5f8d1cd44ebfa063291401da00597e8a'
--
-- A LATE TICKET ENTRY EXPECTS THE RUNNING COUNT (2026-10-12).
--
-- Root cause of the 2026-10-11 17:50 to 18:53 UTC connection exhaustion.
-- 20260922141704 stopped fn_sync_tournament_current_players counting an
-- INSERT into a RUNNING field: the door that admits a late entrant publishes
-- the count itself. The wallet doors were moved to that rule with
-- v_expected_cached_players. The ticket door was not: its compare-and-set
-- still required current_players = v_players_before+1, a count only the
-- pre-start trigger produces. For a RUNNING event the trigger leaves the
-- count at v_players_before, so the UPDATE matched no row and the door
-- raised 'ticket admission tournament cache changed' on every late ticket
-- entry. Measured: 0 of 1,413 ticket admissions since the door was written
-- were late; every late attempt was refused.
--
-- On 2026-10-11 the horse late-registration pass offered Sunday 200 Deep
-- Stack (6561f9f4) to its satellite ticket holders. The refusal then carried
-- SQLSTATE 40001, which PostgREST 14.5 re-runs inside the request without
-- end: 22,401 refusals from 10 backends, each re-taking the event's
-- exclusive settlement lane, so every hand write on its tables raised
-- F06_RETRY_CANONICAL_LANE (also 40001, also re-run). 40 to 60 connections
-- spun until the :53 freeze made the door answer platform_frozen.
-- 20261011185301 changed both codes so neither is re-run any more; this
-- removes the refusal itself.
--
-- The change is one predicate: expect exactly the state the roster trigger
-- left, the same CASE the human and horse wallet doors hold. The written
-- count (v_players_before+1), the pools, the locks, the ledger legs, the
-- ticket, the entitlement and every other check are unchanged. Unknown
-- preimage refuses; an applied postimage is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $install$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure;
  v_pre constant text := 'b335c4664d2b029e920e998edd18666f';
  v_post constant text := '5f8d1cd44ebfa063291401da00597e8a';
  v_anchor constant text := $a$     -- The canonical roster trigger has already counted the row inserted
     -- above. Require that exact post-insert count instead of expecting the
     -- stale pre-insert cache and then reporting a false registration race.
     AND current_players IS NOT DISTINCT FROM v_players_before+1
$a$;
  v_new constant text := $b$     -- Before the start the canonical roster trigger has already counted
     -- the row inserted above. A RUNNING field is not counted on INSERT
     -- (20260922141704): this door publishes that count itself, as the
     -- wallet doors do. Expect exactly the state the trigger left.
     AND current_players IS NOT DISTINCT FROM CASE
       WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
       ELSE v_players_before
     END
$b$;
  d text; n text;
  owner_before oid; security_before boolean; config_before text[]; acl_before aclitem[];
BEGIN
  d := pg_get_functiondef(v_sig);
  IF md5(d) = v_post THEN
    RAISE NOTICE 'LATE_TICKET_ENTRY already applied';
    RETURN;
  END IF;
  IF md5(d) <> v_pre THEN
    RAISE EXCEPTION 'LATE_TICKET_ENTRY_PREIMAGE_CHANGED: %', md5(d);
  END IF;
  IF (length(d) - length(replace(d, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'LATE_TICKET_ENTRY_ANCHOR_NOT_UNIQUE';
  END IF;
  SELECT proowner, prosecdef, proconfig, proacl
    INTO owner_before, security_before, config_before, acl_before
    FROM pg_proc WHERE oid = v_sig;
  n := replace(d, v_anchor, v_new);
  EXECUTE n;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = v_sig
          AND proowner = owner_before AND prosecdef = security_before
          AND proconfig IS NOT DISTINCT FROM config_before
          AND proacl IS NOT DISTINCT FROM acl_before)
     OR md5(pg_get_functiondef(v_sig)) <> v_post THEN
    RAISE EXCEPTION 'LATE_TICKET_ENTRY_RESULT_CHANGED: %', md5(pg_get_functiondef(v_sig));
  END IF;
END $install$;
COMMIT;
