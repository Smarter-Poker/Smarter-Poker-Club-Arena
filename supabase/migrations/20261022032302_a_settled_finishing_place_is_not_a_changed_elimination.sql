-- A SETTLED FINISHING PLACE IS NOT A CHANGED ELIMINATION (2026-10-22).
--
-- Prime Time Free Buy (NLH) 2873feca, table 38 (3c76327d): six live players
-- with no dealer from 02:48 UTC. Every re-admission was refused
-- F06_MOVEMENT_ELIMINATION_CHANGED. The table's movement proof (02:43:48)
-- recorded a busted player's registration with position 307; the finish
-- pipeline (20261021234526 / 20261022013120: places are true from the first
-- bust, finishers are paid at the bust) later settled that place to 309.
--
-- An eliminated player's finishing place, prize and terminal close time are
-- the ranking the finish pipeline settles after the bust, not the roster the
-- proof protects. Who busted, when, in what sequence, with what chips, from
-- which seat are all still compared exactly. This is the same rule the
-- bounty fields already follow (20260928170557). Only the eliminated-player
-- comparison changes; living players are compared exactly as before.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure)
     IS DISTINCT FROM 'a0e369a33e735ba728b72228a3134b01' THEN
    RAISE EXCEPTION 'SETTLED_PLACE_PREIMAGE_CHANGED: f06_assert_movement changed since 2026-10-22 03:23 UTC; requalify';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 -- An add-on the player bought while the park waited (2026-10-02): its chips
 -- are the event's addon_chips, and its registration says add_on.
 addon numeric:=0; credited jsonb; strip text[]:='{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}';
BEGIN
 mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false);
 -- A never-dealt park's proof (f06_movement_never_dealt_prior) names no hand:
 -- its boundary holds while nothing of any hand exists on the table.
 IF a.proof->'first_hand'='true'::jsonb THEN
 IF a.proof->'atomic' IS DISTINCT FROM 'null'::jsonb OR a.proof->'history' IS DISTINCT FROM 'null'::jsonb
 OR a.proof->'permits' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT COALESCE(t.addon_chips,0) INTO addon FROM public.tournaments t WHERE t.id=a.tournament_id;
 addon:=COALESCE(addon,0);
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR ((winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric
 AND NOT (addon>0 AND r#>'{registration,add_on}'='false'::jsonb
 AND (winner->>'stack')::numeric=(r#>>'{seat,stack}')::numeric+addon
 AND EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=a.tournament_id AND p.user_id=(r#>>'{seat,user_id}')::uuid AND p.add_on IS TRUE)))
 OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 credited:=CASE WHEN addon>0 AND r#>'{registration,add_on}'='false'::jsonb AND actual#>'{registration,add_on}'='true'::jsonb
 THEN jsonb_set(jsonb_set(jsonb_set(actual,'{seat,stack}',to_jsonb((actual#>>'{seat,stack}')::numeric-addon)),
 '{registration,chips}',to_jsonb((actual#>>'{registration,chips}')::numeric-addon)),'{registration,add_on}','false'::jsonb) END;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)
 AND (credited IS NULL OR jsonb_set(credited,'{registration}',(credited->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value,position,prize,terminal_closed_at}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value,position,prize,terminal_closed_at}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $function$
;

REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE s text := (SELECT prosrc FROM pg_proc WHERE oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure);
BEGIN
  IF position('mystery_bounty_value,position,prize,terminal_closed_at}' in s) = 0
     OR position('F06_MOVEMENT_ROSTER_CHANGED' in s) = 0
     OR position('F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' in s) = 0 THEN
    RAISE EXCEPTION 'SETTLED_PLACE_RESULT_CHANGED';
  END IF;
END $post$;

COMMIT;
