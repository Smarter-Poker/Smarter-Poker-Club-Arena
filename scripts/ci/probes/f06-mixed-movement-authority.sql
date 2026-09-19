-- The original operation stays in its original generation. A separate admitted
-- receipt authorizes only its original movement under one real successor lease.
CREATE FUNCTION smarter_private.f06_mixed_movement_generation(p_break uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE o smarter_private.f06_operations; transfer smarter_private.f06_manager_custody_transfers;
 original jsonb; seat jsonb; registration jsonb; actual jsonb; winning jsonb; movement jsonb; g uuid;
 remaining integer:=0;
BEGIN
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.* INTO transfer FROM smarter_private.f06_manager_custody_transfers c
 JOIN smarter_private.f06_manager_custody_admissions a USING(transfer_id)
 WHERE c.tournament_id=o.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 g:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 PERFORM smarter_private.f06_mixed_current_admission(o.tournament_id,g,transfer.transfer_id);
 SELECT value INTO original FROM jsonb_array_elements(transfer.canonical_proof->'operations') WHERE value->>'break_id'=p_break::text;
 IF original IS NULL OR (original->>'tournament_id',original->>'source_table_id',original->>'lifecycle') IS DISTINCT FROM
 (o.tournament_id::text,o.source_table_id::text,o.lifecycle::text)
 OR original->>'state' NOT IN('park_requested','begun','close_confirmed')
 OR o.state NOT IN('park_requested','begun','close_confirmed')
 OR (original->'manifest'<>'null'::jsonb AND original->'manifest' IS DISTINCT FROM o.manifest)
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=o.source_table_id AND tournament_id=o.tournament_id AND f06_lifecycle=o.lifecycle)
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ORIGINAL_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=o.tournament_id AND state='reserved')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) WHERE h.tournament_id=o.tournament_id)
 THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;
 -- The complete captured source roster remains exact until canonical winning
 -- receipts consume each original occupancy. Destination stacks are not proof.
 FOR seat IN SELECT value FROM jsonb_array_elements(transfer.canonical_proof->'seats')
 WHERE value->>'table_id'=o.source_table_id::text AND value->'left_at'='null'::jsonb LOOP
 SELECT value INTO registration FROM jsonb_array_elements(transfer.canonical_proof->'registrations') WHERE value->>'user_id'=seat->>'user_id';
 IF registration IS NULL OR (seat->>'stack')::numeric<=0 OR registration->>'status'<>'playing'
 OR (registration->>'chips')::numeric IS DISTINCT FROM (seat->>'stack')::numeric THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_UNPROVEN'; END IF;
 SELECT a.receipt,to_jsonb(r) INTO winning,movement FROM smarter_private.f06_attempts a
 JOIN public.tournament_seat_move_receipts r USING(request_id) WHERE a.break_id=p_break AND a.user_id=(seat->>'user_id')::uuid AND a.state='winner';
 IF FOUND THEN
 IF winning-ARRAY['source_occupancy_id','source_lifecycle','break_id'] IS DISTINCT FROM movement
 OR (winning->>'source_seat_id',winning->>'source_occupancy_id',winning->>'source_table_id',winning->>'source_lifecycle',winning->>'break_id') IS DISTINCT FROM
 (seat->>'id',seat->>'occupancy_id',o.source_table_id::text,o.lifecycle::text,p_break::text)
 OR (winning->>'stack')::numeric IS DISTINCT FROM (seat->>'stack')::numeric
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WINNER_CHANGED'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT to_jsonb(s) INTO actual FROM public.table_seats s WHERE s.id=(seat->>'id')::uuid;
 IF actual IS DISTINCT FROM seat THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_ROSTER_CHANGED'; END IF;
 SELECT to_jsonb(p) INTO actual FROM public.tournament_players p WHERE p.tournament_id=o.tournament_id AND p.user_id=(seat->>'user_id')::uuid;
 IF actual IS DISTINCT FROM registration THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_REGISTRATION_CHANGED'; END IF;
 END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=o.source_table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=o.tournament_id AND table_id=o.source_table_id AND status IN('playing','registered'))<>remaining
 THEN RAISE EXCEPTION 'F06_MIXED_MOVEMENT_WHOLE_ROSTER_REQUIRED'; END IF;
 RETURN g;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_movement_generation(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A custody-only admission cannot create an ordinary dealer permit. The fence
-- ends at the immutable completion, never at a missing process-local object.
CREATE FUNCTION smarter_private.f06_mixed_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF NEW.state='reserved' AND EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
 WHERE c.tournament_id=NEW.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id))
 THEN RAISE EXCEPTION 'F06_MIXED_CUSTODY_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_mixed_preparation_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_mixed_preparation_custody BEFORE INSERT OR UPDATE ON smarter_private.f06_hand_permits
FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_mixed_preparation_guard();
