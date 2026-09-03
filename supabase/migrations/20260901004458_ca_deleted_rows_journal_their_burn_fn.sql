-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Part 1 of the delete-journal hardening: the trigger function alone (no
-- table locks). Deleting a row that still holds value journals a burn to
-- chip_retirement; triggers attach per-table in the follow-up migrations.
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; oldv numeric;
  v_club uuid; v_union uuid; v_entity uuid; actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN OLD;
  END IF;

  o := to_jsonb(OLD);
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (o->>'id')::uuid
    WHEN o ? 'club_id' THEN NULLIF(o->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (o->>'id')::uuid
    WHEN o ? 'union_id' THEN NULLIF(o->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME IN ('agents','club_members') THEN NULLIF(o->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(o->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := round(COALESCE(NULLIF(o->>col,'')::numeric, 0), 2);
    CONTINUE WHEN oldv = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance)
      VALUES (actor,
        acct, v_entity, TG_TABLE_NAME || '.' || col,
        'chip_retirement', NULL, NULL,
        abs(oldv), CASE WHEN oldv > 0 THEN 'burn' ELSE 'correction' END,
        v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' balance ' || oldv::text
          || ' retired on row delete',
        oldv, 0);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      BEGIN
        INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
        VALUES (v_club, v_entity, -oldv, v_st,
                'fn_ca_autoledger_delete ' || TG_TABLE_NAME || '.' || col || ': ' || v_msg);
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END LOOP;

  RETURN OLD;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_autoledger_delete() FROM PUBLIC, anon, authenticated;;
