-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Drill's own first run caught two bugs in the drill (working as intended):
-- text-vs-array append ambiguity, and the settlement check depending on a
-- pre-existing final row. Fixed via regex patch of the live definition.
DO $do$
DECLARE src text; new_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_alarm_drill';

  new_src := regexp_replace(src,
    'v_failing := v_failing \|\| ''([a-z_]+)'';',
    'v_failing := array_append(v_failing, ''\1'');', 'g');
  IF new_src = src THEN RAISE EXCEPTION 'append pattern not found'; END IF;
  src := new_src;

  new_src := replace(src,
    'UPDATE ca_settlements SET state = ''open''
     WHERE id = (SELECT id FROM ca_settlements WHERE state = ''final'' LIMIT 1);
    v_note := ''final settlement accepted a state change'';',
    'INSERT INTO ca_settlements (id, settlement_type, external_ref, state, totals)
    VALUES (gen_random_uuid(), ''union_rakeback_close'',
            ''alarm-drill:'' || clock_timestamp()::text, ''open'', ''{}''::jsonb);
    UPDATE ca_settlements SET state = ''final''
     WHERE external_ref LIKE ''alarm-drill:%'' AND state = ''open'';
    v_note := ''an illegal open to final jump was accepted'';');
  IF new_src = src THEN RAISE EXCEPTION 'settlement anchor not found'; END IF;
  src := new_src;

  new_src := replace(src, 'IF SQLERRM ILIKE ''%final%'' THEN v_ok := true;',
                          'IF SQLERRM ILIKE ''%invalid settlement transition%'' THEN v_ok := true;');
  IF new_src = src THEN RAISE EXCEPTION 'sqlerrm anchor not found'; END IF;
  EXECUTE new_src;
END $do$;;
