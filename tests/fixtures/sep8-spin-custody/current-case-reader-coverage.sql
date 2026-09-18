BEGIN;
SELECT sep8_spin_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres',
 'Reader coverage is isolated native data only');
SET LOCAL session_replication_role=replica;
DO $coverage$
DECLARE event uuid:='199a71a9-f364-4e90-a3ba-3cdcfb7755bc';
 local_table uuid; other_table uuid; other_event uuid; boundary bigint;
 template public.hand_history%ROWTYPE; control public.hand_history%ROWTYPE;
 original jsonb; expected jsonb; actual jsonb; mode text; n integer:=0;
 included uuid[]:=ARRAY[]::uuid[];
BEGIN
 SELECT table_id INTO local_table FROM sep8_spin_fixture.cases WHERE tournament_id=event;
 SELECT tournament_id,table_id INTO other_event,other_table FROM sep8_spin_fixture.cases WHERE tournament_id<>event ORDER BY tournament_id LIMIT 1;
 SELECT max(hand_number) INTO boundary FROM public.tournament_knockout_candidates WHERE tournament_id=event;
 SELECT * INTO STRICT template FROM public.hand_history WHERE tournament_id=event AND hand_number=boundary;
 original:=smarter_private.spin_original_current_case(event)->'history';
 PERFORM sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(original) x WHERE (x->>'hand_number')::bigint=boundary),
  'Reader includes the exact original hand boundary');
 FOREACH mode IN ARRAY ARRAY['both','table_null','table_conflicting','tournament_only','unrelated','below_boundary'] LOOP
  n:=n+1;
  SELECT * INTO control FROM jsonb_populate_record(template,jsonb_build_object(
   'id',md5('spin-reader-control:'||mode)::uuid,
   'hand_number',CASE WHEN mode='below_boundary' THEN boundary-1 ELSE boundary+100+n END,
   'table_id',CASE WHEN mode IN('tournament_only','unrelated') THEN other_table ELSE local_table END,
   'tournament_id',CASE WHEN mode='table_null' THEN NULL WHEN mode IN('table_conflicting','unrelated') THEN other_event ELSE event END));
  INSERT INTO public.hand_history SELECT control.*;
  IF n<=4 THEN included:=array_append(included,control.id); END IF;
 END LOOP;
 SELECT jsonb_agg(v ORDER BY v->>'id') INTO expected FROM (
  SELECT value v FROM jsonb_array_elements(original)
  UNION ALL SELECT to_jsonb(h) FROM public.hand_history h WHERE h.id=ANY(included)
 ) q;
 actual:=smarter_private.spin_original_current_case(event)->'history';
 PERFORM sep8_spin_fixture.assert(actual=expected,
  'Reader preserves exact full rows once across direct/table/NULL/conflicting links and stable id order');
 PERFORM sep8_spin_fixture.assert(jsonb_array_length(actual)=jsonb_array_length(original)+4,
  'Reader excludes unrelated and earlier hands without duplicate overlap');
 DELETE FROM public.tournament_knockout_candidates WHERE tournament_id=event;
 PERFORM sep8_spin_fixture.assert(smarter_private.spin_original_current_case(event)->'history'='[]'::jsonb,
  'Reader preserves empty history when original candidate boundary is NULL');
 PERFORM sep8_spin_fixture.assert(smarter_private.spin_original_current_case(NULL) IS NULL,
  'Reader preserves NULL tournament behavior');
END $coverage$;
ROLLBACK;
