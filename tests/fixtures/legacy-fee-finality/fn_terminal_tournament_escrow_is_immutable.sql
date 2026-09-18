CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'tournament escrow ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament escrow cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tournament escrow terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
